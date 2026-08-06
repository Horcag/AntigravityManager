import { ArgumentsHost, Catch, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import multipart from '@fastify/multipart';
import { FastifyInstance } from 'fastify';

const MEDIA_ENDPOINTS = new Set(['/v1/audio/transcriptions', '/v1/images/edits']);
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
  'Boundary required',
  'Premature close',
]);

export function isMultipartParserOrLimitError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as Error & { code?: unknown }).code;
  return (
    (typeof code === 'string' && MULTIPART_ERROR_CODES.has(code)) ||
    MULTIPART_PARSER_MESSAGES.has(error.message)
  );
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
    if (
      MEDIA_ENDPOINTS.has(this.getPathname(request.url)) &&
      contentType.includes('multipart/form-data') &&
      isMultipartParserOrLimitError(error)
    ) {
      const response = host.switchToHttp().getResponse();
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

  private getPathname(url: string | undefined): string {
    return url?.split('?', 1)[0] ?? '';
  }
}

@Injectable()
export class FastifyMultipartProvider implements OnModuleInit {
  constructor(@Inject(HttpAdapterHost) private readonly httpAdapterHost: HttpAdapterHost) {}

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
