import { Observable } from 'rxjs';
import {
  PartProcessor,
  type StreamingSignatureState,
  StreamingState,
} from '../../../antigravity/ClaudeStreamingMapper';
import { decodeInternalSseData } from '../../../antigravity/internal-sse';
import { classifyStreamError } from '../../../antigravity/stream-error-utils';
import { InvalidFunctionCallArgumentsError } from '../../../antigravity/function-call-args';
import { ToolCallIdConflictError } from '../../../antigravity/tool-call-id-integrity';
import type { GeminiPart, UsageMetadata } from '../../../antigravity/types';
import { attachUpstreamBackpressure } from '../stream-backpressure';
import type { ProxyStreamRuntime } from './proxy-stream-runtime';

export interface AnthropicInternalStreamRuntime extends ProxyStreamRuntime {
  isGeminiPart(value: unknown): value is GeminiPart;
}

export interface AnthropicInternalStreamOptions {
  fallbackModel: string;
  signatureState: StreamingSignatureState;
  stopSequences?: readonly string[];
  webSearch?: boolean;
}

/**
 * Translates the `v1internal` SSE stream into Anthropic message events.
 *
 * A parse failure is not fatal on its own — the mapper decides whether the
 * frame can be skipped or whether the stream has to end with an error event —
 * but a tool-call identity conflict always ends it, because replaying a
 * conflicting id would corrupt the caller's tool state.
 */
export function processAnthropicInternalStream(
  runtime: AnthropicInternalStreamRuntime,
  upstreamStream: NodeJS.ReadableStream,
  options: AnthropicInternalStreamOptions,
): Observable<string> {
  const { fallbackModel, signatureState, stopSequences } = options;
  const webSearch = options.webSearch ?? false;

  return attachUpstreamBackpressure(
    new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';

      const state = new StreamingState(signatureState, fallbackModel, {
        webSearch,
        stopSequences,
      });
      const processor = new PartProcessor(state);

      let lastFinishReason: string | undefined;
      let lastUsageMetadata: UsageMetadata | undefined;

      let receivedResponse = false;
      let cleanedUp = false;
      const idleTimer = runtime.createStreamIdleTimer(upstreamStream, 'Claude-SSE', () => {
        state
          .emitTerminalError('timeout_error', 'The upstream stopped producing streaming data.')
          .forEach((chunk) => subscriber.next(chunk));
        cleanup(false);
        subscriber.complete();
      });

      const cleanup = (destroy: boolean): void => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        idleTimer.clear();
        upstreamStream.removeListener('data', onData);
        upstreamStream.removeListener('end', onEnd);
        upstreamStream.removeListener('error', onError);
        if (destroy) {
          idleTimer.dispose();
        }
      };

      const onData = (chunk: Buffer): void => {
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);

          const decoded = decodeInternalSseData(dataStr);
          if (decoded.kind === 'ignored') {
            continue;
          }
          if (decoded.kind === 'invalid') {
            runtime.logger.error('Stream parse error: invalid v1internal SSE payload');
            const errorChunks = state.handleParseError(dataStr);
            errorChunks.forEach((c) => subscriber.next(c));
            if (errorChunks.some((event) => event.startsWith('event: error'))) {
              cleanup(true);
              subscriber.complete();
              return;
            }
            continue;
          }

          try {
            const response = decoded.response;
            receivedResponse = true;

            const startMsg = state.emitMessageStart(response);
            if (startMsg) subscriber.next(startMsg);

            const candidate = response.candidates?.[0];
            const parts = candidate?.content?.parts;

            if (candidate?.finishReason) {
              lastFinishReason = candidate.finishReason;
            }
            if (response.usageMetadata) {
              lastUsageMetadata = response.usageMetadata;
            }
            state.captureGrounding(candidate?.groundingMetadata);

            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (runtime.isGeminiPart(part)) {
                  const chunks = processor.process(part);
                  chunks.forEach((c) => subscriber.next(c));
                }
              }
            }

            // Reset error state on successful parse
            state.resetErrorState();
          } catch (e) {
            if (
              e instanceof ToolCallIdConflictError ||
              e instanceof InvalidFunctionCallArgumentsError
            ) {
              state
                .emitTerminalError('api_error', e.message)
                .forEach((chunk) => subscriber.next(chunk));
              cleanup(true);
              subscriber.complete();
              return;
            }
            runtime.logger.error('Stream parse error', e);
            const errorChunks = state.handleParseError(dataStr);
            errorChunks.forEach((c) => subscriber.next(c));
            if (errorChunks.some((event) => event.startsWith('event: error'))) {
              cleanup(true);
              subscriber.complete();
              return;
            }
          }
        }
      };

      const onEnd = (): void => {
        if (!receivedResponse) {
          runtime.logger.warn('Empty response stream detected');
          cleanup(false);
          subscriber.error(new Error('Empty response stream'));
          return;
        }

        const finishChunks = state.emitFinish(lastFinishReason, lastUsageMetadata);
        finishChunks.forEach((c) => subscriber.next(c));
        cleanup(false);
        subscriber.complete();
      };

      const onError = (err: unknown): void => {
        const cleanError = err instanceof Error ? err : new Error(String(err));
        const { type } = classifyStreamError(cleanError);

        runtime.logger.error(`Stream error: ${type} - ${cleanError.message}`);
        state
          .emitTerminalError(
            type === 'timeout_error' ? 'timeout_error' : 'api_error',
            cleanError.message,
          )
          .forEach((chunk) => subscriber.next(chunk));
        cleanup(false);
        subscriber.complete();
      };

      upstreamStream.on('data', onData);
      upstreamStream.on('end', onEnd);
      upstreamStream.on('error', onError);
      idleTimer.reset();

      return () => {
        cleanup(true);
      };
    }),
    upstreamStream,
  );
}
