import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { V1InternalPassthroughService } from '@/modules/proxy-gateway/server/modules/v1internal-passthrough/v1internal-passthrough.service';

const ENABLE_ENV = 'AGM_V1INTERNAL_PASSTHROUGH';

const ACCOUNT: CloudAccount = {
  id: 'account-1',
  provider: 'google',
  email: 'probe@example.test',
  token: {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    expiry_timestamp: 4_000_000_000,
    token_type: 'Bearer',
    upstream_proxy_url: 'http://proxy.test',
  },
  created_at: 0,
  last_used: 0,
};

afterEach(() => {
  delete process.env[ENABLE_ENV];
  vi.restoreAllMocks();
  vi.resetModules();
});

async function createPassthroughApp(enabled: boolean, forward: ReturnType<typeof vi.fn>) {
  if (enabled) {
    process.env[ENABLE_ENV] = '1';
  } else {
    delete process.env[ENABLE_ENV];
  }
  vi.resetModules();

  const { getV1InternalPassthroughControllers, V1InternalPassthroughService: Service } =
    await import('@/modules/proxy-gateway/server/modules/v1internal-passthrough/v1internal-passthrough.module');

  @Module({
    controllers: getV1InternalPassthroughControllers(),
    providers: [
      { provide: Service, useValue: { forward } },
      { provide: ProxyGuard, useValue: { canActivate: () => true } },
    ],
  })
  class PassthroughTestModule {}

  const app = await NestFactory.create<NestFastifyApplication>(
    PassthroughTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('v1internal diagnostic passthrough', () => {
  it('does not register a route unless enabled at startup', async () => {
    const app = await createPassthroughApp(false, vi.fn());

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1internal/generateChat',
        payload: { request: { prompt: 'probe' } },
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns upstream status, selected account, headers, and raw response text', async () => {
    const forward = vi.fn().mockResolvedValue({
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
      body: '{"error":{"code":429,"message":"quota exhausted"}}',
      accountId: ACCOUNT.id,
      accountEmail: ACCOUNT.email,
    });
    const app = await createPassthroughApp(true, forward);
    const body = { request: { prompt: 'probe', nested: [1, { keep: true }] } };

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1internal/generateChat',
        payload: body,
      });

      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('30');
      expect(response.headers['x-antigravity-v1internal-account-id']).toBe(ACCOUNT.id);
      expect(response.headers['x-antigravity-v1internal-account-email']).toBe(ACCOUNT.email);
      expect(response.body).toBe('{"error":{"code":429,"message":"quota exhausted"}}');
      expect(forward).toHaveBeenCalledWith('generateChat', body);
    } finally {
      await app.close();
    }
  });

  it('forwards the body and selected account credentials through the authorised client', async () => {
    const accountLeaseService = Object.create(AccountLeaseService.prototype) as AccountLeaseService;
    accountLeaseService.getNextToken = vi.fn().mockResolvedValue(ACCOUNT);
    const geminiClient = Object.create(GeminiClient.prototype) as GeminiClient;
    geminiClient.postV1InternalRaw = vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-goog-request-id': 'request-1' },
      body: '{"response":{"answer":"ok"}}',
    });
    const service = new V1InternalPassthroughService(accountLeaseService, geminiClient);
    const body = { request: { keep: ['this', { object: true }] } };

    await expect(service.forward('completeCode', body)).resolves.toEqual({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-goog-request-id': 'request-1' },
      body: '{"response":{"answer":"ok"}}',
      accountId: ACCOUNT.id,
      accountEmail: ACCOUNT.email,
    });
    expect(geminiClient.postV1InternalRaw).toHaveBeenCalledWith(
      'completeCode',
      body,
      ACCOUNT.token.access_token,
      ACCOUNT.token.upstream_proxy_url,
    );
  });

  it('keeps an upstream rejection as a raw response instead of throwing it away', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 400,
      headers: { 'content-type': 'application/json', 'x-goog-request-id': 'request-2' },
      data: '{"error":{"code":400,"message":"unsupported verb"}}',
    } as never);
    const client = new GeminiClient();
    const body = { request: { keep: 'verbatim' } };

    await expect(client.postV1InternalRaw('transformCode', body, 'access-token')).resolves.toEqual({
      status: 400,
      headers: { 'content-type': 'application/json', 'x-goog-request-id': 'request-2' },
      body: '{"error":{"code":400,"message":"unsupported verb"}}',
    });
    expect(post).toHaveBeenCalledWith(
      'https://cloudcode-pa.googleapis.com/v1internal:transformCode',
      JSON.stringify(body),
      expect.objectContaining({
        responseType: 'text',
        validateStatus: expect.any(Function),
      }),
    );
  });
});
