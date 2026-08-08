import { HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { OpenAIRequestValidationError } from '../modules/openai/chat/openai-request-contract';
import { AnthropicRequestValidationError } from '../modules/anthropic/anthropic-request-contract';
import { OpenAIMediaRequestError } from '../modules/openai/media/openai-media-request-contract';
import { FileReferenceError } from '../modules/files/file-reference-expander';
import { ModelRouteError } from './exceptions/model-route-exception';
import { UpstreamRequestError } from './exceptions/upstream-request-exception';
import {
  classifyUpstreamParameterRejection,
  resolveOpenAIErrorType,
} from './upstream-error-taxonomy';

/** The subset of Nest's `Logger` the error responders need. */
export interface ProxyErrorLogger {
  warn(message: string): void;
  error(message: string, stack?: string): void;
}

export function resolveErrorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : 'Internal Server Error';
}

export function createAnthropicRequestId(): string {
  return `req_${uuidv4().replace(/-/gu, '')}`;
}

export function logProxyEndpointError(
  logger: ProxyErrorLogger,
  endpoint: string,
  status: HttpStatus,
  message: string,
  error?: unknown,
): void {
  const base = `[${endpoint}] status=${status} message=${message}`;
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
    logger.error(base, error instanceof Error ? error.stack : undefined);
    return;
  }
  logger.warn(base);
}

export function resolveErrorHttpStatus(message: string, error?: unknown): HttpStatus {
  if (
    error instanceof UpstreamRequestError &&
    Number.isInteger(error.status) &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status <= 599
  ) {
    return error.status as HttpStatus;
  }

  const lowered = message.toLowerCase();
  if (lowered.includes('all accounts failed or unhealthy')) {
    return HttpStatus.SERVICE_UNAVAILABLE;
  }
  if (lowered.includes('all accounts exhausted') || lowered.includes('no available accounts')) {
    return HttpStatus.TOO_MANY_REQUESTS;
  }
  if (
    lowered.includes('network socket disconnected') ||
    lowered.includes('secure tls connection was established') ||
    lowered.includes('socket hang up') ||
    lowered.includes('econnreset') ||
    lowered.includes('eai_again')
  ) {
    return HttpStatus.SERVICE_UNAVAILABLE;
  }
  if (lowered.includes('401') || lowered.includes('unauthorized')) {
    return HttpStatus.UNAUTHORIZED;
  }
  if (lowered.includes('403') || lowered.includes('forbidden')) {
    return HttpStatus.FORBIDDEN;
  }
  if (lowered.includes('429') || lowered.includes('rate limit') || lowered.includes('quota')) {
    return HttpStatus.TOO_MANY_REQUESTS;
  }
  if (lowered.includes('503') || lowered.includes('service unavailable')) {
    return HttpStatus.SERVICE_UNAVAILABLE;
  }
  if (lowered.includes('502') || lowered.includes('bad gateway')) {
    return HttpStatus.BAD_GATEWAY;
  }
  if (lowered.includes('504') || lowered.includes('timeout')) {
    return HttpStatus.GATEWAY_TIMEOUT;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

export function resolveAnthropicError(
  error: unknown,
  message: string,
): { status: HttpStatus; type: string } {
  if (error instanceof AnthropicRequestValidationError) {
    return { status: HttpStatus.BAD_REQUEST, type: 'invalid_request_error' };
  }

  const resolvedStatus = resolveErrorHttpStatus(message, error);
  switch (resolvedStatus) {
    case HttpStatus.BAD_REQUEST:
      return { status: resolvedStatus, type: 'invalid_request_error' };
    case HttpStatus.UNAUTHORIZED:
      return { status: resolvedStatus, type: 'authentication_error' };
    case HttpStatus.PAYMENT_REQUIRED:
      return { status: resolvedStatus, type: 'billing_error' };
    case HttpStatus.FORBIDDEN:
      return { status: resolvedStatus, type: 'permission_error' };
    case HttpStatus.NOT_FOUND:
      return { status: resolvedStatus, type: 'not_found_error' };
    case HttpStatus.CONFLICT:
      return { status: resolvedStatus, type: 'conflict_error' };
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return { status: resolvedStatus, type: 'request_too_large' };
    case HttpStatus.TOO_MANY_REQUESTS:
      return { status: resolvedStatus, type: 'rate_limit_error' };
    case HttpStatus.GATEWAY_TIMEOUT:
      return { status: resolvedStatus, type: 'timeout_error' };
    case HttpStatus.SERVICE_UNAVAILABLE:
      return { status: 529 as HttpStatus, type: 'overloaded_error' };
    default:
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, type: 'api_error' };
  }
}

export function sendOpenAIErrorResponse(
  logger: ProxyErrorLogger,
  res: FastifyReply,
  endpoint: string,
  error: unknown,
  overrideMessage?: string,
): void {
  const message = overrideMessage ?? resolveErrorMessageText(error);
  if (error instanceof FileReferenceError) {
    logProxyEndpointError(logger, endpoint, error.httpStatus as HttpStatus, message, error);
    res.status(error.httpStatus).send({
      error: {
        message,
        type: 'invalid_request_error',
        param: error.param,
        code: error.httpStatus === HttpStatus.NOT_FOUND ? 'file_not_found' : 'invalid_value',
      },
    });
    return;
  }
  if (error instanceof OpenAIMediaRequestError) {
    logProxyEndpointError(logger, endpoint, error.statusCode, message, error);
    res.status(error.statusCode).send({
      error: {
        message,
        type: error.type,
        param: error.param,
        code: error.code,
      },
    });
    return;
  }
  if (error instanceof ModelRouteError) {
    const status = error.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    logProxyEndpointError(logger, endpoint, status as HttpStatus, message, error);
    res.status(status).send({
      error: {
        message,
        type:
          status === HttpStatus.NOT_FOUND
            ? 'invalid_request_error'
            : status === HttpStatus.TOO_MANY_REQUESTS
              ? 'rate_limit_error'
              : 'server_error',
        param: 'model',
        code: error.code,
      },
    });
    return;
  }
  if (error instanceof OpenAIRequestValidationError) {
    logProxyEndpointError(logger, endpoint, HttpStatus.BAD_REQUEST, message, error);
    res.status(HttpStatus.BAD_REQUEST).send({
      error: {
        message,
        type: error.type,
        param: error.param,
        code: error.code,
      },
    });
    return;
  }
  const status = resolveErrorHttpStatus(message, error);
  const rejection = classifyUpstreamParameterRejection(status, message);
  logProxyEndpointError(logger, endpoint, status, message, error);
  res.status(status).send({
    error: {
      message,
      type: resolveOpenAIErrorType(status),
      ...(rejection ? { param: rejection.param, code: rejection.code } : {}),
    },
  });
}

export function sendAnthropicErrorResponse(
  logger: ProxyErrorLogger,
  res: FastifyReply,
  endpoint: string,
  error: unknown,
  overrideMessage?: string,
  requestId: string = createAnthropicRequestId(),
): void {
  const message = overrideMessage ?? resolveErrorMessageText(error);
  const descriptor = resolveAnthropicError(error, message);
  logProxyEndpointError(logger, endpoint, descriptor.status, message, error);
  res
    .header('request-id', requestId)
    .status(descriptor.status)
    .send({
      type: 'error',
      error: {
        type: descriptor.type,
        message,
      },
      request_id: requestId,
    });
}
