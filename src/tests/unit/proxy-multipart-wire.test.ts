import { ConflictException, Controller, Module, Post, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FastifyMultipartProvider,
  MultipartOpenAIExceptionFilter,
} from '@/modules/proxy-gateway/server/fastify-multipart.provider';
import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';
import { ProxyGuard } from '@/modules/proxy-gateway/server/proxy.guard';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

const proxyService = {
  handleChatCompletions: vi.fn(),
  handleGeminiGenerateContent: vi.fn(),
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

  it('preserves image binary bytes and MIME type through a real multipart request', async () => {
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
        code: 'multipart_parse_error',
      },
    });
  });

  it('accepts sixteen image files without altering multipart parser limits', async () => {
    proxyService.handleChatCompletions.mockResolvedValue({
      choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
    });
    app = await createApp();
    await app.init();

    const boundary = '----image-limit';
    const images = Array.from({ length: 16 }, (_, index) => ({
      headers: [
        `Content-Disposition: form-data; name="image"; filename="${index}.png"`,
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

  it('rejects a seventeenth multipart image before invoking upstream work', async () => {
    app = await createApp();
    await app.init();

    const boundary = '----image-limit-overflow';
    const images = Array.from({ length: 17 }, (_, index) => ({
      headers: [
        `Content-Disposition: form-data; name="image"; filename="${index}.png"`,
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
        code: 'invalid_request_error',
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
        code: 'invalid_request_error',
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
