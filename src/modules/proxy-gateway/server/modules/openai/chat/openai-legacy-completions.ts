import { isString } from 'lodash-es';
import { map, type Observable } from 'rxjs';
import { inheritUpstreamBackpressure } from '../../../common/stream-backpressure';
import { asString, toRecord } from '../../../common/utils/json-record';
import type { OpenAIChatResponse } from '../../../common/interfaces/request-interfaces';

/**
 * `/v1/completions` is served by rendering a chat completion in the legacy
 * text-completion shape, so the two endpoints cannot drift apart.
 */
export function toLegacyTextCompletionsResponse(
  response: OpenAIChatResponse,
): Record<string, unknown> {
  return {
    id: toLegacyCompletionId(response.id),
    object: 'text_completion',
    created: response.created,
    model: response.model,
    choices: (response.choices ?? []).map((choice) => ({
      text: isString(choice.message?.content) ? choice.message.content : '',
      index: choice.index,
      logprobs: choice.logprobs ?? null,
      finish_reason: choice.finish_reason ?? null,
    })),
    usage: response.usage,
  };
}

export function toLegacyTextCompletionsStream(stream: Observable<unknown>): Observable<string> {
  return inheritUpstreamBackpressure(
    stream,
    stream.pipe(map((chunk) => toLegacyTextCompletionsSseChunk(chunk))),
  );
}

function toLegacyTextCompletionsSseChunk(chunk: unknown): string {
  if (!isString(chunk)) {
    return String(chunk ?? '');
  }

  const events = chunk.split('\n\n');
  const converted: string[] = [];
  for (const event of events) {
    if (!event) {
      continue;
    }
    const dataLine = event.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine || dataLine === 'data: [DONE]') {
      converted.push(`${event}\n\n`);
      continue;
    }

    try {
      const payload = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
      if (payload.object !== 'chat.completion.chunk' || !Array.isArray(payload.choices)) {
        converted.push(`${event}\n\n`);
        continue;
      }

      const choices = payload.choices.map((choiceValue) => {
        const choice = toRecord(choiceValue) ?? {};
        const delta = toRecord(choice.delta) ?? {};
        return {
          text: isString(delta.content) ? delta.content : '',
          index: typeof choice.index === 'number' ? choice.index : 0,
          logprobs: choice.logprobs ?? null,
          finish_reason: choice.finish_reason ?? null,
        };
      });
      const legacyPayload = {
        ...payload,
        id: toLegacyCompletionId(asString(payload.id) ?? ''),
        object: 'text_completion',
        choices,
      };
      converted.push(`data: ${JSON.stringify(legacyPayload)}\n\n`);
    } catch {
      converted.push(`${event}\n\n`);
    }
  }
  return converted.join('');
}

function toLegacyCompletionId(id: string): string {
  if (id.startsWith('chatcmpl-')) {
    return `cmpl-${id.slice('chatcmpl-'.length)}`;
  }
  return id.startsWith('cmpl-') ? id : `cmpl-${id}`;
}
