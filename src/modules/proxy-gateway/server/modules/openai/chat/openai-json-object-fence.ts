import { Observable, isObservable } from 'rxjs';

import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
} from '../../../common/interfaces/request-interfaces';
import {
  attachModelRouteMetadata,
  getModelRouteMetadata,
} from '../../../common/model-route-metadata';
import { inheritUpstreamBackpressure } from '../../../common/stream-backpressure';
import { unwrapJsonObjectFenceInResponsesStream } from '../responses/openai-responses-json-object-fence';

/**
 * OpenAI `response_format: {"type":"json_object"}` promises valid JSON of *any*
 * shape. The upstream transport has no equivalent and only two states:
 * `responseMimeType: "application/json"` alone still answers inside a markdown
 * fence, and the only way to get an unfenced answer — `responseSchema` —
 * constrains the answer to a declared shape and returns an empty object when
 * the schema is permissive. `responseJsonSchema` is ignored by the transport.
 * So the fence is removed here, on the way out, under a proof obligation that
 * makes the rewrite unable to damage a real answer. All three must hold:
 *
 * 1. the request asked for `response_format: {"type":"json_object"}`;
 * 2. the whole assistant content is exactly one fenced block, tagged `json` or
 *    untagged, with nothing outside it;
 * 3. the block body parses as JSON.
 *
 * Condition 3 is what separates this from a scrubber: a caller that asked for
 * `json_object` cannot legitimately want a fenced string, because a fenced
 * string is not JSON; and when the body does not parse nothing is touched, so
 * no real answer can be corrupted. Requests that did not ask for `json_object`
 * never reach this code.
 */

/**
 * One fenced block and nothing else. Anchored at both ends, so prose on either
 * side of the fence fails the match and the content is returned untouched.
 * The backreference keeps the closing run at least as long as the opening one.
 */
const FENCED_JSON_BLOCK = /^\s*(`{3,})[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?\1\s*$/i;

/** A complete fence opener at the start of the accumulated stream content. */
const FENCE_OPENER = /^\s*`{3,}[ \t]*(?:json)?[ \t]*\r?\n/i;

/**
 * Text that is still a strict prefix of a possible fence opener. While this
 * matches, the streaming gate cannot yet tell a fenced answer from a plain one,
 * so it withholds; the moment it stops matching the answer is definitively not
 * fenced and the gate stops buffering for the rest of the stream.
 */
const PARTIAL_FENCE_OPENER = /^\s*(?:`{1,2}|`{3,}[ \t]*(?:j|js|jso|json)?[ \t]*\r?)?$/i;

/** Wire shapes of an OpenAI streaming chunk, narrowed at the SSE boundary. */
interface ChatChunkDelta {
  role?: string;
  content?: string | null;
  /** Tool calls, reasoning content and annotations pass through unread. */
  [field: string]: unknown;
}

interface ChatChunkChoice {
  index?: number;
  delta?: ChatChunkDelta;
  finish_reason?: string | null;
  [field: string]: unknown;
}

interface ChatChunkPayload {
  object?: string;
  choices?: ChatChunkChoice[];
  [field: string]: unknown;
}

export function requestsJsonObjectOutput(request: OpenAIChatRequest): boolean {
  return request.response_format?.type === 'json_object';
}

/**
 * Returns the JSON body of a lone markdown fence, or `null` when the content is
 * not exactly one fenced block whose body parses. `null` always means "change
 * nothing".
 */
export function unwrapJsonObjectFence(content: string): string | null {
  const match = FENCED_JSON_BLOCK.exec(content);
  if (!match) {
    return null;
  }

  const body = match[2];
  if (!body.trim()) {
    return null;
  }
  try {
    JSON.parse(body);
  } catch {
    return null;
  }

  return body;
}

/**
 * Per-choice fence gate for the streaming path.
 *
 * The fence opens in one delta and closes in another, and conditions 2 and 3
 * ("one block, nothing outside it, body parses") are only decidable once the
 * content is complete. The gate therefore withholds content only while the text
 * so far could still be a fence opener:
 *
 * - not an opener any more -> flush and pass every later delta straight through,
 *   which is what happens to ordinary answers after the first delta or two;
 * - opener confirmed -> buffer to the end, then emit either the unwrapped body
 *   or, if the proof obligation fails, the original text verbatim.
 *
 * Either way the concatenated content a client receives is the unwrapped body
 * or byte-identical to what upstream sent; only its delivery is batched.
 */
export class JsonObjectFenceGate {
  private buffer = '';
  private state: 'deciding' | 'buffering' | 'passthrough' = 'deciding';

  /** Returns the text emittable now; an empty string means "withheld". */
  push(delta: string): string {
    if (this.state === 'passthrough') {
      return delta;
    }

    this.buffer += delta;
    if (this.state === 'buffering') {
      return '';
    }
    if (FENCE_OPENER.test(this.buffer)) {
      this.state = 'buffering';
      return '';
    }
    if (PARTIAL_FENCE_OPENER.test(this.buffer)) {
      return '';
    }
    return this.releaseBuffer();
  }

  /** Returns everything still withheld, unwrapped when the fence proves out. */
  flush(): string {
    if (this.state !== 'buffering') {
      return this.releaseBuffer();
    }

    const fenced = this.releaseBuffer();
    return unwrapJsonObjectFence(fenced) ?? fenced;
  }

  private releaseBuffer(): string {
    const pending = this.buffer;
    this.buffer = '';
    this.state = 'passthrough';
    return pending;
  }
}

/**
 * Rewrites assistant content in place. The response object carries the model
 * route metadata as a symbol property, so it is mutated rather than rebuilt;
 * a fresh object would drop the `x-antigravity-*` response headers.
 */
export function unwrapJsonObjectFenceInResponse(response: OpenAIChatResponse): OpenAIChatResponse {
  for (const choice of response.choices) {
    const content = choice.message.content;
    if (typeof content !== 'string') {
      continue;
    }
    const unwrapped = unwrapJsonObjectFence(content);
    if (unwrapped !== null) {
      choice.message.content = unwrapped;
    }
  }

  return response;
}

/**
 * Rewrites `chat.completion.chunk` content deltas on an SSE stream. Frames this
 * transform does not recognise — heartbeats, `[DONE]`, the trace-id frame, and
 * the whole `/v1/responses` event protocol — are forwarded verbatim.
 */
export function unwrapJsonObjectFenceInChatStream(source: Observable<string>): Observable<string> {
  return new Observable<string>((subscriber) => {
    const gates = new Map<number, JsonObjectFenceGate>();
    let lastEnvelope: ChatChunkPayload | null = null;

    const gateFor = (index: number): JsonObjectFenceGate => {
      const existing = gates.get(index);
      if (existing) {
        return existing;
      }
      const created = new JsonObjectFenceGate();
      gates.set(index, created);
      return created;
    };

    /** Emits whatever the gates still hold, used when no finish chunk arrived. */
    const flushRemaining = (): void => {
      if (!lastEnvelope) {
        return;
      }
      for (const [index, gate] of gates) {
        const pending = gate.flush();
        if (pending) {
          subscriber.next(buildContentFrame(lastEnvelope, index, pending));
        }
      }
      gates.clear();
    };

    const subscription = source.subscribe({
      next: (frame) => {
        const payload = parseChatChunkFrame(frame);
        if (!payload) {
          if (frame.startsWith('data: [DONE]')) {
            flushRemaining();
          }
          subscriber.next(frame);
          return;
        }

        lastEnvelope = payload;
        const rewrittenChoices: ChatChunkChoice[] = [];
        const flushedFrames: string[] = [];
        const choices = payload.choices ?? [];

        for (const choice of choices) {
          const index = typeof choice.index === 'number' ? choice.index : 0;
          const gate = gateFor(index);
          const delta = { ...choice.delta };
          const content = delta.content;

          // The role-opener chunk carries an empty content field; it contributes
          // nothing to the answer and must not be swallowed by the gate.
          if (typeof content === 'string' && content.length > 0 && delta.role === undefined) {
            const emittable = gate.push(content);
            if (emittable) {
              delta.content = emittable;
            } else {
              delete delta.content;
            }
          }

          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            const pending = gate.flush();
            if (pending) {
              flushedFrames.push(buildContentFrame(payload, index, pending));
            }
          }

          const carriesNothing =
            Object.keys(delta).length === 0 &&
            (choice.finish_reason === null || choice.finish_reason === undefined);
          if (!carriesNothing) {
            rewrittenChoices.push({ ...choice, delta });
          }
        }

        for (const flushed of flushedFrames) {
          subscriber.next(flushed);
        }
        if (choices.length > 0 && rewrittenChoices.length === 0) {
          return;
        }
        subscriber.next(serializeFrame({ ...payload, choices: rewrittenChoices }));
      },
      error: (error: unknown) => subscriber.error(error),
      complete: () => {
        flushRemaining();
        subscriber.complete();
      },
    });

    return () => subscription.unsubscribe();
  });
}

