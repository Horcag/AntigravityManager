import { Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { decodeInternalSseData } from '../../../antigravity/internal-sse';
import { sanitizeGeminiResponse } from './gemini-wire';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request-exception';
import { attachUpstreamBackpressure } from '../../common/stream-backpressure';
import {
  parseUpstreamResponseMetadata,
  type UpstreamResponseMetadata,
} from '../../common/upstream-response-metadata';

const logger = new Logger('GeminiSseDecoder');

export interface GeminiSseDiagnostics {
  /** Frames whose payload could not be decoded and were skipped. */
  skippedFrames: number;
  /**
   * Envelope fields from the last frame that carried them. The response headers are long gone by
   * the time a stream ends, so this is the only place a streamed `traceId` can surface.
   */
  upstreamMetadata?: UpstreamResponseMetadata;
}

export interface GeminiSseObservableOptions {
  /** Invoked once when the stream finishes, successfully or not. */
  onDiagnostics?: (diagnostics: GeminiSseDiagnostics) => void;
}

/**
 * Creates an Observable that incrementally decodes an upstream UTF-8 byte stream into bare Gemini SSE events (`data: <json>\n\n`).
 *
 * Handles:
 * - Incremental UTF-8 decoding across chunk boundaries
 * - SSE event framing (accumulates until `\n\n` or `\r\n\r\n`)
 * - Multiple events per chunk and final event without trailing blank line on stream end
 * - Joining multiline `data:` lines within a single event block with `\n`
 * - Ignoring comment lines starting with `:` and irrelevant SSE fields (`event:`, `id:`, etc.)
 * - Unwrapping `v1internal` wrapped `{ response: ... }` payloads and bare payloads via `decodeInternalSseData`
 * - Sanitizing response fields (`sanitizeGeminiResponse`)
 * - Skipping (and counting) malformed frames rather than aborting: the SSE handshake has already
 *   been answered by this point, so failing here costs the whole response with no chance to retry
 * - Empty-stream error if no valid response was emitted before completion
 * - Cleaning up and calling `.destroy()` on the upstream stream upon unsubscribe or idle timeout
 */
export function createGeminiSseObservable(
  upstreamStream: NodeJS.ReadableStream,
  idleTimeoutMs = 300000,
  options: GeminiSseObservableOptions = {},
): Observable<string> {
  return attachUpstreamBackpressure(
    new Observable<string>((subscriber) => {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let buffer = '';
      let hasEmittedData = false;
      let streamEnded = false;
      let skippedFrames = 0;
      let diagnosticsReported = false;
      let upstreamMetadata: UpstreamResponseMetadata | undefined;
      let idleTimer: NodeJS.Timeout | null = null;

      const reportDiagnostics = () => {
        if (diagnosticsReported) {
          return;
        }
        diagnosticsReported = true;
        if (skippedFrames > 0) {
          logger.warn(`Skipped ${skippedFrames} malformed Gemini SSE frame(s) on this stream.`);
        }
        options.onDiagnostics?.({ skippedFrames, upstreamMetadata });
      };

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const destroyUpstream = () => {
        clearIdleTimer();
        if (typeof (upstreamStream as any).destroy === 'function') {
          (upstreamStream as any).destroy();
        }
      };

      const resetIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
          destroyUpstream();
          if (!subscriber.closed) {
            subscriber.error(
              new UpstreamRequestError({ message: 'Gemini SSE stream idle timeout', status: 504 }),
            );
          }
        }, idleTimeoutMs);
      };

      resetIdleTimer();

      const processEventBlock = (block: string): void => {
        const lines = block.split(/\r?\n/);
        const dataLines: string[] = [];

        for (const line of lines) {
          const trimmed = line.trimStart();
          if (trimmed.startsWith(':')) {
            // Comment line, ignore
            continue;
          }
          if (trimmed.startsWith('data:')) {
            const content = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
            dataLines.push(content);
          }
        }

        if (dataLines.length === 0) {
          return;
        }

        const combinedData = dataLines.join('\n');
        const decoded = decodeInternalSseData(combinedData);

        if (decoded.kind === 'ignored') {
          return;
        }

        if (decoded.kind === 'invalid') {
          // Deliberately logged without the payload, which may carry user content.
          skippedFrames += 1;
          return;
        }

        if (decoded.kind === 'response') {
          hasEmittedData = true;
          // Credits and traceId arrive per frame; the last frame that carries them wins, matching
          // how gemini-cli treats `remainingCredits` as the current balance.
          upstreamMetadata = parseUpstreamResponseMetadata(decoded.envelope) ?? upstreamMetadata;
          const sanitized = sanitizeGeminiResponse(decoded.response);
          subscriber.next(`data: ${JSON.stringify(sanitized)}\n\n`);
        }
      };

      const onData = (chunk: Buffer | string) => {
        resetIdleTimer();
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        buffer += text;

        // Event boundaries are marked by double line breaks (\n\n or \r\n\r\n or \r\n\n or \n\r\n)
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          if (block.trim().length > 0) {
            processEventBlock(block);
          }
        }
      };

      const onError = (err: unknown) => {
        destroyUpstream();
        reportDiagnostics();
        if (!subscriber.closed) {
          subscriber.error(err);
        }
      };

      const onEnd = () => {
        streamEnded = true;
        clearIdleTimer();

        // Flush decoder
        buffer += decoder.decode();

        // Process any remaining text buffer (final event without trailing blank line)
        if (buffer.trim().length > 0) {
          const remainingBlocks = buffer.split(/\r?\n\r?\n/);
          for (const block of remainingBlocks) {
            if (block.trim().length > 0) {
              processEventBlock(block);
            }
          }
        }

        reportDiagnostics();

        if (!hasEmittedData) {
          if (!subscriber.closed) {
            subscriber.error(
              new Error(
                skippedFrames > 0
                  ? `Empty response stream (${skippedFrames} malformed frame(s) skipped)`
                  : 'Empty response stream',
              ),
            );
          }
          return;
        }

        if (!subscriber.closed) {
          subscriber.complete();
        }
      };

      const onClose = () => {
        clearIdleTimer();
        if (!streamEnded && !subscriber.closed) {
          subscriber.error(
            new UpstreamRequestError({
              message: 'Gemini SSE stream closed before completion',
              status: 502,
            }),
          );
        }
      };

      upstreamStream.on('data', onData);
      upstreamStream.on('error', onError);
      upstreamStream.on('end', onEnd);
      upstreamStream.on('close', onClose);

      return () => {
        reportDiagnostics();
        upstreamStream.removeListener('data', onData);
        upstreamStream.removeListener('error', onError);
        upstreamStream.removeListener('end', onEnd);
        upstreamStream.removeListener('close', onClose);
        destroyUpstream();
      };
    }),
    upstreamStream,
  );
}
