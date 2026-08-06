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

export function mapOpenAIProtocolError(error: unknown): {
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
  const options = error instanceof OpenAIProtocolException ? error.protocolError : {};

  return {
    status,
    retryAfter: upstream?.headers?.retryAfter,
    error: {
      message: sanitizeMessage(error),
      type: mapOpenAIErrorType(status),
      param: options.param ?? null,
      code: options.code ?? null,
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
      const mapped = mapOpenAIProtocolError(exception);
      reply.status(mapped.status).send({
        type: 'error',
        error: {
          type:
            mapped.error.type === 'invalid_request_error' ? 'invalid_request_error' : 'api_error',
          message: mapped.error.message,
        },
      });
      return;
    }

    sendOpenAIProtocolError(reply, exception);
  }
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

function sanitizeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Internal Server Error';
  return isString(message)
    ? message
        .replace(/<[^>]*>?/g, '')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 1000)
    : 'Internal Server Error';
}
