/**
 * `Content-Type: application/json` with an empty body (kanban #54).
 *
 * Measured live on 0.19.31-local1: `DELETE /v1/responses/{id}` and
 * `DELETE /v1/model-routes/miss-journal` answered 200 without the header and
 * 400 `Body cannot be empty when content-type is set to 'application/json'`
 * with it. That is Fastify's default JSON parser, not a handler, but any client
 * that sets a JSON content type on every request sees a broken endpoint.
 *
 * The parser override is exercised through the conformance harness, which
 * registers exactly what `main.ts` registers at boot.
 */
import { Body, Controller, Delete, HttpStatus, Module, Post, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerProxyBodyParsers } from '@/server/proxy-body-parsers';
import { createProxyConformanceApp } from '../support/proxy-conformance-harness';

const JSON_CONTENT_TYPE = { 'content-type': 'application/json' };

const proxyService = {
  handleAnthropicCountTokens: vi.fn(),
  handleAnthropicMessages: vi.fn(),
  handleChatCompletions: vi.fn(),
  handleGeminiCountTokens: vi.fn(),
  handleGeminiGenerateContent: vi.fn(),
  handleGeminiStreamGenerateContent: vi.fn(),
};

describe('empty JSON body handling (kanban #54)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createProxyConformanceApp({ proxyService });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('methods that carry no payload accept an empty body', () => {
    it('DELETE /v1/model-routes/miss-journal answers the same with and without the header', async () => {
      const withHeader = await app.inject({
        method: 'DELETE',
        url: '/v1/model-routes/miss-journal',
        headers: JSON_CONTENT_TYPE,
      });
      const withoutHeader = await app.inject({
        method: 'DELETE',
        url: '/v1/model-routes/miss-journal',
      });

      expect(withHeader.statusCode).toBe(200);
      expect(withHeader.statusCode).toBe(withoutHeader.statusCode);
      expect(withHeader.json()).toEqual(withoutHeader.json());
    });

    it('DELETE /v1/responses/{id} reaches its handler instead of failing to parse', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/responses/resp_missing',
        headers: JSON_CONTENT_TYPE,
      });

      // The handler's own 404 for an id the store never issued — not the
      // parser's 400.
      expect(response.statusCode).toBe(404);
      expect(response.json().error?.message).not.toContain('Body cannot be empty');
    });

    it('DELETE /v1/files/{id} accepts the header on a route that serves both dialects', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/files/file-does-not-exist',
        headers: JSON_CONTENT_TYPE,
      });

      expect(response.statusCode).toBe(404);
    });

    it('still parses a JSON body when a bodyless method does send one', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/model-routes/miss-journal',
        headers: JSON_CONTENT_TYPE,
        payload: '{"unused":true}',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('methods that do carry a payload still reject an empty body', () => {
    it('POST /v1/chat/completions keeps failing on an empty JSON body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: JSON_CONTENT_TYPE,
        payload: '',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Body cannot be empty');
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    });

    it('POST /v1/messages keeps failing on an empty JSON body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: JSON_CONTENT_TYPE,
        payload: '',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Body cannot be empty');
    });

    it('POST still rejects malformed JSON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: JSON_CONTENT_TYPE,
        payload: '{"model":',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});

/**
 * The parser replaces the one `@nestjs/platform-fastify` installs, so it can
 * only be registered between `init()` and `listen()`. Registering it earlier
 * makes Nest's own registration throw, and later Fastify refuses to change the
 * parser table at all — either way the server would fail to boot. This drives
 * the sequence `main.ts` uses through a real `listen()`.
 */
describe('the boot sequence bootstrapNestServer uses', () => {
  let app: NestFastifyApplication;

  @Controller('v1')
  class BootProbeController {
    @Delete('probe')
    remove(@Res() res: FastifyReply): void {
      res.status(HttpStatus.OK).send({ deleted: true });
    }

    @Post('probe')
    create(@Body() body: unknown, @Res() res: FastifyReply): void {
      res.status(HttpStatus.OK).send({ body });
    }
  }

  @Module({ controllers: [BootProbeController] })
  class BootProbeModule {}

  beforeAll(async () => {
    const adapter = new FastifyAdapter();
    app = await NestFactory.create<NestFastifyApplication>(BootProbeModule, adapter, {
      logger: false,
    });
    app.enableCors();
    await app.init();
    registerProxyBodyParsers(adapter.getInstance());
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('starts listening with the replaced parser in place', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/probe',
      headers: JSON_CONTENT_TYPE,
    });

    expect(response.statusCode).toBe(200);
  });

  it('leaves POST parsing alone on the same instance', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/v1/probe',
      headers: JSON_CONTENT_TYPE,
      payload: '',
    });
    const parsed = await app.inject({
      method: 'POST',
      url: '/v1/probe',
      headers: JSON_CONTENT_TYPE,
      payload: '{"model":"gemini-3-flash"}',
    });

    expect(empty.statusCode).toBe(400);
    expect(parsed.statusCode).toBe(200);
    expect(parsed.json().body).toEqual({ model: 'gemini-3-flash' });
  });
});
