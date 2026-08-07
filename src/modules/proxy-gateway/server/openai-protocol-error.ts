import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { isNumber, isString } from 'lodash-es';

import { UpstreamRequestError } from './clients/upstream-error';

type OpenAIErrorType =
  | 'authentication_error'
  | 'invalid_request_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'server_error';

type AnthropicErrorType =
  | 'api_error'
  | 'authentication_error'
  | 'invalid_request_error'
  | 'not_found_error'
  | 'overloaded_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'request_too_large'
  | 'timeout_error';

export class OpenAIProtocolException extends HttpException {
  constructor(
    message: string,
    status: HttpStatus,
    readonly protocolError: { param?: string | null; code?: string | null } = {},
  ) {
    super(message, status);
  }
}

/**
 * Marks an account-pool failure at the source so protocol adapters never infer
 * a client-visible status from an arbitrary error message.
 */
export class AccountPoolUnavailableException extends HttpException {
  constructor(
    message: string,
    status: HttpStatus.TOO_MANY_REQUESTS | HttpStatus.SERVICE_UNAVAILABLE,
  ) {
    super(message, status);
  }
}

export function sendOpenAIProtocolError(res: FastifyReply, error: unknown): void {
  const mapped = mapOpenAIProtocolError(error);
  if (mapped.retryAfter) {
    res.header('retry-after', mapped.retryAfter);
  }
  res.status(mapped.status).send({ error: mapped.error });
}

export function sendAnthropicProtocolError(res: FastifyReply, error: unknown): void {
  const mapped = mapAnthropicProtocolError(error);
  if (mapped.retryAfter) {
    res.header('retry-after', mapped.retryAfter);
  }
  res.status(mapped.status).send({ type: 'error', error: mapped.error });
}

export function mapAnthropicProtocolError(error: unknown): {
  status: HttpStatus;
  retryAfter?: string;
  error: { type: AnthropicErrorType; message: string };
} {
  const mapped = mapOpenAIProtocolError(error);

  return {
    status: mapped.status,
    retryAfter: mapped.retryAfter,
    error: {
      type: mapAnthropicErrorType(mapped.status),
      message: mapped.error.message,
    },
  };
}

export function mapOpenAIProtocolError(
  error: unknown,
  options: { preserveUnexpected5xxMessage?: boolean } = {},
): {
  status: HttpStatus;
  retryAfter?: string;
  error: { message: string; type: OpenAIErrorType; param: string | null; code: string | null };
} {
  const upstream = error instanceof UpstreamRequestError ? error : undefined;
  const exception = error instanceof HttpException ? error : undefined;
  const status = isValidHttpStatus(upstream?.status)
    ? upstream.status
    : exception
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
  const protocolError = error instanceof OpenAIProtocolException ? error.protocolError : {};

  return {
    status,
    retryAfter: upstream?.headers?.retryAfter,
    error: {
      message: sanitizeMessage(error, status, options),
      type: mapOpenAIErrorType(status),
      param: protocolError.param ?? null,
      code: protocolError.code ?? null,
    },
  };
}

@Catch()
@Injectable()
export class ProxyProtocolExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();

    if (request.method === 'POST' && request.url.split('?')[0] === '/v1/messages') {
      sendAnthropicProtocolError(reply, exception);
      return;
    }

    sendOpenAIProtocolError(reply, exception);
  }
}

function mapAnthropicErrorType(status: number): AnthropicErrorType {
  if (status === HttpStatus.BAD_REQUEST) {
    return 'invalid_request_error';
  }
  if (status === HttpStatus.UNAUTHORIZED) {
    return 'authentication_error';
  }
  if (status === HttpStatus.FORBIDDEN) {
    return 'permission_error';
  }
  if (status === HttpStatus.NOT_FOUND) {
    return 'not_found_error';
  }
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
    return 'request_too_large';
  }
  if (status === HttpStatus.TOO_MANY_REQUESTS) {
    return 'rate_limit_error';
  }
  if (status === HttpStatus.GATEWAY_TIMEOUT) {
    return 'timeout_error';
  }
  if (status === 529) {
    return 'overloaded_error';
  }
  return 'api_error';
}

function isValidHttpStatus(status: unknown): status is HttpStatus {
  return isNumber(status) && Number.isInteger(status) && status >= 400 && status <= 599;
}

function mapOpenAIErrorType(status: HttpStatus): OpenAIErrorType {
  if (status === HttpStatus.BAD_REQUEST || status === HttpStatus.UNPROCESSABLE_ENTITY) {
    return 'invalid_request_error';
  }
  if (status === HttpStatus.UNAUTHORIZED) {
    return 'authentication_error';
  }
  if (status === HttpStatus.FORBIDDEN) {
    return 'permission_error';
  }
  if (status === HttpStatus.NOT_FOUND) {
    return 'invalid_request_error';
  }
  if (status === HttpStatus.TOO_MANY_REQUESTS) {
    return 'rate_limit_error';
  }
  return 'server_error';
}

function sanitizeMessage(
  error: unknown,
  status: HttpStatus,
  options: { preserveUnexpected5xxMessage?: boolean },
): string {
  if (
    status >= HttpStatus.INTERNAL_SERVER_ERROR &&
    !options.preserveUnexpected5xxMessage &&
    !(error instanceof OpenAIProtocolException) &&
    !(error instanceof UpstreamRequestError)
  ) {
    return 'Internal Server Error';
  }

  const message = error instanceof Error ? error.message : 'Internal Server Error';
  return isString(message)
    ? message
        .replace(/<[^>]*>?/g, '')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 1000)
    : 'Internal Server Error';
}
