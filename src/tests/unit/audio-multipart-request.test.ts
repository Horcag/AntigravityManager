import fastifyMultipart from '@fastify/multipart';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseAudioMultipartRequest } from '@/modules/proxy-gateway/server/modules/openai/media/audio-multipart-request';
import { OpenAIMediaRequestError } from '@/modules/proxy-gateway/server/modules/openai/media/openai-media-request-contract';

const servers: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function multipartPayload(
  boundary: string,
  fields: Array<[string, string]>,
  file: { bytes: Buffer; filename: string; mimeType: string },
): Buffer {
  const chunks: Uint8Array[] = fields.map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return Buffer.concat(chunks);
}

async function createServer() {
  const server = Fastify();
  servers.push(server);
  await server.register(fastifyMultipart);
  server.post('/audio/transcriptions', async (request, reply) => {
    try {
      return await parseAudioMultipartRequest(request);
    } catch (error) {
      const mediaError = error as OpenAIMediaRequestError;
      return reply.status(mediaError.statusCode ?? 500).send({
        code: mediaError.code,
        message: mediaError.message,
        param: mediaError.param,
      });
    }
  });
  return server;
}

describe('parseAudioMultipartRequest', () => {
  it('parses a real WAV upload and streaming controls', async () => {
    const server = await createServer();
    const boundary = '----antigravity-audio';
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WAVE'),
      Buffer.alloc(8),
    ]);

    const response = await server.inject({
      method: 'POST',
      url: '/audio/transcriptions',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(
        boundary,
        [
          ['model', 'gemini-3-flash'],
          ['prompt', 'Keep product names verbatim'],
          ['language', 'ru'],
          ['response_format', 'json'],
          ['stream', 'true'],
          ['temperature', '0.2'],
        ],
        { bytes: wav, filename: 'speech.wav', mimeType: 'audio/wav' },
      ),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      file: {
        bytes: wav.length,
        data: wav.toString('base64'),
        filename: 'speech.wav',
        mimeType: 'audio/wav',
      },
      language: 'ru',
      model: 'gemini-3-flash',
      prompt: 'Keep product names verbatim',
      response_format: 'json',
      stream: true,
      temperature: 0.2,
    });
  });

  it('rejects media formats that Gemini inline audio does not support', async () => {
    const server = await createServer();
    const boundary = '----antigravity-audio-webm';
    const response = await server.inject({
      method: 'POST',
      url: '/audio/transcriptions',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(boundary, [['model', 'gemini-3-flash']], {
        bytes: Buffer.from('webm payload'),
        filename: 'speech.webm',
        mimeType: 'audio/webm',
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'invalid_value',
      param: 'file',
    });
  });
});
