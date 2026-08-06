import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import multipart from '@fastify/multipart';
import { FastifyInstance } from 'fastify';

const MEDIA_ENDPOINTS = new Set(['/v1/audio/transcriptions', '/v1/images/edits']);
const JSON_MEDIA_ENDPOINTS = new Set([
  '/v1/chat/completions',
  '/v1/messages',
  '/v1/responses',
  '/v1/images/edits',
  '/v1/audio/transcriptions',
]);
export const MAX_JSON_MEDIA_BODY_BYTES = 64 * 1024 * 1024;
const MULTIPART_ERROR_CODES = new Set([
  'FST_PARTS_LIMIT',
  'FST_FILES_LIMIT',
  'FST_FIELDS_LIMIT',
  'FST_REQ_FILE_TOO_LARGE',
  'FST_INVALID_MULTIPART_CONTENT_TYPE',
  'FST_PROTO_VIOLATION',
  'FST_INVALID_JSON_FIELD_ERROR',
  'ERR_STREAM_PREMATURE_CLOSE',
]);
const MULTIPART_PARSER_MESSAGES = new Set([
  'Multipart: Boundary not found',
  'Unexpected end of multipart data',
  'Part terminated early due to unexpected end of multipart data',
  'Boundary required',
  'Premature close',
]);
const MAX_MULTIPART_ERROR_CAUSE_DEPTH = 4;

export function isMultipartParserOrLimitError(error: unknown): error is Error {
  let currentError = error;
  for (let depth = 0; depth <= MAX_MULTIPART_ERROR_CAUSE_DEPTH; depth += 1) {
    if (!(currentError instanceof Error)) {
      return false;
    }

    const code = (currentError as Error & { code?: unknown }).code;
    if (
      (typeof code === 'string' && MULTIPART_ERROR_CODES.has(code)) ||
      MULTIPART_PARSER_MESSAGES.has(currentError.message)
    ) {
      return true;
    }

    currentError = (currentError as Error & { cause?: unknown }).cause;
  }

  return false;
}

export function isMultipartMediaEndpoint(url: string | undefined): boolean {
  return MEDIA_ENDPOINTS.has(normalizePathname(url));
}

export function isJsonMediaEndpoint(url: string | undefined): boolean {
  return JSON_MEDIA_ENDPOINTS.has(normalizePathname(url));
}

function normalizePathname(url: string | undefined): string {
  const pathname = url?.split('?', 1)[0] ?? '';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

@Catch()
export class MultipartOpenAIExceptionFilter extends BaseExceptionFilter {
  constructor(@Inject(HttpAdapterHost) httpAdapterHost: HttpAdapterHost) {
    super(httpAdapterHost.httpAdapter);
  }

  catch(error: unknown, host: ArgumentsHost): void {
    const request = host
      .switchToHttp()
      .getRequest<{ url?: string; headers?: { 'content-type'?: string } }>();
    const contentType = request.headers?.['content-type']?.toLowerCase() ?? '';
    const pathname = this.getPathname(request.url);
    const response = host.switchToHttp().getResponse();

    if (pathname.startsWith('/v1/') && isOpenAIJsonWireError(error, contentType)) {
      if (pathname === '/v1/messages') {
        response.status(this.getHttpStatus(error)).send({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              this.getHttpStatus(error) === HttpStatus.PAYLOAD_TOO_LARGE
                ? 'Request body too large.'
                : 'Malformed JSON request body.',
          },
        });
        return;
      }

      response.status(this.getHttpStatus(error)).send({
        error: {
          message:
            this.getHttpStatus(error) === HttpStatus.PAYLOAD_TOO_LARGE
              ? 'Request body too large.'
              : 'Malformed JSON request body.',
          type: 'invalid_request_error',
          param: null,
          code:
            this.getHttpStatus(error) === HttpStatus.PAYLOAD_TOO_LARGE
              ? 'request_body_too_large'
              : 'invalid_json',
        },
      });
      return;
    }

    if (
      isMultipartMediaEndpoint(request.url) &&
      contentType.includes('multipart/form-data') &&
      isMultipartParserOrLimitError(error)
    ) {
      response.status(400).send({
        error: {
          message: error instanceof Error ? error.message : 'Malformed multipart request.',
          type: 'invalid_request_error',
          param: null,
          code: 'multipart_parse_error',
        },
      });
      return;
    }

    super.catch(error, host);
  }
  private getHttpStatus(error: unknown): HttpStatus {
    return error instanceof HttpException ? error.getStatus() : HttpStatus.BAD_REQUEST;
  }

  private getPathname(url: string | undefined): string {
    return url?.split('?', 1)[0] ?? '';
  }
}

function isOpenAIJsonWireError(error: unknown, contentType: string): boolean {
  if (!contentType.includes('application/json')) {
    return false;
  }

  if (error instanceof HttpException && error.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE) {
    return true;
  }

  const code = (error as { code?: unknown })?.code;
  if (code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return true;
  }

  return (
    error instanceof HttpException &&
    error.getStatus() === HttpStatus.BAD_REQUEST &&
    getExceptionMessage(error).startsWith('Body is not valid JSON')
  );
}

function getExceptionMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'string') {
    return response;
  }

  if (!('message' in response)) {
    return '';
  }

  return typeof response.message === 'string' ? response.message : '';
}

@Injectable()
export class FastifyMultipartProvider implements OnModuleInit {
  constructor(@Inject(HttpAdapterHost) private readonly httpAdapterHost: HttpAdapterHost) {
    const fastify = this.httpAdapterHost.httpAdapter.getInstance<FastifyInstance>();

    // Nest maps controller routes after constructing providers, so this hook can set Fastify's
    // per-route parser limit before the OpenAI-compatible routes are registered.
    fastify.addHook('onRoute', (routeOptions) => {
      if (routeOptions.method === 'POST' && isJsonMediaEndpoint(routeOptions.url)) {
        routeOptions.bodyLimit = MAX_JSON_MEDIA_BODY_BYTES;
      }
    });
  }

  onModuleInit(): void {
    const fastify = this.httpAdapterHost.httpAdapter.getInstance<FastifyInstance>();
    fastify.register(multipart, {
      attachFieldsToBody: true,
      limits: {
        fields: 20,
        files: 17,
        fileSize: 25 * 1024 * 1024,
        parts: 40,
      },
    });
  }
}
