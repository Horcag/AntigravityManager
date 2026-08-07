import { ConflictException, Controller, Module, Post, UnauthorizedException } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { concat, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FastifyMultipartProvider,
  isMultipartMediaEndpoint,
  isMultipartParserOrLimitError,
  MAX_JSON_MEDIA_BODY_BYTES,
  MultipartOpenAIExceptionFilter,
} from '@/modules/proxy-gateway/server/fastify-multipart.provider';
import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';
import { ProxyGuard } from '@/modules/proxy-gateway/server/proxy.guard';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

const proxyService = {
  handleChatCompletions: vi.fn(),
  handleGeminiGenerateContent: vi.fn(),
  handleAnthropicMessages: vi.fn(),
};

@Module({
  controllers: [ProxyController],
  providers: [
    FastifyMultipartProvider,
    {
      provide: APP_FILTER,
      useClass: MultipartOpenAIExceptionFilter,
    },
    ProxyGuard,
    {
      provide: ProxyService,
      useValue: proxyService,
    },
  ],
})
class MultipartWireTestModule {}

@Controller('v1')
class MultipartExceptionRegressionController {
  @Post('audio/transcriptions')
  rejectMediaMultipart(): never {
    throw new UnauthorizedException('API key validation failed');
  }

  @Post('non-media')
  rejectNonMedia(): never {
    throw new ConflictException('ordinary route failure');
  }
}

@Module({
  controllers: [MultipartExceptionRegressionController],
  providers: [
    FastifyMultipartProvider,
    {
      provide: APP_FILTER,
      useClass: MultipartOpenAIExceptionFilter,
    },
  ],
})
class MultipartExceptionRegressionModule {}

function multipartBody(
  boundary: string,
  parts: Array<{ headers: string[]; value: Buffer | string }>,
) {
  const chunks = parts.flatMap(({ headers, value }) => [
    Buffer.from(`--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n`),
    Buffer.isBuffer(value) ? value : Buffer.from(value),
    Buffer.from('\r\n'),
  ]);

  return Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]);
}

