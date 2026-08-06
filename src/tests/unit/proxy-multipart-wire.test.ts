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

  it('accepts sixteen image files and an optional mask', async () => {
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
          {
            headers: [
              'Content-Disposition: form-data; name="mask"; filename="mask.png"',
              'Content-Type: image/png',
            ],
            value: Buffer.from([255]),
          },
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
