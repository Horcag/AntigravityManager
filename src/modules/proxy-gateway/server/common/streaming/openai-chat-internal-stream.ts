import { isNumber, isString } from 'lodash-es';
import { Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import type { StreamingSignatureState } from '../../../antigravity/ClaudeStreamingMapper';
import { optimizeApplyPatch } from '../../../antigravity/ApplyPatchPreflight';
import {
  extractCustomToolInput,
  isCustomToolCall,
  toCustomToolArguments,
} from '../../../antigravity/CustomToolCall';
import { toOpenAIUsageFromGeminiUsageMetadata } from '../usage/openai-usage';
import { resolveShellToolName } from '../../../antigravity/ShellToolName';
import { splitNamespaceToolName } from '../../../antigravity/ToolNamespace';
import { decodeInternalSseData } from '../../../antigravity/internal-sse';
import {
  InvalidFunctionCallArgumentsError,
  normalizeFunctionCallArgs,
} from '../../../antigravity/function-call-args';
import { decodeSignature } from '../../../antigravity/signature-utils';
import {
  ToolCallIdConflictError,
  ToolCallIdIntegrityTracker,
} from '../../../antigravity/tool-call-id-integrity';
import { OpenAIChatWebSearchStream } from '../../modules/openai/chat/openai-chat-web-search-stream';
import { mapGeminiFinishReasonToOpenAIFinishReason } from '../../modules/openai/chat/openai-chat-response-conversion';
import { toGeminiUsageMetadata } from '../../modules/openai/responses/openai-responses-stream-values';
import { attachUpstreamBackpressure } from '../stream-backpressure';
import { createUpstreamStreamTrace } from './upstream-stream-trace';
import { toRecord } from '../utils/json-record';
import type { OpenAIUsage } from '../interfaces/request-interfaces';
import type { CloudCodeMetaRuntime, ProxyStreamRuntime } from './proxy-stream-runtime';

export interface OpenAIStreamContract {
  expectedChoices: number;
  includeUsage: boolean;
  serviceTier?: string;
  /** Emit search citations rather than the trailing grounding markdown. */
  webSearch?: boolean;
}

export type OpenAIChatStreamRuntime = ProxyStreamRuntime & CloudCodeMetaRuntime;

export interface OpenAIChatStreamOptions {
  model: string;
  clientToolNames?: ReadonlySet<string>;
  signatureState?: StreamingSignatureState;
  streamContract?: OpenAIStreamContract;
}

/**
 * Translates the `v1internal` SSE stream into chat-completion chunks.
 *
 * 1. Each upstream candidate maps to one OpenAI choice index, which is why the
 *    emitted role, tool-call index and finish state are all tracked per index.
 * 2. A tool call is emitted once; a replayed id updates only the stored thought
 *    signature, because re-emitting it would duplicate the caller's tool call.
 * 3. The stream is finished when every expected choice has reported a finish
 *    reason — and, when the caller asked for usage, once usage has arrived.
 */
export function processStreamResponse(
  runtime: OpenAIChatStreamRuntime,
  upstreamStream: NodeJS.ReadableStream,
  options: OpenAIChatStreamOptions,
): Observable<string> {
  const { clientToolNames, model, signatureState } = options;
  const streamContract = options.streamContract ?? { expectedChoices: 1, includeUsage: false };

  return attachUpstreamBackpressure(
    new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let hasEmittedChunk = false;
      let settled = false;
      let servedModel = model;
      let lastUsage: OpenAIUsage | undefined;
      const observedChoiceIndexes = new Set<number>();
      const roleEmittedIndexes = new Set<number>();
      const finishedChoiceIndexes = new Set<number>();
      const toolCallIndexes = new Map<number, number>();
      const emittedToolCallCounts = new Map<number, number>();
      const latestResponseSignatures = new Map<number, string>();
      const webSearchStream = new OpenAIChatWebSearchStream(streamContract.webSearch === true);
      const toolCallIntegrityByChoice = new Map<number, ToolCallIdIntegrityTracker>();
      const trace = createUpstreamStreamTrace('openai-chat', upstreamStream);
      let heartbeatTimer: NodeJS.Timeout | undefined;

      const streamId = `chatcmpl-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);
      if (runtime.shouldEmitCloudCodeMeta()) {
        subscriber.next(runtime.createCloudCodeMetaChunk(runtime.createCloudCodeTraceId()));
      }

      const pushChunk = (payload: Record<string, unknown>): void => {
        if (settled) {
          return;
        }
        hasEmittedChunk = true;
        subscriber.next(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const withOptionalUsage = (payload: Record<string, unknown>): Record<string, unknown> => {
        const withTier = streamContract.serviceTier
          ? { ...payload, service_tier: streamContract.serviceTier }
          : payload;
        return streamContract.includeUsage ? { ...withTier, usage: null } : withTier;
      };

      const emitRoleIfNeeded = (choiceIndex: number): void => {
        observedChoiceIndexes.add(choiceIndex);
        if (roleEmittedIndexes.has(choiceIndex)) {
          return;
        }
        roleEmittedIndexes.add(choiceIndex);
        pushChunk(
          withOptionalUsage({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model: servedModel,
            choices: [
              {
                index: choiceIndex,
                delta: { role: 'assistant', content: '' },
                finish_reason: null,
              },
            ],
          }),
        );
      };

      const requiredChoiceCount = (): number =>
        Math.max(streamContract.expectedChoices, observedChoiceIndexes.size);

      const clearHeartbeat = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      const finalizeSuccess = (): void => {
        if (settled) {
          return;
        }
        idleTimer.clear();
        clearHeartbeat();
        trace?.finish('completed');
        if (streamContract.includeUsage) {
          pushChunk({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model: servedModel,
            choices: [],
            usage: lastUsage ?? null,
            ...(streamContract.serviceTier ? { service_tier: streamContract.serviceTier } : {}),
          });
        }
        subscriber.next('data: [DONE]\n\n');
        settled = true;
        subscriber.complete();
      };

      const failStream = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        idleTimer.clear();
        clearHeartbeat();
        trace?.finish('failed');
        subscriber.error(error);
      };

      const idleTimer = runtime.createStreamIdleTimer(upstreamStream, 'OpenAI-SSE', () => {
        failStream(new Error('OpenAI-compatible upstream stream idle timeout'));
      });

      idleTimer.reset();
      heartbeatTimer = setInterval(() => {
        if (!settled) {
          subscriber.next(': ping\n\n');
        }
      }, 15_000);

      const processLine = (line: string): void => {
        if (settled) {
          return;
        }
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) {
          return;
        }

        try {
          const decoded = decodeInternalSseData(trimmed.slice(6));
          trace?.recordFrame(trimmed, decoded.kind === 'response' ? decoded.response : undefined);
          if (decoded.kind !== 'response') {
            return;
          }

          const responsePayload = decoded.response;
          if (isString(responsePayload.modelVersion) && responsePayload.modelVersion.trim()) {
            servedModel = responsePayload.modelVersion.trim();
          }
          const usageMetadata = toGeminiUsageMetadata(responsePayload.usageMetadata);
          if (usageMetadata) {
            lastUsage = toOpenAIUsageFromGeminiUsageMetadata(usageMetadata);
          }

          const candidates = Array.isArray(responsePayload.candidates)
            ? responsePayload.candidates
            : [];
          for (const [fallbackCandidateIndex, candidateValue] of candidates.entries()) {
            const candidate = toRecord(candidateValue);
            if (!candidate) {
              continue;
            }
            const candidateIndex = isNumber(candidate.index)
              ? candidate.index
              : fallbackCandidateIndex;
            emitRoleIfNeeded(candidateIndex);

            webSearchStream.captureGrounding(candidateIndex, candidate.groundingMetadata);

            const content = toRecord(candidate.content);
            const parts = Array.isArray(content?.parts) ? content.parts : [];
            let reasoningContent = '';
            let responseContent = '';

            for (const partValue of parts) {
              const part = toRecord(partValue);
              if (!part) {
                continue;
              }

              if (isString(part.text)) {
                const cleanText = part.text
                  .replaceAll('<think>\n', '')
                  .replaceAll('<think>', '')
                  .replaceAll('\n</think>', '')
                  .replaceAll('</think>', '');
                if (part.thought === true) {
                  reasoningContent += cleanText;
                } else {
                  responseContent += cleanText;
                }
              }

              const rawSignature = isString(part.thoughtSignature)
                ? part.thoughtSignature
                : isString(part.thought_signature)
                  ? part.thought_signature
                  : undefined;
              const signature = decodeSignature(rawSignature);
              if (signature) {
                latestResponseSignatures.set(candidateIndex, signature);
              }

              const functionCall = toRecord(part.functionCall);
              if (functionCall && isString(functionCall.name)) {
                const rawArguments = normalizeFunctionCallArgs(functionCall);
                const explicitToolCallId = isString(functionCall.id) ? functionCall.id : undefined;
                const integrityTracker =
                  toolCallIntegrityByChoice.get(candidateIndex) ?? new ToolCallIdIntegrityTracker();
                toolCallIntegrityByChoice.set(candidateIndex, integrityTracker);
                const integrity = integrityTracker.record(
                  explicitToolCallId,
                  functionCall.name,
                  rawArguments,
                );
                if (integrity === 'replay') {
                  const replaySignature = signature ?? latestResponseSignatures.get(candidateIndex);
                  if (replaySignature && signatureState && explicitToolCallId) {
                    signatureState.store.store(
                      {
                        accountId: signatureState.accountId,
                        model: signatureState.model,
                        toolCallId: explicitToolCallId,
                      },
                      replaySignature,
                    );
                  }
                  continue;
                }

                const splitName = splitNamespaceToolName(functionCall.name);
                const functionName = clientToolNames
                  ? resolveShellToolName(splitName.name, clientToolNames)
                  : splitName.name;
                const functionArguments = isCustomToolCall(functionName)
                  ? toCustomToolArguments(
                      functionName,
                      optimizeApplyPatch(extractCustomToolInput(functionName, rawArguments)).input,
                    )
                  : rawArguments;
                const clientToolCallId = explicitToolCallId ?? `${functionName}-${uuidv4()}`;
                const capturedSignature = signature ?? latestResponseSignatures.get(candidateIndex);
                if (capturedSignature && signatureState) {
                  signatureState.store.store(
                    {
                      accountId: signatureState.accountId,
                      model: signatureState.model,
                      toolCallId: clientToolCallId,
                    },
                    capturedSignature,
                  );
                }
                const toolCallIndex = toolCallIndexes.get(candidateIndex) ?? 0;
                pushChunk(
                  withOptionalUsage({
                    id: streamId,
                    object: 'chat.completion.chunk',
                    created,
                    model: servedModel,
                    choices: [
                      {
                        index: candidateIndex,
                        delta: {
                          tool_calls: [
                            {
                              index: toolCallIndex,
                              id: clientToolCallId,
                              type: 'function',
                              function: {
                                name: functionName,
                                arguments: JSON.stringify(functionArguments),
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  }),
                );
                toolCallIndexes.set(candidateIndex, toolCallIndex + 1);
                emittedToolCallCounts.set(
                  candidateIndex,
                  (emittedToolCallCounts.get(candidateIndex) ?? 0) + 1,
                );
              }

              const inlineData = toRecord(part.inlineData);
              if (inlineData) {
                const mimeType = isString(inlineData.mimeType) ? inlineData.mimeType : 'image/jpeg';
                const data = isString(inlineData.data) ? inlineData.data : '';
                responseContent += `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`;
              }
            }

            if (reasoningContent) {
              pushChunk(
                withOptionalUsage({
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model: servedModel,
                  choices: [
                    {
                      index: candidateIndex,
                      delta: { content: null, reasoning_content: reasoningContent },
                      finish_reason: null,
                    },
                  ],
                }),
              );
            }

            if (responseContent) {
              webSearchStream.appendText(candidateIndex, responseContent);
              pushChunk(
                withOptionalUsage({
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model: servedModel,
                  choices: [
                    {
                      index: candidateIndex,
                      delta: { content: responseContent },
                      finish_reason: null,
                    },
                  ],
                }),
              );
            }

            if (isString(candidate.finishReason) && !finishedChoiceIndexes.has(candidateIndex)) {
              const annotations = webSearchStream.buildAnnotations(candidateIndex);
              if (annotations.length > 0) {
                pushChunk(
                  withOptionalUsage({
                    id: streamId,
                    object: 'chat.completion.chunk',
                    created,
                    model: servedModel,
                    choices: [
                      {
                        index: candidateIndex,
                        delta: { annotations },
                        finish_reason: null,
                      },
                    ],
                  }),
                );
              }
              pushChunk(
                withOptionalUsage({
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model: servedModel,
                  choices: [
                    {
                      index: candidateIndex,
                      delta: {},
                      finish_reason:
                        (emittedToolCallCounts.get(candidateIndex) ?? 0) > 0
                          ? 'tool_calls'
                          : mapGeminiFinishReasonToOpenAIFinishReason(candidate.finishReason),
                    },
                  ],
                }),
              );
              finishedChoiceIndexes.add(candidateIndex);
            }
          }

          if (
            finishedChoiceIndexes.size >= requiredChoiceCount() &&
            (!streamContract.includeUsage || lastUsage !== undefined)
          ) {
            finalizeSuccess();
          }
        } catch (error) {
          if (
            error instanceof ToolCallIdConflictError ||
            error instanceof InvalidFunctionCallArgumentsError
          ) {
            failStream(error);
          }
        }
      };

      upstreamStream.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          processLine(line);
          if (settled) {
            return;
          }
        }
      });

      upstreamStream.on('end', () => {
        if (settled) {
          return;
        }
        idleTimer.clear();
        buffer += decoder.decode();
        if (buffer.trim()) {
          processLine(buffer);
        }
        if (settled) {
          return;
        }
        if (finishedChoiceIndexes.size >= requiredChoiceCount()) {
          finalizeSuccess();
          return;
        }
        const message = hasEmittedChunk
          ? `OpenAI-compatible upstream stream ended before ${requiredChoiceCount()} choice(s) finished`
          : 'Empty OpenAI-compatible upstream response stream';
        failStream(new Error(message));
      });

      upstreamStream.on('error', (err: unknown) => {
        const cleanError = err instanceof Error ? new Error(err.message) : new Error(String(err));
        runtime.logger.error(`OpenAI-compatible stream error: ${cleanError.message}`);
        failStream(cleanError);
      });

      return () => {
        clearHeartbeat();
        idleTimer.dispose();
        trace?.finish('unsubscribed');
      };
    }),
    upstreamStream,
  );
}
