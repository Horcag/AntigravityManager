import fastifyMultipart from '@fastify/multipart';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { parseImageMultipartRequest } from '@/modules/proxy-gateway/server/modules/openai/media/image-multipart-request';

const servers: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('parseImageMultipartRequest', () => {
  it('parses real multipart fields and preserves uploaded MIME types', async () => {
    const server = Fastify();
    servers.push(server);
    await server.register(fastifyMultipart);
    server.post('/images/edits', async (request) => parseImageMultipartRequest(request));

    const boundary = '----antigravity-multipart';
    const main = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);
    const reference = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
    const payload = Buffer.concat([
      Buffer.from(
        [
          `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it brighter`,
          `--${boundary}\r\nContent-Disposition: form-data; name="aspect_ratio"\r\n\r\n16:9`,
          `--${boundary}\r\nContent-Disposition: form-data; name="image_size"\r\n\r\n4K`,
          `--${boundary}\r\nContent-Disposition: form-data; name="style"\r\n\r\nvivid`,
          `--${boundary}\r\nContent-Disposition: form-data; name="stream"\r\n\r\ntrue`,
          `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="main.png"\r\nContent-Type: image/png\r\n\r\n`,
        ].join('\r\n'),
      ),
      main,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      reference,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await server.inject({
      method: 'POST',
      url: '/images/edits',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      prompt: 'make it brighter, style: vivid',
      n: 1,
      partial_images: 0,
      quality: 'hd',
      size: '16:9',
      stream: true,
      image: {
        data: main.toString('base64'),
        filename: 'main.png',
        mimeType: 'image/png',
      },
      reference_images: [
        {
          data: reference.toString('base64'),
          filename: 'reference.jpg',
          mimeType: 'image/jpeg',
        },
      ],
    });
  });

  it('maps the Gemini 1K multipart image size to low quality', async () => {
    const server = Fastify();
    servers.push(server);
    await server.register(fastifyMultipart);
    server.post('/images/edits', async (request) => parseImageMultipartRequest(request));

    const boundary = '----antigravity-image-size';
    const image = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);
    const payload = Buffer.concat([
      Buffer.from(
        [
          `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit`,
          `--${boundary}\r\nContent-Disposition: form-data; name="image_size"\r\n\r\n1K`,
          `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="main.png"\r\nContent-Type: image/png\r\n\r\n`,
        ].join('\r\n'),
      ),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await server.inject({
      method: 'POST',
      url: '/images/edits',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ quality: 'low' });
  });
});
