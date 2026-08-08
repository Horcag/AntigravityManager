import { Observable } from 'rxjs';

/**
 * The `/v1/responses` half of the `json_object` fence unwrap.
 *
 * The proof obligation and the decision logic live in
 * `../chat/openai-json-object-fence.ts` and are not restated here: this module
 * only knows how to run *a* gate over the Responses event protocol. The gate is
 * injected rather than imported so the dependency stays one-directional
 * (chat -> responses); the caller is the single dispatcher, so there is still
 * exactly one implementation of "one block, nothing outside it, body parses".
 *
 * Two properties matter more than anything else here:
 *
 * - `sequence_number` must be monotonic and gapless across the whole response,
 *   because client SDKs validate it and throw on a hole. Withholding a delta
 *   removes an event and flushing adds one, so the mapper's numbering cannot
 *   survive; every event this transform emits is renumbered from 0 instead.
 * - Everything else about the protocol is unchanged — same event types in the
 *   same order, `response.output_text.delta` still carrying deltas,
 *   `response.output_text.done` still carrying the full text, and the terminal
 *   `response.completed` payload consistent with what was streamed. The `done`,
 *   `content_part.done`, `output_item.done` and terminal payloads are rewritten
 *   to the unwrapped text so a client that reads the final object and a client
 *   that concatenates deltas agree.
 *
 * Frames the transform does not recognise — the `: ping\n\n` heartbeat and
 * anything that is not a sequenced Responses event — are forwarded verbatim.
 */

/** The part of {@link JsonObjectFenceGate} this transform depends on. */
export interface ResponsesTextFenceGate {
  flush(): string;
  push(delta: string): string;
}

interface ResponsesEventPayload {
  sequence_number: number;
  type: string;
  [field: string]: unknown;
}

interface GatedTextItem {
  contentIndex: number;
  emitted: string;
  gate: ResponsesTextFenceGate;
  itemId: string;
  outputIndex: number;
}

const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete']);

export function unwrapJsonObjectFenceInResponsesStream(
  source: Observable<string>,
  createGate: () => ResponsesTextFenceGate,
): Observable<string> {
  return new Observable<string>((subscriber) => {
    /** Keyed by output text block, i.e. one message item's one content index. */
    const gated = new Map<string, GatedTextItem>();
    /** Final text per item id, recorded only when the unwrap actually fired. */
    const rewritten = new Map<string, string>();
    let sequenceNumber = 0;

    const emit = (payload: ResponsesEventPayload): void => {
      const sequenced = { ...payload, sequence_number: sequenceNumber };
      sequenceNumber += 1;
      subscriber.next(`event: ${payload.type}\ndata: ${JSON.stringify(sequenced)}\n\n`);
    };

    const emitDelta = (item: GatedTextItem, delta: string): void => {
      item.emitted += delta;
      emit({
        content_index: item.contentIndex,
        delta,
        item_id: item.itemId,
        output_index: item.outputIndex,
        type: 'response.output_text.delta',
        sequence_number: 0,
      });
    };

    /** Rewrites a message item's `output_text` content, or returns null. */
    const rewriteItem = (item: unknown): Record<string, unknown> | null => {
      const record = asRecord(item);
      const text = typeof record?.id === 'string' ? rewritten.get(record.id) : undefined;
      if (!record || text === undefined || !Array.isArray(record.content)) {
        return null;
      }
      return {
        ...record,
        content: record.content.map((part) => {
          const contentPart = asRecord(part);
          return contentPart?.type === 'output_text' ? { ...contentPart, text } : part;
        }),
      };
    };

    const subscription = source.subscribe({
      next: (frame) => {
        const payload = parseResponsesEvent(frame);
        if (!payload) {
          subscriber.next(frame);
          return;
        }

        switch (payload.type) {
          case 'response.output_text.delta': {
            const key = textBlockKey(payload);
            if (!key) {
              emit(payload);
              return;
            }
            let item = gated.get(key);
            if (!item) {
              item = {
                contentIndex: toIndex(payload.content_index),
                emitted: '',
                gate: createGate(),
                itemId: String(payload.item_id),
                outputIndex: toIndex(payload.output_index),
              };
              gated.set(key, item);
            }
            const emittable = item.gate.push(
              typeof payload.delta === 'string' ? payload.delta : '',
            );
            if (!emittable) {
              return;
            }
            item.emitted += emittable;
            emit({ ...payload, delta: emittable });
            return;
          }

          case 'response.output_text.done': {
            const key = textBlockKey(payload);
            const item = key ? gated.get(key) : undefined;
            if (!key || !item) {
              emit(payload);
              return;
            }
            gated.delete(key);
            const pending = item.gate.flush();
            if (pending) {
              emitDelta(item, pending);
            }
            if (item.emitted !== payload.text) {
              rewritten.set(item.itemId, item.emitted);
            }
            emit({ ...payload, text: item.emitted });
            return;
          }

          case 'response.content_part.done': {
            const text =
              typeof payload.item_id === 'string' ? rewritten.get(payload.item_id) : undefined;
            const part = asRecord(payload.part);
            if (text === undefined || !part) {
              emit(payload);
              return;
            }
            emit({ ...payload, part: { ...part, text } });
            return;
          }

          case 'response.output_item.done': {
            const item = rewriteItem(payload.item);
            emit(item ? { ...payload, item } : payload);
            return;
          }

          default: {
            if (!TERMINAL_EVENTS.has(payload.type) || rewritten.size === 0) {
              emit(payload);
              return;
            }
            const response = asRecord(payload.response);
            if (!response || !Array.isArray(response.output)) {
              emit(payload);
              return;
            }
            emit({
              ...payload,
              response: {
                ...response,
                output: response.output.map((item) => rewriteItem(item) ?? item),
              },
            });
          }
        }
      },
      error: (error: unknown) => subscriber.error(error),
      complete: () => {
        // A stream that ended without its `output_text.done` still owes the
        // client whatever the gate withheld.
        for (const item of gated.values()) {
          const pending = item.gate.flush();
          if (pending) {
            emitDelta(item, pending);
          }
        }
        gated.clear();
        subscriber.complete();
      },
    });

    return () => subscription.unsubscribe();
  });
}

function parseResponsesEvent(frame: string): ResponsesEventPayload | null {
  if (!frame.startsWith('event: ')) {
    return null;
  }
  const dataAt = frame.indexOf('\ndata: ');
  if (dataAt < 0) {
    return null;
  }

  const body = frame.slice(dataAt + '\ndata: '.length).trim();
  if (!body) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const payload = asRecord(parsed);
  if (!payload || typeof payload.type !== 'string' || typeof payload.sequence_number !== 'number') {
    return null;
  }
  return payload as ResponsesEventPayload;
}

function textBlockKey(payload: ResponsesEventPayload): string | null {
  return typeof payload.item_id === 'string'
    ? `${toIndex(payload.content_index)}:${payload.item_id}`
    : null;
}

function toIndex(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