/**
 * Single entry point used by the proxy service. Returns `result` untouched
 * unless the request asked for `json_object`.
 */
export function applyOpenAIJsonObjectFence(
  request: OpenAIChatRequest,
  result: OpenAIChatResponse | Observable<string>,
  streamProtocol: 'chat-completions' | 'responses',
): OpenAIChatResponse | Observable<string> {
  if (!requestsJsonObjectOutput(request)) {
    return result;
  }

  if (!isObservable(result)) {
    return unwrapJsonObjectFenceInResponse(result);
  }

  // The source observable carries backpressure control and route metadata as
  // symbol properties; a derived observable has to inherit both or the client
  // loses flow control and the `x-antigravity-*` headers.
  const rewritten =
    streamProtocol === 'responses'
      ? unwrapJsonObjectFenceInResponsesStream(result, () => new JsonObjectFenceGate())
      : unwrapJsonObjectFenceInChatStream(result);
  const unwrapped = inheritUpstreamBackpressure(result, rewritten);
  const metadata = getModelRouteMetadata(result);
  return metadata ? attachModelRouteMetadata(unwrapped, metadata) : unwrapped;
}

function parseChatChunkFrame(frame: string): ChatChunkPayload | null {
  if (!frame.startsWith('data: ')) {
    return null;
  }

  const body = frame.slice('data: '.length).trim();
  if (!body || body === '[DONE]') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const payload = parsed as ChatChunkPayload;
  if (payload.object !== 'chat.completion.chunk' || !Array.isArray(payload.choices)) {
    return null;
  }

  return payload;
}

/**
 * Builds a content chunk from a chunk that has already crossed the wire, so the
 * synthesized frame keeps the stream id, model, service tier and the `usage`
 * field the `stream_options.include_usage` contract requires.
 */
function buildContentFrame(envelope: ChatChunkPayload, index: number, content: string): string {
  return serializeFrame({
    ...envelope,
    choices: [{ index, delta: { content }, finish_reason: null }],
  });
}

function serializeFrame(payload: ChatChunkPayload): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
