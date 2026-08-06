import { ConflictException, Controller, Module, Post, UnauthorizedException } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FastifyMultipartProvider,
  isMultipartMediaEndpoint,
  isMultipartParserOrLimitError,
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
      error: { type: 'api_error', message: 'anthropic upstream failure' },
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
