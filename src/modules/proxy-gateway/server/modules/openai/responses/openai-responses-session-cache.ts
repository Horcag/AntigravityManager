import { isString } from 'lodash-es';
import { Observable } from 'rxjs';
import { inheritUpstreamBackpressure } from '../../../common/stream-backpressure';
import { asString, toRecord } from '../../../common/utils/json-record';
import type {
  OpenAIResponsesSession,
  OpenAIResponsesSessionStoreLike,
} from './openai-responses-session.store';

/**
 * Mirrors a streamed Responses answer into the session store as it passes.
 *
 * A streamed chain has no buffered response to save afterwards, so the terminal
 * `response.completed` / `response.incomplete` event is the only place the
 * finished output exists.
 */
export function cacheResponsesStream(
  stream: Observable<unknown>,
  session: OpenAIResponsesSession,
  sessions: OpenAIResponsesSessionStoreLike,
): Observable<unknown> {
  return inheritUpstreamBackpressure(
    stream,
    new Observable<unknown>((subscriber) => {
      const subscription = stream.subscribe({
        next: (event) => {
          saveResponsesSession(extractCompletedResponsesEvent(event), session, sessions);
          subscriber.next(event);
        },
        error: (error: unknown) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });

      return () => subscription.unsubscribe();
    }),
  );
}

function extractCompletedResponsesEvent(event: unknown): unknown | null {
  if (!isString(event)) {
    return null;
  }

  const dataLine = event.split(/\r?\n/).find((line) => line.startsWith('data:'));
  if (!dataLine) {
    return null;
  }

  try {
    const parsed = toRecord(JSON.parse(dataLine.slice('data:'.length).trimStart()));
    return parsed?.type === 'response.completed' || parsed?.type === 'response.incomplete'
      ? (parsed.response ?? null)
      : null;
  } catch {
    return null;
  }
}

export function saveResponsesSession(
  response: unknown,
  session: OpenAIResponsesSession,
  sessions: OpenAIResponsesSessionStoreLike,
): void {
  if (session.store === false) {
    return;
  }
  const responseRecord = toRecord(response);
  const responseId = asString(responseRecord?.id);
  const output = responseRecord?.output;
  if (!responseId || !Array.isArray(output)) {
    return;
  }

  sessions.save(responseId, {
    ...session,
    inputItems: [...session.inputItems, ...output],
    response: responseRecord ?? undefined,
  });
}
