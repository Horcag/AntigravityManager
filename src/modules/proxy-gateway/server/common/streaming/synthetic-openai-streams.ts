import { isString } from 'lodash-es';
import { Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { OpenAIResponsesStreamingMapper } from '../../../antigravity/OpenAIResponsesStreamingMapper';
import { toOpenAIResponsesId } from '../../../antigravity/OpenAIResponsesResponseMapper';
import { toOpenAIResponsesUsage } from '../../../antigravity/OpenAIUsageMapper';
import { parseOpenAIFunctionArguments } from '../../modules/openai/chat/openai-claude-conversion';
import type { OpenAIChatResponse } from '../interfaces/request-interfaces';
import type { CloudCodeMetaRuntime } from './proxy-stream-runtime';
import type { OpenAIStreamContract } from './openai-chat-internal-stream';

const SYNTHETIC_CONTENT_CHUNK_SIZE = 80;

/**
 * Replays an already-buffered answer as a chat-completion stream.
 *
 * Used when the streaming call failed and the request was retried without
 * streaming: the caller asked for a stream and still gets one, chunked so the
 * client's incremental rendering behaves the same way.
 */
export function createSyntheticOpenAIStream(
  runtime: CloudCodeMetaRuntime,
  response: OpenAIChatResponse,
  streamContract: OpenAIStreamContract = { expectedChoices: 1, includeUsage: false },
): Observable<string> {
  return new Observable<string>((subscriber) => {
    const streamId = response.id || `chatcmpl-${uuidv4()}`;
    const created = response.created || Math.floor(Date.now() / 1000);
    const model = response.model;
    const chunkSize = SYNTHETIC_CONTENT_CHUNK_SIZE;

    if (runtime.shouldEmitCloudCodeMeta()) {
      subscriber.next(runtime.createCloudCodeMetaChunk(runtime.createCloudCodeTraceId()));
    }

    const pushChunk = (payload: Record<string, unknown>): void => {
      const withTier = streamContract.serviceTier
        ? { ...payload, service_tier: streamContract.serviceTier }
        : payload;
      const chunk = streamContract.includeUsage ? { ...withTier, usage: null } : withTier;
      subscriber.next(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    for (const choice of response.choices ?? []) {
      const choiceIndex = choice.index;
      const finishReason = choice.finish_reason ?? 'stop';
      const message = choice.message;
      pushChunk({
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: choiceIndex,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          },
        ],
      });

      if (message?.reasoning_content) {
        pushChunk({
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: choiceIndex,
              delta: { content: null, reasoning_content: message.reasoning_content },
              finish_reason: null,
            },
          ],
        });
      }

      const content = isString(message?.content) ? message.content : '';
      for (let index = 0; index < content.length; index += chunkSize) {
        pushChunk({
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: choiceIndex,
              delta: { content: content.slice(index, index + chunkSize) },
              finish_reason: null,
            },
          ],
        });
      }

      for (const [toolIndex, toolCall] of (message?.tool_calls ?? []).entries()) {
        pushChunk({
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: choiceIndex,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: toolCall.id,
                    type: toolCall.type,
                    function: toolCall.function,
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      }

      pushChunk({
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: choiceIndex,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      });
    }

    if (streamContract.includeUsage) {
      subscriber.next(
        `data: ${JSON.stringify({
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: response.usage,
          ...(streamContract.serviceTier ? { service_tier: streamContract.serviceTier } : {}),
        })}\n\n`,
      );
    }

    subscriber.next('data: [DONE]\n\n');
    subscriber.complete();
  });
}

/** {@link createSyntheticOpenAIStream} for the Responses protocol. */
export function createSyntheticResponsesStream(
  response: OpenAIChatResponse,
  clientToolNames?: ReadonlySet<string>,
): Observable<string> {
  return new Observable<string>((subscriber) => {
    const mapper = new OpenAIResponsesStreamingMapper({
      clientToolNames,
      model: response.model,
      responseId: toOpenAIResponsesId(response.id),
    });
    const choice = response.choices?.[0];
    const content =
      choice?.message && isString(choice.message.content) ? choice.message.content : undefined;
    const reasoningContent =
      choice?.message && isString(choice.message.reasoning_content)
        ? choice.message.reasoning_content
        : undefined;

    subscriber.next(mapper.createResponseCreatedEvent());
    subscriber.next(mapper.createResponseInProgressEvent());
    if (response.usage) {
      mapper.setUsage(toOpenAIResponsesUsage(response.usage));
    }
    if (reasoningContent) {
      for (const event of mapper.processPart({ text: reasoningContent, thought: true })) {
        subscriber.next(event);
      }
    }
    if (content) {
      for (const event of mapper.processPart({ text: content })) {
        subscriber.next(event);
      }
    }

    for (const toolCall of choice?.message?.tool_calls ?? []) {
      const functionName =
        toolCall.function?.name ??
        (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
      if (!functionName) {
        continue;
      }
      for (const event of mapper.processPart({
        functionCall: {
          args:
            toolCall.operation ??
            parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'),
          id: toolCall.call_id || toolCall.id,
          name: functionName,
        },
      })) {
        subscriber.next(event);
      }
    }

    for (const event of mapper.complete(choice?.finish_reason)) {
      subscriber.next(event);
    }
    subscriber.complete();
  });
}
