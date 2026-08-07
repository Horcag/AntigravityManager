import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { OPENAI_JSON_BODY_LIMIT_BYTES } from '@/modules/proxy-gateway/server/modules/openai/media/openai-media-request-contract';
import { ANTHROPIC_MESSAGES_BODY_LIMIT_BYTES } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic-request-contract';
import { applyProxyRouteBodyLimit, resolveProxyRouteBodyLimit } from '@/server/proxy-body-limit';

describe('proxy route body limits', () => {
  const servers: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it.each([
    '/v1/chat/completions',
    '/v1/responses',
    '/v1/images/generations',
    '/v1/images/edits',
    '/v1/audio/transcriptions',
    '/v1beta/models/:model:generateContent',
    '/v1beta/models/:model:streamGenerateContent',
  ])('assigns the large inline-media envelope only to %s', (url) => {
    expect(resolveProxyRouteBodyLimit('POST', url)).toBe(OPENAI_JSON_BODY_LIMIT_BYTES);
  });

  it("uses Anthropic's 32 MiB Messages request envelope", () => {
    expect(resolveProxyRouteBodyLimit('POST', '/v1/messages')).toBe(
      ANTHROPIC_MESSAGES_BODY_LIMIT_BYTES,
    );
  });

  it('leaves unrelated and read-only routes at the Fastify default', () => {
    expect(resolveProxyRouteBodyLimit('POST', '/v1/completions')).toBeUndefined();
    expect(resolveProxyRouteBodyLimit('POST', '/internal/config')).toBeUndefined();
    expect(resolveProxyRouteBodyLimit('GET', '/v1/images/edits')).toBeUndefined();
  });

  it('keeps large JSON accepted on media routes while unrelated routes remain capped', async () => {
    const server = Fastify();
    servers.push(server);
    server.addHook('onRoute', applyProxyRouteBodyLimit);
    server.post('/v1/images/edits', async () => ({ ok: true }));
    server.post('/internal/config', async () => ({ ok: true }));
    await server.ready();
    const payload = { data: 'x'.repeat(1024 * 1024 + 1) };

    const media = await server.inject({ method: 'POST', payload, url: '/v1/images/edits' });
    const unrelated = await server.inject({ method: 'POST', payload, url: '/internal/config' });

    expect(media.statusCode).toBe(200);
    expect(unrelated.statusCode).toBe(413);
  });
});
