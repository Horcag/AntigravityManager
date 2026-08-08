import { HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { isFunction, isObjectLike, isString } from 'lodash-es';
import type { Observable } from 'rxjs';
import { resolveAnthropicError, resolveErrorHttpStatus } from './proxy-error-responses';
import { pauseObservableUpstream, resumeObservableUpstream } from './stream-backpressure';
import {
  classifyUpstreamParameterRejection,
  resolveOpenAIErrorType,
} from './upstream-error-taxonomy';

export function applyResponseHeaders(res: FastifyReply, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.header(name, value);
  }
}

export function isObservableLike(value: unknown): value is Observable<unknown> {
  return isObjectLike(value) && isFunction((value as { subscribe?: unknown }).subscribe);
}

/**
 * Streams an observable to the client as `text/event-stream`.
 *
 * Writes through `res.raw` so the socket's own backpressure is respected: a
 * failed `write` pauses the upstream observable until `drain`, instead of
 * buffering an unbounded stream in memory. Falls back to `res.send` when the
 * reply has no raw socket, which is what the unit tests' reply mocks provide.
 */
export function writeSseResponse(
  res: FastifyReply,
  stream: Observable<unknown>,
  protocol: 'anthropic' | 'openai' = 'openai',
  responseHeaders: Record<string, string> = {},
): void {
  if (!res.raw || !isFunction(res.raw.writeHead) || !isFunction(res.raw.write)) {
    res.header('Content-Type', 'text/event-stream');
    res.header('Cache-Control', 'no-cache');
    res.header('Connection', 'keep-alive');
    for (const [name, value] of Object.entries(responseHeaders)) {
      res.header(name, value);
    }
    res.send(stream);
    return;
  }

  if (isFunction((res as { hijack?: () => void }).hijack)) {
    (res as { hijack: () => void }).hijack();
  }

  res.raw.writeHead(HttpStatus.OK, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...responseHeaders,
  });

  let waitingForDrain = false;
  let subscription: { unsubscribe(): void } | undefined;
  const clearDrainListener = (): void => {
    if (!waitingForDrain) {
      return;
    }
    waitingForDrain = false;
    res.raw.removeListener('drain', onDrain);
  };
  const onDrain = (): void => {
    waitingForDrain = false;
    resumeObservableUpstream(stream);
  };
  const onClose = (): void => {
    clearDrainListener();
    subscription?.unsubscribe();
  };
  const cleanupResponseListeners = (): void => {
    clearDrainListener();
    res.raw.removeListener('close', onClose);
  };

  res.raw.on('close', onClose);
  subscription = stream.subscribe({
    next: (chunk) => {
      if (res.raw.writableEnded) {
        return;
      }
      const payload = isString(chunk) ? chunk : String(chunk ?? '');
      if (!res.raw.write(payload) && !waitingForDrain) {
        waitingForDrain = true;
        pauseObservableUpstream(stream);
        res.raw.once('drain', onDrain);
      }
    },
    error: (error) => {
      if (res.raw.writableEnded) {
        return;
      }
      cleanupResponseListeners();
      const message = error instanceof Error ? error.message : String(error);
      if (protocol === 'anthropic') {
        const descriptor = resolveAnthropicError(error, message);
        res.raw.write(
          `event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: {
              type: descriptor.type,
              message,
            },
          })}\n\n`,
        );
        res.raw.end();
        return;
      }
      const status = resolveErrorHttpStatus(message, error);
      const rejection = classifyUpstreamParameterRejection(status, message);
      res.raw.write(
        `data: ${JSON.stringify({
          error: {
            message,
            type: resolveOpenAIErrorType(status),
            ...(rejection ? { param: rejection.param, code: rejection.code } : {}),
          },
        })}\n\n`,
      );
      res.raw.end();
    },
    complete: () => {
      cleanupResponseListeners();
      if (!res.raw.writableEnded) {
        res.raw.end();
      }
    },
  });
}