describe('OpenAI multipart media endpoints', () => {
  let app: NestFastifyApplication;

  async function createApp(): Promise<NestFastifyApplication> {
    return NestFactory.create<NestFastifyApplication>(
      MultipartWireTestModule,
      new FastifyAdapter(),
      { logger: false },
    );
  }

  async function createExceptionRegressionApp(): Promise<NestFastifyApplication> {
    return NestFactory.create<NestFastifyApplication>(
      MultipartExceptionRegressionModule,
      new FastifyAdapter(),
      { logger: false },
    );
  }

  afterEach(async () => {
    vi.clearAllMocks();
    await app?.close();
  });

  it('declares HttpAdapterHost explicitly for production-safe multipart injection', () => {
    expect(Reflect.getMetadata('self:paramtypes', FastifyMultipartProvider)).toContainEqual({
      index: 0,
      param: HttpAdapterHost,
    });
    expect(Reflect.getMetadata('self:paramtypes', MultipartOpenAIExceptionFilter)).toContainEqual({
      index: 0,
      param: HttpAdapterHost,
    });
  });

  it('returns the OpenAI envelope for an unmatched /v1 route through Fastify', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/v1/unsupported?source=wire-test' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        message: 'Route GET:/v1/unsupported?source=wire-test not found',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    });
  });

  it('returns the OpenAI envelope for bare POST /v1 through Fastify', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: '/v1' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        message: 'Route POST:/v1 not found',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    });
  });

  it.each([
    ['/v1/messages', { type: 'error', error: { type: 'invalid_request_error' } }],
    ['/v1/chat/completions', { error: { type: 'invalid_request_error', param: null, code: null } }],
  ])('uses the protocol envelope for unsupported content types at %s', async (url, expected) => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'text/plain' },
        payload: 'not-json',
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(expected);
  });

  it('leaves unmatched non-/v1 routes to Nest default 404 handling', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/unmatched-non-v1-route' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      message: 'Cannot GET /unmatched-non-v1-route',
      error: 'Not Found',
      statusCode: 404,
    });
  });

  it('returns the OpenAI envelope for malformed JSON on a real /v1 request', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: '{"model":"gemini-3-flash",',
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'Malformed JSON request body.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_json',
      },
    });
  });

  it.each([
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/responses',
    '/v1/images/edits',
    '/v1/audio/transcriptions',
  ])('accepts a declared JSON media request larger than Fastify default at %s', async (url) => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ model: 'gemini-3-flash', padding: 'x'.repeat(2 * 1024 * 1024) }),
      });

    expect(response.statusCode, response.body).not.toBe(413);
  });

  it('keeps declared JSON media requests bounded at 64 MiB with an OpenAI 413 envelope', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          model: 'gemini-3-flash',
          padding: 'x'.repeat(MAX_JSON_MEDIA_BODY_BYTES),
        }),
      });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: {
        message: 'Request body too large.',
        type: 'invalid_request_error',
        param: null,
        code: 'request_body_too_large',
      },
    });
  });

  it('accepts a valid 2 MiB Anthropic JSON request through the route-scoped media limit', async () => {
    proxyService.handleAnthropicMessages.mockResolvedValue({ id: 'msg_1', type: 'message' });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'hi' }],
          padding: 'x'.repeat(2 * 1024 * 1024),
        }),
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(proxyService.handleAnthropicMessages).toHaveBeenCalledOnce();
  });

  it('keeps Anthropic JSON media requests bounded at 64 MiB with an Anthropic 413 envelope', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'hi' }],
          padding: 'x'.repeat(MAX_JSON_MEDIA_BODY_BYTES),
        }),
      });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Request body too large.' },
    });
  });

  it.each([
    ['an unsupported image MIME type', 'image/bmp', 'iVBORw0KGgo='],
    ['invalid image base64', 'image/png', 'not valid base64!'],
  ])('rejects Anthropic image blocks with %s before upstream', async (_label, mediaType, data) => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-sonnet-4-5',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }],
            },
          ],
        },
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'messages contains unsupported content' },
    });
    expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
  });

  it.each([
    ['image/jpeg', '/9j/'],
    ['image/png', 'iVBORw0KGgo='],
    ['image/gif', 'R0lGODlh'],
    ['image/webp', 'UklGRgAAAABXRUJQ'],
  ])('accepts a valid Anthropic %s image block before upstream', async (mediaType, data) => {
    proxyService.handleAnthropicMessages.mockResolvedValue({ id: 'msg_1', type: 'message' });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-sonnet-4-5',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType, data },
                },
              ],
            },
          ],
        },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(proxyService.handleAnthropicMessages).toHaveBeenCalledOnce();
  });

  it('emits an Anthropic SSE error event after a stream frame fails', async () => {
    proxyService.handleAnthropicMessages.mockResolvedValue(
      concat(
        of('event: message_start\ndata: {"type":"message_start"}\n\n'),
        throwError(() => new Error('upstream transport details')),
      ),
    );
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
      });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: message_start');
    expect(response.body).toContain(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Internal Server Error"}}\n\n',
    );
    expect(response.body).not.toContain('{"error":{"message":"Internal Server Error"');
  });

  it('preserves Anthropic errors through the assembled Nest and Fastify pipeline', async () => {
    proxyService.handleAnthropicMessages.mockRejectedValue(new Error('anthropic upstream failure'));
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/messages',
        payload: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'Internal Server Error' },
    });
  });

  it('recognizes the production wrapped truncated multipart parser error', () => {
    expect(
      isMultipartParserOrLimitError(
        new Error('Part terminated early due to unexpected end of multipart data'),
      ),
    ).toBe(true);
  });

  it('recognizes known multipart errors through a bounded cause chain only', () => {
    const wrapped = new Error('request failed', {
      cause: new Error('parser failed', {
        cause: Object.assign(new Error('Boundary required'), {
          code: 'FST_INVALID_MULTIPART_CONTENT_TYPE',
        }),
      }),
    });

    expect(isMultipartParserOrLimitError(wrapped)).toBe(true);
    expect(isMultipartParserOrLimitError(new Error('Multipart boundary might be required'))).toBe(
      false,
    );
  });

  it('preserves audio binary bytes and MIME type through a real multipart request', async () => {
    proxyService.handleGeminiGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'hello world' }] } }],
    });
    app = await createApp();
    await app.init();

    const boundary = '----openai-audio';
    const payload = multipartBody(boundary, [
      {
        headers: ['Content-Disposition: form-data; name="model"'],
        value: 'gemini-3-flash',
      },
      {
        headers: [
          'Content-Disposition: form-data; name="file"; filename="speech.wav"',
          'Content-Type: audio/wav',
        ],
        value: Buffer.from([0, 255, 16, 128]),
      },
    ]);

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ text: 'hello world' });
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'gemini-3-flash',
      expect.objectContaining({
        contents: [
          expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                inlineData: {
                  mimeType: 'audio/wav',
                  data: Buffer.from([0, 255, 16, 128]).toString('base64'),
                },
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it.each([
    [
      'application/octet-stream PNG',
      ['Content-Type: application/octet-stream'],
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      'image/png',
    ],
    [
      'application/octet-stream JPEG',
      ['Content-Type: application/octet-stream'],
      Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
      'image/jpeg',
    ],
    [
      'application/octet-stream GIF',
      ['Content-Type: application/octet-stream'],
      Buffer.from('GIF89a'),
      'image/gif',
    ],
    [
      'application/octet-stream WebP',
      ['Content-Type: application/octet-stream'],
      Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP'),
      'image/webp',
    ],
    ['no Content-Type header PNG', [], Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'],
  ])(
    'normalizes %s image multipart parts from their recognized signature',
    async (_label, contentTypeHeader, image, expectedMimeType) => {
      proxyService.handleChatCompletions.mockResolvedValue({
        choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
      });
      app = await createApp();
      await app.init();

      const boundary = '----generic-image';
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/images/edits',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: multipartBody(boundary, [
            { headers: ['Content-Disposition: form-data; name="prompt"'], value: 'make it blue' },
            {
              headers: [
                'Content-Disposition: form-data; name="image"; filename="source.bin"',
                ...contentTypeHeader,
              ],
              value: image,
            },
          ]),
        });

      expect(response.statusCode, response.body).toBe(200);
      expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  image_url: { url: `data:${expectedMimeType};base64,${image.toString('base64')}` },
                }),
              ]),
            }),
          ],
        }),
      );
    },
  );

  it.each([
    [
      'application/octet-stream MP3',
      ['Content-Type: application/octet-stream'],
      Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]),
      'audio/mpeg',
    ],
    [
      'application/octet-stream WAV',
      ['Content-Type: application/octet-stream'],
      Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE'),
      'audio/wav',
    ],
    [
      'application/octet-stream FLAC',
      ['Content-Type: application/octet-stream'],
      Buffer.from('fLaC'),
      'audio/flac',
    ],
    [
      'application/octet-stream OGG',
      ['Content-Type: application/octet-stream'],
      Buffer.from('OggS'),
      'audio/ogg',
    ],
    [
      'application/octet-stream MP4/M4A',
      ['Content-Type: application/octet-stream'],
      Buffer.from('\u0000\u0000\u0000\u0018ftypM4A '),
      'audio/mp4',
    ],
    [
      'application/octet-stream WebM',
      ['Content-Type: application/octet-stream'],
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      'audio/webm',
    ],
    [
      'no Content-Type header MP3',
      [],
      Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]),
      'audio/mpeg',
    ],
  ])(
    'normalizes %s audio multipart parts from their recognized signature',
    async (_label, contentTypeHeader, audio, expectedMimeType) => {
      proxyService.handleGeminiGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'hello world' }] } }],
      });
      app = await createApp();
      await app.init();

      const boundary = '----generic-audio';
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/audio/transcriptions',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: multipartBody(boundary, [
            { headers: ['Content-Disposition: form-data; name="model"'], value: 'gemini-3-flash' },
            {
              headers: [
                'Content-Disposition: form-data; name="file"; filename="speech.bin"',
                ...contentTypeHeader,
              ],
              value: audio,
            },
          ]),
        });

      expect(response.statusCode, response.body).toBe(200);
      expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith(
        'gemini-3-flash',
        expect.objectContaining({
          contents: [
            expect.objectContaining({
              parts: expect.arrayContaining([
                expect.objectContaining({
                  inlineData: { mimeType: expectedMimeType, data: audio.toString('base64') },
                }),
              ]),
            }),
          ],
        }),
      );
    },
  );

  it('accepts wrapped, case-insensitive audio JSON data URLs and normalizes their base64', async () => {
    proxyService.handleGeminiGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'hello world' }] } }],
    });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        payload: {
          model: 'gemini-3-flash',
          file: 'DATA:AUDIO/MPEG;charset=utf-8;BASE64,SU\nQzBA==',
        },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'gemini-3-flash',
      expect.objectContaining({
        contents: [
          expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                inlineData: { mimeType: 'audio/mpeg', data: 'SUQzBA==' },
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it('normalizes bare JSON image base64 from its recognized signature', async () => {
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    proxyService.handleChatCompletions.mockResolvedValue({
      choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
    });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        payload: { prompt: 'make it blue', image: image.toString('base64') },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                image_url: { url: `data:image/png;base64,${image.toString('base64')}` },
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it.each([['aGVsbG8='], [{ data: 'aGVsbG8=', mimeType: 'image/png' }]])(
    'rejects a non-array JSON reference_images value before invoking upstream work',
    async (referenceImages) => {
      app = await createApp();
      await app.init();

      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/images/edits',
          payload: {
            prompt: 'make it blue',
            image: 'data:image/png;base64,iVBORw0KGgo=',
            reference_images: referenceImages,
          },
        });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          message: 'reference_images must be an array.',
          type: 'invalid_request_error',
          param: 'reference_images',
          code: 'invalid_value',
        },
      });
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    },
  );

  it('treats a null JSON reference_images value as absent', async () => {
    proxyService.handleChatCompletions.mockResolvedValue({
      choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
    });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        payload: {
          prompt: 'make it blue',
          image: 'data:image/png;base64,iVBORw0KGgo=',
          reference_images: null,
        },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();
  });

  it('accepts a one-item JSON reference_images array', async () => {
    proxyService.handleChatCompletions.mockResolvedValue({
      choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
    });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        payload: {
          prompt: 'make it blue',
          image: 'data:image/png;base64,iVBORw0KGgo=',
          reference_images: ['data:image/png;base64,iVBORw0KGgo='],
        },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ image_url: expect.any(Object) }),
            ]),
          }),
        ],
      }),
    );
  });

  it('accepts documented JSON images data URLs through the assembled Fastify pipeline', async () => {
    proxyService.handleChatCompletions.mockResolvedValue({
      choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
    });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        payload: {
          prompt: 'make it blue',
          images: [{ image_url: 'data:image/png;base64,iVBORw0KGgo=' }],
        },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it.each([
    [{}, 'images[0]', 'images[0] must contain exactly one of image_url or file_id.'],
    [null, 'images[0]', 'images[0] must be an object.'],
    [
      { image_url: 'data:image/png;base64,iVBORw0KGgo=', file_id: 'file_123' },
      'images[0]',
      'images[0] must contain exactly one of image_url or file_id.',
    ],
    [
      { image_url: 'data:text/plain;base64,SGVsbG8=' },
      'images[0].image_url',
      'images[0].image_url must be a valid base64 image data URL or fully qualified HTTP(S) URL.',
    ],
  ])('rejects invalid documented JSON images entries', async (entry, param, message) => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        payload: { prompt: 'make it blue', images: [entry] },
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { message, type: 'invalid_request_error', param, code: 'invalid_value' },
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it.each([
    [
      { image_url: 'https://example.com/image.png' },
      'images[0].image_url',
      'images[0].image_url is not supported because this gateway does not fetch remote image URLs; use a data URL.',
    ],
    [
      { file_id: 'file_123' },
      'images[0].file_id',
      'images[0].file_id cannot be resolved because this gateway does not implement the Files API.',
    ],
  ])(
    'fails closed for JSON images entries the local gateway cannot resolve',
    async (entry, param, message) => {
      app = await createApp();
      await app.init();

      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/images/edits',
          payload: { prompt: 'make it blue', images: [entry] },
        });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: { message, type: 'invalid_request_error', param, code: 'unsupported_parameter' },
      });
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    },
  );

  it('counts documented JSON images with extension image inputs against the shared limit', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        payload: {
          prompt: 'combine images',
          image: 'data:image/png;base64,iVBORw0KGgo=',
          images: Array.from({ length: 16 }, () => ({
            image_url: 'data:image/png;base64,iVBORw0KGgo=',
          })),
        },
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'At most 16 image inputs are supported by this endpoint.',
        type: 'invalid_request_error',
        param: 'image',
        code: 'invalid_value',
      },
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it('normalizes bare JSON audio base64 from its recognized signature', async () => {
    const audio = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    proxyService.handleGeminiGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'hello world' }] } }],
    });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        payload: { model: 'gemini-3-flash', file: audio.toString('base64') },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'gemini-3-flash',
      expect.objectContaining({
        contents: [
          expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                inlineData: { mimeType: 'audio/mpeg', data: audio.toString('base64') },
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it.each([
    ['/v1/images/edits', { prompt: 'make it blue', image: 'aGVsbG8=' }, 'image'],
    ['/v1/audio/transcriptions', { model: 'gemini-3-flash', file: 'aGVsbG8=' }, 'file'],
  ])('rejects valid-base64 non-media JSON data locally for %s', async (url, payload, param) => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: `${param} must contain valid base64 data.`,
        type: 'invalid_request_error',
        param,
        code: 'invalid_value',
      },
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
  });

  it.each([
    ['/v1/images/edits', { prompt: 'make it blue', image: 'data:text/html;base64,PGgxPg==' }],
    [
      '/v1/audio/transcriptions',
      { model: 'gemini-3-flash', file: 'data:text/html;base64,PGgxPg==' },
    ],
    [
      '/v1/audio/transcriptions',
      { model: 'gemini-3-flash', file: 'data:audio/mpeg;base64,SU=QzBA==' },
    ],
  ])('rejects explicit non-media JSON MIME locally for %s', async (url, payload) => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url, payload });

    expect(response.statusCode).toBe(400);
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
  });

  it('returns transcript SSE events for stream=true JSON/base64 and multipart requests', async () => {
    proxyService.handleGeminiGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'transcribed' }] } }],
    });
    app = await createApp();
    await app.init();

    const jsonResponse = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        payload: {
          model: 'gemini-3-flash',
          file: 'data:audio/mpeg;base64,SUQzBAAA',
          stream: true,
        },
      });

    const boundary = '----openai-audio-stream';
    const multipartResponse = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="model"'], value: 'gemini-3-flash' },
          { headers: ['Content-Disposition: form-data; name="stream"'], value: 'true' },
          {
            headers: [
              'Content-Disposition: form-data; name="file"; filename="speech.mp3"',
              'Content-Type: audio/mpeg',
            ],
            value: Buffer.from([0x49, 0x44, 0x33, 0x04]),
          },
        ]),
      });

    for (const response of [jsonResponse, multipartResponse]) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.body).toBe(
        'event: transcript.text.delta\ndata: {"type":"transcript.text.delta","delta":"transcribed"}\n\nevent: transcript.text.done\ndata: {"type":"transcript.text.done","text":"transcribed"}\n\n',
      );
    }
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledTimes(2);
  });

  it('preserves false and omitted transcription stream values as non-streaming', async () => {
    proxyService.handleGeminiGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'transcribed' }] } }],
    });
    app = await createApp();
    await app.init();

    const jsonResponse = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        payload: {
          model: 'gemini-3-flash',
          file: 'data:audio/mpeg;base64,SUQzBAAA',
          stream: false,
        },
      });

    const boundary = '----openai-audio-non-stream';
    const multipartResponse = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="model"'], value: 'gemini-3-flash' },
          {
            headers: [
              'Content-Disposition: form-data; name="file"; filename="speech.mp3"',
              'Content-Type: audio/mpeg',
            ],
            value: Buffer.from([0x49, 0x44, 0x33, 0x04]),
          },
        ]),
      });

    expect(jsonResponse.statusCode, jsonResponse.body).toBe(200);
    expect(multipartResponse.statusCode, multipartResponse.body).toBe(200);
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledTimes(2);
  });

  it('ignores stream=true for whisper-1 and returns the ordinary JSON transcription', async () => {
    proxyService.handleGeminiGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'whisper transcription' }] } }],
    });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        payload: {
          model: 'whisper-1',
          file: 'data:audio/mpeg;base64,SUQzBAAA',
          stream: true,
        },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ text: 'whisper transcription' });
  });

  it.each([
    ['JSON/base64', undefined, { stream: 'not-a-boolean' }],
    ['multipart', 'not-a-boolean', undefined],
  ])(
    'rejects invalid transcription stream values from %s before upstream work',
    async (_source, multipartStream, jsonPayload) => {
      app = await createApp();
      await app.init();

      const boundary = '----openai-audio-invalid-stream';
      const response = multipartStream
        ? await app
            .getHttpAdapter()
            .getInstance()
            .inject({
              method: 'POST',
              url: '/v1/audio/transcriptions',
              headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
              payload: multipartBody(boundary, [
                {
                  headers: ['Content-Disposition: form-data; name="model"'],
                  value: 'gemini-3-flash',
                },
                {
                  headers: ['Content-Disposition: form-data; name="stream"'],
                  value: multipartStream,
                },
                {
                  headers: [
                    'Content-Disposition: form-data; name="file"; filename="speech.mp3"',
                    'Content-Type: audio/mpeg',
                  ],
                  value: Buffer.from([0x49, 0x44, 0x33, 0x04]),
                },
              ]),
            })
        : await app
            .getHttpAdapter()
            .getInstance()
            .inject({
              method: 'POST',
              url: '/v1/audio/transcriptions',
              payload: {
                model: 'gemini-3-flash',
                file: 'data:audio/mpeg;base64,SUQzBAAA',
                ...jsonPayload,
              },
            });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          message: 'stream must be a boolean.',
          type: 'invalid_request_error',
          param: 'stream',
          code: 'invalid_value',
        },
      });
      expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
    },
  );

  it('preserves OpenAI-shaped errors when a streaming transcription upstream call fails', async () => {
    proxyService.handleGeminiGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        payload: {
          model: 'gemini-3-flash',
          file: 'data:audio/mpeg;base64,SUQzBAAA',
          stream: true,
        },
      });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        message: 'Internal Server Error',
        type: 'server_error',
        param: null,
        code: null,
      },
    });
  });

  it('rejects repeated timestamp granularities from a real multipart audio request', async () => {
    app = await createApp();
    await app.init();

    const boundary = '----openai-audio-granularities';
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="model"'], value: 'gemini-3-flash' },
          {
            headers: ['Content-Disposition: form-data; name="timestamp_granularities[]"'],
            value: 'segment',
          },
          {
            headers: ['Content-Disposition: form-data; name="timestamp_granularities[]"'],
            value: 'word',
          },
          {
            headers: [
              'Content-Disposition: form-data; name="file"; filename="speech.wav"',
              'Content-Type: audio/wav',
            ],
            value: Buffer.from([0, 255, 16, 128]),
          },
        ]),
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'timestamp_granularities is not supported by this proxy.',
        type: 'invalid_request_error',
        param: 'timestamp_granularities',
        code: 'unsupported_option',
      },
    });
    expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
  });

  it('accepts a scalar image field through a real multipart request', async () => {
    proxyService.handleChatCompletions.mockResolvedValue({
      choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
    });
    app = await createApp();
    await app.init();

    const boundary = '----openai-image';
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="prompt"'], value: 'make it blue' },
          {
            headers: [
              'Content-Disposition: form-data; name="image"; filename="source.png"',
              'Content-Type: image/png',
            ],
            value: image,
          },
        ]),
      });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [{ b64_json: 'UkVTVUxU' }] });
    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                image_url: { url: `data:image/png;base64,${image.toString('base64')}` },
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it('accepts reference_images[] without duplicating multipart image parts', async () => {
    proxyService.handleChatCompletions.mockResolvedValue({
      choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
    });
    app = await createApp();
    await app.init();

    const boundary = '----openai-image-references';
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="prompt"'], value: 'combine images' },
          {
            headers: [
              'Content-Disposition: form-data; name="image"; filename="source.png"',
              'Content-Type: image/png',
            ],
            value: Buffer.from([1]),
          },
          {
            headers: [
              'Content-Disposition: form-data; name="reference_images[]"; filename="reference.png"',
              'Content-Type: image/png',
            ],
            value: Buffer.from([2]),
          },
        ]),
      });

    expect(response.statusCode, response.body).toBe(200);
    const request = proxyService.handleChatCompletions.mock.calls[0][0];
    expect(request.messages[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ image_url: expect.any(Object) })]),
    );
    expect(
      request.messages[0].content.filter((part: { type: string }) => part.type === 'image_url'),
    ).toHaveLength(2);
  });

  it('returns the OpenAI error envelope for a truncated multipart file with a query suffix', async () => {
    app = await createApp();
    await app.init();

    const boundary = '----parser-failure';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="speech.wav"\r\n' +
          'Content-Type: audio/wav\r\n\r\n',
      ),
      Buffer.from([0, 255, 16, 128]),
    ]);
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions?source=wire-test',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'Premature close',
        type: 'invalid_request_error',
        param: null,
        code: 'multipart_parse_error',
      },
    });
  });

  it('normalizes an optional trailing slash only for media error handling', () => {
    expect(isMultipartMediaEndpoint('/v1/audio/transcriptions/?source=wire-test')).toBe(true);
    expect(isMultipartMediaEndpoint('/v1/audio/transcriptions-extra/')).toBe(false);
  });

  it('rejects invalid JSON image base64 locally with the image parameter', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        payload: { prompt: 'make it blue', image: 'not valid base64!' },
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'image must contain valid base64 data.',
        type: 'invalid_request_error',
        param: 'image',
        code: 'invalid_value',
      },
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON audio base64 locally with the file parameter', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        payload: { model: 'gemini-3-flash', file: 'not valid base64!' },
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'file must contain valid base64 data.',
        type: 'invalid_request_error',
        param: 'file',
        code: 'invalid_value',
      },
    });
    expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
  });

  it('accepts sixteen OpenAI SDK image[] files without altering multipart parser limits', async () => {
    proxyService.handleChatCompletions.mockResolvedValue({
      choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
    });
    app = await createApp();
    await app.init();

    const boundary = '----image-limit';
    const images = Array.from({ length: 16 }, (_, index) => ({
      headers: [
        `Content-Disposition: form-data; name="image[]"; filename="${index}.png"`,
        'Content-Type: image/png',
      ],
      value: Buffer.from([index]),
    }));
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="prompt"'], value: 'combine images' },
          ...images,
        ]),
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ image_url: expect.any(Object) }),
            ]),
          }),
        ],
      }),
    );
  });

  it('rejects a seventeenth OpenAI SDK image[] file before invoking upstream work', async () => {
    app = await createApp();
    await app.init();

    const boundary = '----image-limit-overflow';
    const images = Array.from({ length: 17 }, (_, index) => ({
      headers: [
        `Content-Disposition: form-data; name="image[]"; filename="${index}.png"`,
        'Content-Type: image/png',
      ],
      value: Buffer.from([index]),
    }));
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="prompt"'], value: 'combine images' },
          ...images,
        ]),
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'At most 16 image inputs are supported by this endpoint.',
        type: 'invalid_request_error',
        param: 'image',
        code: 'invalid_value',
      },
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it('rejects a seventeenth JSON image before invoking upstream work', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        payload: {
          prompt: 'combine images',
          image: 'data:image/png;base64,IMAGE_0',
          reference_images: Array.from(
            { length: 16 },
            (_, index) => `data:image/png;base64,REFERENCE_${index}`,
          ),
        },
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'At most 16 image inputs are supported by this endpoint.',
        type: 'invalid_request_error',
        param: 'image',
        code: 'invalid_value',
      },
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it('rejects an explicit multipart image edit user before invoking upstream work', async () => {
    app = await createApp();
    await app.init();

    const boundary = '----image-user';
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/edits',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="prompt"'], value: 'make it blue' },
          { headers: ['Content-Disposition: form-data; name="user"'], value: 'end-user-123' },
          {
            headers: [
              'Content-Disposition: form-data; name="image"; filename="source.png"',
              'Content-Type: image/png',
            ],
            value: Buffer.from([137, 80, 78, 71]),
          },
        ]),
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message:
          'user is not supported because this proxy cannot preserve end-user identifier semantics.',
        type: 'invalid_request_error',
        param: 'user',
        code: 'unsupported_parameter',
      },
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it('rejects unsupported image options through the assembled Nest and Fastify pipeline', async () => {
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/generations',
        payload: { prompt: 'draw a cat', output_format: 'jpeg' },
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'Only output_format=png is supported by this proxy.',
        type: 'invalid_request_error',
        param: 'output_format',
        code: 'unsupported_parameter',
      },
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it('returns a b64_json image for default image generation options through Fastify', async () => {
    proxyService.handleChatCompletions.mockResolvedValue({
      choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
    });
    app = await createApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/images/generations',
        payload: { prompt: 'draw a cat' },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      created: expect.any(Number),
      data: [{ b64_json: 'UkVTVUxU' }],
    });
    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3-pro-image',
        size: undefined,
        quality: undefined,
      }),
    );
  });

  it('keeps an auth exception on a media multipart request under Nest handling', async () => {
    app = await createExceptionRegressionApp();
    await app.init();

    const boundary = '----valid-boundary';
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { headers: ['Content-Disposition: form-data; name="model"'], value: 'gemini-3-flash' },
        ]),
      });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      statusCode: 401,
      message: 'API key validation failed',
      error: 'Unauthorized',
    });
  });

  it('keeps a non-media route exception under Nest handling', async () => {
    app = await createExceptionRegressionApp();
    await app.init();

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: '/v1/non-media', payload: {} });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      statusCode: 409,
      message: 'ordinary route failure',
      error: 'Conflict',
    });
  });
});
