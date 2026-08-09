import { isString } from 'lodash-es';
import { Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import type { StreamingSignatureState } from '../../../antigravity/ClaudeStreamingMapper';
import { OpenAIResponsesStreamingMapper } from '../../../antigravity/OpenAIResponsesStreamingMapper';
import { toOpenAIResponsesUsage } from '../../../antigravity/OpenAIUsageMapper';
import { toOpenAIUsageFromGeminiUsageMetadata } from '../usage/openai-usage';
import { decodeInternalSseData } from '../../../antigravity/internal-sse';
import { InvalidFunctionCallArgumentsError } from '../../../antigravity/function-call-args';
import { ToolCallIdConflictError } from '../../../antigravity/tool-call-id-integrity';
import type { GroundingMetadata } from '../../../antigravity/types';
import {
  toGeminiUsageMetadata,
  toResponsesGroundingMetadata,
  toResponsesStreamPart,
} from '../../modules/openai/responses/openai-responses-stream-values';
import { attachUpstreamBackpressure } from '../stream-backpressure';
import { toRecord } from '../utils/json-record';
import type { ProxyStreamRuntime } from './proxy-stream-runtime';

export interface OpenAIResponsesStreamOptions {
  model: string;
  clientToolNames?: ReadonlySet<string>;
  signatureState?: StreamingSignatureState;
  webSearch?: boolean;
}

/**
 * Translates the `v1internal` SSE stream into OpenAI Responses events.
 *
 * The Responses protocol requires a `response.created` / `response.in_progress`
 * pair before anything else and a terminal event in every outcome, so both the
 * success and failure paths route through `ensureStarted`. A 15s comment ping
 * keeps intermediaries from closing a stream that is only thinking.
 */
export function processResponsesStreamResponse(
  runtime: ProxyStreamRuntime,
  upstreamStream: NodeJS.ReadableStream,
  options: OpenAIResponsesStreamOptions,
): Observable<string> {
  const { clientToolNames, model, signatureState } = options;
  const webSearch = options.webSearch ?? false;

  return attachUpstreamBackpressure(
    new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let settled = false;
      const mapper = new OpenAIResponsesStreamingMapper({
        clientToolNames,
        model,
        responseId: `resp_${uuidv4()}`,
        signatureState,
        webSearch,
      });
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let idleTimer: { clear(): void; dispose(): void; reset(): void };
      let started = false;

      const ensureStarted = (): void => {
        if (started) {
          return;
        }
        started = true;
        subscriber.next(mapper.createResponseCreatedEvent());
        subscriber.next(mapper.createResponseInProgressEvent());
      };

      const clearHeartbeat = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      const complete = (finishReason?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        ensureStarted();
        idleTimer.clear();
        clearHeartbeat();
        for (const event of mapper.complete(finishReason)) {
          subscriber.next(event);
        }
        subscriber.complete();
      };

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        ensureStarted();
        idleTimer.clear();
        clearHeartbeat();
        for (const event of mapper.fail(error)) {
          subscriber.next(event);
        }
        subscriber.complete();
      };

      const processLine = (line: string): void => {
        if (settled) {
          return;
        }
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) {
          return;
        }

        const dataString = trimmed.slice(6);
        try {
          const decoded = decodeInternalSseData(dataString);
          if (decoded.kind !== 'response') {
            return;
          }

          const responsePayload = decoded.response;
          if (isString(responsePayload.modelVersion) && responsePayload.modelVersion.trim()) {
            mapper.setModel(responsePayload.modelVersion);
          }
          ensureStarted();
          const usageMetadata = toGeminiUsageMetadata(responsePayload.usageMetadata);
          if (usageMetadata) {
            mapper.setUsage(
              toOpenAIResponsesUsage(toOpenAIUsageFromGeminiUsageMetadata(usageMetadata)),
            );
          }
          const candidates = responsePayload.candidates;
          if (!Array.isArray(candidates)) {
            return;
          }

          const candidate = toRecord(candidates[0]);
          const content = toRecord(candidate?.content);
          const parts = content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              const normalizedPart = toResponsesStreamPart(part);
              if (!normalizedPart) {
                continue;
              }
              for (const event of mapper.processPart(normalizedPart)) {
                subscriber.next(event);
              }
            }
          }

          if (webSearch) {
            mapper.captureWebSearchGrounding(
              candidate?.groundingMetadata as GroundingMetadata | undefined,
            );
          } else {
            const grounding = toResponsesGroundingMetadata(candidate?.groundingMetadata);
            if (grounding) {
              for (const event of mapper.processGrounding(grounding)) {
                subscriber.next(event);
              }
            }
          }

          if (isString(candidate?.finishReason) && candidate.finishReason.length > 0) {
            complete(candidate.finishReason);
          }
        } catch (error) {
          if (
            error instanceof ToolCallIdConflictError ||
            error instanceof InvalidFunctionCallArgumentsError
          ) {
            (upstreamStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
            fail(error);
          }
          // Ignore malformed upstream keepalive/data lines that are not contract failures.
        }
      };

      heartbeatTimer = setInterval(() => {
        if (!settled) {
          subscriber.next(': ping\n\n');
        }
      }, 15_000);
      idleTimer = runtime.createStreamIdleTimer(upstreamStream, 'OpenAI-Responses-SSE', () =>
        fail(new Error('OpenAI Responses upstream stream idle timeout')),
      );
      idleTimer.reset();

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
        }
      });

      upstreamStream.on('end', () => {
        if (settled) {
          return;
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          processLine(buffer);
        }
        if (!settled) {
          fail(new Error('upstream stream ended without a finish reason'));
        }
      });

      upstreamStream.on('error', (error: unknown) => {
        const cleanError =
          error instanceof Error ? new Error(error.message) : new Error(String(error));
        runtime.logger.error(`OpenAI Responses stream error: ${cleanError.message}`);
        fail(cleanError);
      });

      return () => {
        clearHeartbeat();
        idleTimer.dispose();
      };
    }),
    upstreamStream,
  );
}
