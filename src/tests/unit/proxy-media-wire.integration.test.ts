import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { of } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';
import {
  OPENAI_INLINE_MEDIA_BYTES_LIMIT,
  OPENAI_MEDIA_MULTIPART_OPTIONS,
} from '@/modules/proxy-gateway/server/modules/openai/media/openai-media-request-contract';
import { applyProxyRouteBodyLimit } from '@/server/proxy-body-limit';
import { createMultipartPayload } from '../support/http-payloads';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
const wav = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVE'),
  Buffer.alloc(8),
]);

describe('OpenAI media HTTP wire contract', () => {
  let server: FastifyInstance;
  const proxyService = {
    handleChatCompletions: vi.fn(),
    handleGeminiGenerateContent: vi.fn(),
    handleGeminiStreamGenerateContent: vi.fn(),
  };

  beforeAll(async () => {
    server = Fastify();
    server.addHook('onRoute', applyProxyRouteBodyLimit);
    await server.register(fastifyMultipart, OPENAI_MEDIA_MULTIPART_OPTIONS);
    // The image endpoints resolve their model from the provider's
    // `image_generation` role when the caller names none.
    const accountLeaseService = {
      getModelIdsForRole: (role: string) =>
        role === 'image_generation' ? ['gemini-3.1-flash-image'] : [],
    };
    const controller = new ProxyController(proxyService as never, accountLeaseService as never);
    server.post('/v1/images/generations', async (request, reply) =>
      controller.imageGenerations(request.body as never, reply),
    );
    server.post('/v1/images/edits', async (request, reply) =>
      controller.imageEdits(request, reply),
    );
    server.post('/v1/audio/transcriptions', async (request, reply) =>
      controller.audioTranscriptions(request, reply),
    );
    await server.ready();
  });

  beforeEach(() => {
    const firstFrame = Buffer.concat([png, Buffer.from([1])]).toString('base64');
    const finalFrame = Buffer.concat([png, Buffer.from([2])]).toString('base64');
    proxyService.handleChatCompletions.mockReset().mockImplementation((request) => {
      if (request.stream) {
        const chunk = (data: string) =>
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: `![image](data:image/png;base64,${data})`,
                },
                index: 0,
              },
            ],
          })}\n\n`;
        return of(chunk(firstFrame), chunk(finalFrame), 'data: [DONE]\n\n');
      }
      return Promise.resolve({
        choices: [
          {
            message: { content: `![image](data:image/png;base64,${png.toString('base64')})` },
          },
        ],
      });
    });
    proxyService.handleGeminiGenerateContent.mockReset().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'wire transcript' }] } }],
    });
    proxyService.handleGeminiStreamGenerateContent.mockReset().mockResolvedValue(
      of(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'wire ' }] }, index: 0 }],
        })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'transcript' }] }, index: 0 }],
        })}\n\n`,
      ),
    );
  });

  afterAll(async () => {
    await server.close();
  });

  it('supports buffered generation and maps real upstream image frames to OpenAI SSE', async () => {
    const buffered = await server.inject({
      method: 'POST',
      url: '/v1/images/generations',
      payload: { prompt: 'draw a fox', size: '1024x1024' },
    });
    const streamed = await server.inject({
      method: 'POST',
      url: '/v1/images/generations',
      payload: { partial_images: 1, prompt: 'draw a fox', stream: true },
    });

    expect(buffered.statusCode).toBe(200);
    expect(buffered.json()).toMatchObject({
      data: [{ b64_json: png.toString('base64') }],
      output_format: 'png',
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers['content-type']).toContain('text/event-stream');
    expect(streamed.body).toContain('event: image_generation.partial_image');
    expect(streamed.body).toContain('event: image_generation.completed');
    expect(streamed.body).toContain('"type":"image_generation.completed"');
    expect(proxyService.handleChatCompletions).toHaveBeenLastCalledWith(
      expect.objectContaining({ stream: true }),
    );
  });

  it('accepts JSON edit arrays while rejecting remote and file-id references', async () => {
    const accepted = await server.inject({
      method: 'POST',
      url: '/v1/images/edits',
      payload: {
        images: [
          { image_url: `data:image/png;base64,${png.toString('base64')}` },
          { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
        ],
        prompt: 'combine',
      },
    });
    const remote = await server.inject({
      method: 'POST',
      url: '/v1/images/edits',
      payload: {
        images: [{ image_url: 'https://example.com/source.png' }],
        prompt: 'edit',
      },
    });
    const fileId = await server.inject({
      method: 'POST',
      url: '/v1/images/edits',
      payload: { images: [{ file_id: 'file_123' }], prompt: 'edit' },
    });

    expect(accepted.statusCode).toBe(200);
    expect(proxyService.handleChatCompletions.mock.calls[0][0].messages[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image_url' }),
        expect.objectContaining({ type: 'image_url' }),
      ]),
    );
    for (const rejected of [remote, fileId]) {
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({
        error: { type: 'invalid_request_error', code: 'unsupported_parameter' },
      });
    }
  });

  it('supports standard multipart image[] edits and real upstream SSE completion', async () => {
    const boundary = '----agm-wire-image';
    const response = await server.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: createMultipartPayload(
        boundary,
        [
          ['prompt', 'merge'],
          ['stream', 'true'],
        ],
        [
          { bytes: png, field: 'image[]', filename: 'one.png', mimeType: 'image/png' },
          { bytes: jpeg, field: 'image[]', filename: 'two.jpg', mimeType: 'image/jpeg' },
        ],
      ),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: image_edit.completed');
  });

  it('rejects duplicate multipart scalar fields instead of silently taking the last value', async () => {
    const boundary = '----agm-wire-duplicate-prompt';
    const response = await server.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: createMultipartPayload(
        boundary,
        [
          ['prompt', 'first instruction'],
          ['prompt', 'second instruction'],
        ],
        [{ bytes: png, field: 'image', filename: 'source.png', mimeType: 'image/png' }],
      ),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { param: 'prompt', type: 'invalid_request_error' },
    });
  });

  it('handles buffered audio formats and maps the real Gemini transcript stream', async () => {
    const request = async (responseFormat: string, stream: boolean) => {
      const boundary = `----agm-wire-audio-${responseFormat}-${stream}`;
      return server.inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: createMultipartPayload(
          boundary,
          [
            ['model', 'gemini-3-flash'],
            ['response_format', responseFormat],
            ['stream', String(stream)],
          ],
          [{ bytes: wav, field: 'file', filename: 'speech.wav', mimeType: 'audio/wav' }],
        ),
      });
    };

    const json = await request('json', false);
    const text = await request('text', false);
    const stream = await request('json', true);

    expect(json.json()).toEqual({ text: 'wire transcript' });
    expect(text.headers['content-type']).toContain('text/plain');
    expect(text.body).toBe('wire transcript');
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('"type":"transcript.text.delta"');
    expect(stream.body).toContain('"type":"transcript.text.done"');
    expect(stream.body).toContain('"delta":"wire "');
    expect(stream.body).toContain('"delta":"transcript"');
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledTimes(2);
    expect(proxyService.handleGeminiStreamGenerateContent).toHaveBeenCalledOnce();
  });

  it('preserves an upstream audio failure instead of relabeling it as bad multipart', async () => {
    proxyService.handleGeminiGenerateContent.mockRejectedValueOnce(
      new Error('503 upstream transcription unavailable'),
    );
    const boundary = '----agm-wire-audio-upstream-error';
    const response = await server.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: createMultipartPayload(
        boundary,
        [['model', 'gemini-3-flash']],
        [{ bytes: wav, field: 'file', filename: 'speech.wav', mimeType: 'audio/wav' }],
      ),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { message: '503 upstream transcription unavailable' },
    });
  });

  it('returns an OpenAI 413 envelope for an oversized multipart file', async () => {
    const boundary = '----agm-wire-oversized';
    const oversized = Buffer.alloc(OPENAI_INLINE_MEDIA_BYTES_LIMIT + 1);
    png.subarray(0, 8).copy(oversized, 0);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: createMultipartPayload(
        boundary,
        [['prompt', 'edit']],
        [{ bytes: oversized, field: 'image', filename: 'large.png', mimeType: 'image/png' }],
      ),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: {
        code: 'payload_too_large',
        type: 'invalid_request_error',
      },
    });
  });
});
