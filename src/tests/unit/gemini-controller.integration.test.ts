import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { of, throwError } from 'rxjs';

import { GeminiController } from '../../modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { UpstreamRequestError } from '../../modules/proxy-gateway/server/common/exceptions/upstream-request-exception';
import { ModelRouteError } from '../../modules/proxy-gateway/server/common/exceptions/model-route-exception';
import { attachModelRouteMetadata } from '../../modules/proxy-gateway/server/common/model-route-metadata';
import { attachUpstreamResponseMetadata } from '../../modules/proxy-gateway/server/common/upstream-response-metadata';
import type { CatalogModelRoleIndex } from '../../modules/proxy-gateway/antigravity/ModelMapping';

describe('GeminiController Integration (Fastify Injection Wire Suite)', () => {
  let app: NestFastifyApplication;

  const mockProxyService = {
    handleGeminiCountTokens: vi.fn(),
    handleGeminiGenerateContent: vi.fn(),
    handleGeminiStreamGenerateContent: vi.fn(),
  };

  const mockAccountLeaseService = {
    getAllCollectedModels: vi.fn(
      () => new Set(['gemini-3-flash', 'gemini-3.1-pro-high', 'gemini-3.5-flash-extra-low']),
    ),
    getCatalogModelRoleIndex: vi.fn<() => CatalogModelRoleIndex | undefined>(() => undefined),
  };

  beforeAll(async () => {
    @Module({
      controllers: [GeminiController],
      providers: [
        { provide: ProxyService, useValue: mockProxyService },
        { provide: AccountLeaseService, useValue: mockAccountLeaseService },
      ],
    })
    class TestGeminiModule {}

    app = await NestFactory.create<NestFastifyApplication>(TestGeminiModule, new FastifyAdapter(), {
      logger: false,
    });

    // Bypass ProxyGuard authentication for routing/serialization tests
    app.useGlobalGuards({
      canActivate: () => true,
    });

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /v1beta/models returns dynamic model list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'models/gemini-3-flash',
          // `batchGenerateContent` is advertised because the local batch runner
          // genuinely serves it; see section 11 of the server README.
          supportedGenerationMethods: [
            'countTokens',
            'generateContent',
            'streamGenerateContent',
            'batchGenerateContent',
          ],
        }),
        expect.objectContaining({
          name: 'models/gemini-3.1-pro-high',
        }),
      ]),
    );
    expect(body.models).toHaveLength(3);
    expect(body.models).not.toContainEqual(
      expect.objectContaining({ name: 'models/claude-opus-4-6-thinking' }),
    );
  });

  it('GET /v1beta/models excludes provider-advertised non-chat service ids', async () => {
    mockAccountLeaseService.getAllCollectedModels.mockReturnValueOnce(
      new Set(['gemini-3-flash', 'chat_20706', 'tab_flash_lite_preview', 'chat_23310']),
    );
    mockAccountLeaseService.getCatalogModelRoleIndex.mockReturnValueOnce({
      nonChatRoles: new Map(),
      chatModelIds: new Set(),
      hasChatRoleData: true,
      completionFlags: new Map([
        ['chat_20706', ['requiresLeadInGeneration', 'supportsCumulativeContext']],
        ['chat_23310', ['requiresLeadInGeneration']],
        ['tab_flash_lite_preview', ['supportsEstimateTokenCounter']],
      ]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.models).toEqual([expect.objectContaining({ name: 'models/gemini-3-flash' })]);
    expect(body.models).not.toContainEqual(expect.objectContaining({ name: 'models/chat_20706' }));
    expect(body.models).not.toContainEqual(
      expect.objectContaining({ name: 'models/tab_flash_lite_preview' }),
    );
  });

  it('GET /v1beta/models keeps ids the provider assigned to a non-chat role', async () => {
    mockAccountLeaseService.getAllCollectedModels.mockReturnValueOnce(
      new Set(['gemini-3-flash', 'tab_lite_preview']),
    );
    mockAccountLeaseService.getCatalogModelRoleIndex.mockReturnValueOnce({
      nonChatRoles: new Map([
        ['gemini-3-flash', ['command']],
        ['tab_lite_preview', ['tab']],
      ]),
      chatModelIds: new Set(['gemini-3-pro']),
      hasChatRoleData: true,
      completionFlags: new Map(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1beta/models',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([
      expect.objectContaining({ name: 'models/gemini-3-flash' }),
      expect.objectContaining({ name: 'models/tab_lite_preview' }),
    ]);
  });

  it('returns native Gemini model route identity headers', async () => {
    mockProxyService.handleGeminiGenerateContent.mockResolvedValueOnce(
      attachModelRouteMetadata(
        { candidates: [], modelVersion: 'gemini-3-flash-001' },
        {
          requestedModel: 'models/my-fast',
          resolvedModel: 'gemini-3-flash',
          servedModel: 'gemini-3-flash-001',
          routeSource: 'configured',
        },
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/my-fast:generateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-antigravity-requested-model']).toBe('models/my-fast');
    expect(res.headers['x-antigravity-resolved-model']).toBe('gemini-3-flash');
    expect(res.headers['x-antigravity-served-model']).toBe('gemini-3-flash-001');
    expect(res.headers['x-antigravity-fallback-policy']).toBe('none');
  });

  it('returns the upstream traceId as a correlation header', async () => {
    mockProxyService.handleGeminiGenerateContent.mockResolvedValueOnce(
      attachUpstreamResponseMetadata(
        attachModelRouteMetadata(
          { candidates: [], modelVersion: 'gemini-3-flash-001' },
          {
            requestedModel: 'models/gemini-3-flash',
            resolvedModel: 'gemini-3-flash',
            servedModel: 'gemini-3-flash-001',
            routeSource: 'configured',
          },
        ),
        { traceId: 'trace-abc123', remainingCredits: [] },
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:generateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-antigravity-trace-id']).toBe('trace-abc123');
    expect(res.headers['x-antigravity-resolved-model']).toBe('gemini-3-flash');
    expect(res.json()).not.toHaveProperty('traceId');
  });

  it('returns a Google-shaped unknown model error', async () => {
    mockProxyService.handleGeminiGenerateContent.mockRejectedValueOnce(
      new ModelRouteError({
        message: "Unknown model 'not-a-model'",
        status: 404,
        code: 'model_not_found',
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/not-a-model:generateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 404,
        message: "Unknown model 'not-a-model'",
        status: 'NOT_FOUND',
      },
    });
  });

  it('GET /v1beta/models/:model returns model detail or 404', async () => {
    const resFound = await app.inject({
      method: 'GET',
      url: '/v1beta/models/gemini-3-flash',
    });
    expect(resFound.statusCode).toBe(200);
    expect(resFound.json()).toMatchObject({
      name: 'models/gemini-3-flash',
      displayName: 'gemini-3-flash',
    });

    const resNotFound = await app.inject({
      method: 'GET',
      url: '/v1beta/models/unknown-model-xyz',
    });
    expect(resNotFound.statusCode).toBe(404);
    expect(resNotFound.json()).toEqual({
      error: {
        code: 404,
        message: 'models/unknown-model-xyz is not found',
        status: 'NOT_FOUND',
      },
    });
  });

  it.each([
    '/v1beta/models/gemini-3-flash/countTokens',
    '/v1beta/models/gemini-3-flash:countTokens',
  ])('POST %s returns the public countTokens envelope and route identity', async (url) => {
    mockProxyService.handleGeminiCountTokens.mockResolvedValueOnce(
      attachModelRouteMetadata(
        { totalTokens: 31 },
        {
          requestedModel: 'models/gemini-3-flash',
          resolvedModel: 'gemini-3-flash',
          servedModel: 'gemini-3-flash-001',
          routeSource: 'canonical',
        },
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url,
      payload: { contents: [{ role: 'user', parts: [{ text: 'count me' }] }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ totalTokens: 31 });
    expect(res.headers['x-antigravity-served-model']).toBe('gemini-3-flash-001');
    expect(mockProxyService.handleGeminiCountTokens).toHaveBeenCalledWith('models/gemini-3-flash', [
      { role: 'user', parts: [{ text: 'count me' }] },
    ]);
  });

  it('accepts the generateContentRequest wrapper and rejects a body without contents', async () => {
    mockProxyService.handleGeminiCountTokens.mockResolvedValueOnce({ totalTokens: 9 });
    const resWrapped = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:countTokens',
      payload: {
        generateContentRequest: { contents: [{ role: 'user', parts: [{ text: 'wrapped' }] }] },
      },
    });
    expect(resWrapped.statusCode).toBe(200);
    expect(resWrapped.json()).toEqual({ totalTokens: 9 });

    const resEmpty = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:countTokens',
      payload: {},
    });
    expect(resEmpty.statusCode).toBe(400);
    expect(resEmpty.json()).toEqual({
      error: {
        code: 400,
        message: 'countTokens requires contents or generateContentRequest.contents',
        status: 'INVALID_ARGUMENT',
      },
    });
  });

  it('returns 404 NOT_FOUND when countTokens targets an unrouted model', async () => {
    mockProxyService.handleGeminiCountTokens.mockRejectedValueOnce(
      new ModelRouteError({
        message: "Unknown model 'not-a-model'",
        status: 404,
        code: 'model_not_found',
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/not-a-model:countTokens',
      payload: { contents: [{ role: 'user', parts: [{ text: 'count me' }] }] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 404,
        message: "Unknown model 'not-a-model'",
        status: 'NOT_FOUND',
      },
    });
  });

  it('surfaces a missing upstream totalTokens as an error instead of a zero count', async () => {
    mockProxyService.handleGeminiCountTokens.mockRejectedValueOnce(
      new UpstreamRequestError({
        message: 'Upstream countTokens response did not include a usable totalTokens value',
        status: 502,
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:countTokens',
      payload: { contents: [{ role: 'user', parts: [{ text: 'count me' }] }] },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: {
        code: 502,
        message: 'Upstream countTokens response did not include a usable totalTokens value',
        status: 'INTERNAL',
      },
    });
  });

  it('POST /v1beta/models/:model:embedContent returns 501 UNIMPLEMENTED', async () => {
    const resEmbed = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:embedContent',
      payload: { contents: [{ role: 'user', parts: [{ text: 'test' }] }] },
    });
    expect(resEmbed.statusCode).toBe(501);
    expect(resEmbed.json()).toEqual({
      error: {
        code: 501,
        message: 'embedContent is not implemented by this provider',
        status: 'UNIMPLEMENTED',
      },
    });
  });

  it('rejects top-level cachedContent, serviceTier, and store with 501 UNIMPLEMENTED', async () => {
    const resCached = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:generateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        cachedContent: 'cachedContents/123',
      },
    });
    expect(resCached.statusCode).toBe(501);
    expect(resCached.json().error.message).toContain("Field 'cachedContent'");

    const resServiceTier = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:generateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        serviceTier: 'flex',
      },
    });
    expect(resServiceTier.statusCode).toBe(501);
    expect(resServiceTier.json().error.message).toContain("Field 'serviceTier'");

    const resStore = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:generateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        store: true,
      },
    });
    expect(resStore.statusCode).toBe(501);
    expect(resStore.json().error.message).toContain("Field 'store'");
  });

  it('returns 400 INVALID_ARGUMENT when systemInstruction cannot be represented as text-only', async () => {
    const resInvalidSystem = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:generateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction: {
          parts: [{ text: 'valid', inlineData: { mimeType: 'image/png', data: 'xyz' } }],
        },
      },
    });
    expect(resInvalidSystem.statusCode).toBe(400);
    expect(resInvalidSystem.json()).toEqual({
      error: {
        code: 400,
        message: 'systemInstruction contains non-text fields unsupported by this provider',
        status: 'INVALID_ARGUMENT',
      },
    });
  });

  it('handles generateContent losslessly preserving candidate logprobs, version and responseId', async () => {
    mockProxyService.handleGeminiGenerateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hello world' }] },
          finishReason: 'STOP',
          index: 0,
          avgLogprobs: -0.05,
          safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' }],
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 2,
        totalTokenCount: 7,
      },
      modelVersion: 'gemini-3-flash',
      responseId: 'resp_abc123',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:generateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hello world' }] },
          finishReason: 'STOP',
          index: 0,
          avgLogprobs: -0.05,
          safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' }],
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 2,
        totalTokenCount: 7,
      },
      modelVersion: 'gemini-3-flash',
      responseId: 'resp_abc123',
    });
  });

  it('redacts private identifiers and project IDs in upstream Google errors while preserving status and Retry-After', async () => {
    mockProxyService.handleGeminiGenerateContent.mockRejectedValueOnce(
      new UpstreamRequestError({
        message: 'Quota exceeded for project 998877',
        status: 429,
        headers: { retryAfter: '45' },
        body: JSON.stringify({
          error: {
            code: 429,
            message: 'Quota exceeded for project 998877 on account test@domain.com',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:generateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('45');
    const body = res.json();
    expect(body.error.code).toBe(429);
    expect(body.error.status).toBe('RESOURCE_EXHAUSTED');
    expect(body.error.message).not.toContain('998877');
    expect(body.error.message).not.toContain('test@domain.com');
    expect(body.error.message).toContain('project [REDACTED]');
    expect(body.error.message).toContain('[REDACTED_EMAIL]');
  });

  it('handles streamGenerateContent action and returns event-stream header', async () => {
    const sseStream = of('data: {"candidates":[{"content":{"parts":[{"text":"chunk"}]}}]}\n\n');
    mockProxyService.handleGeminiStreamGenerateContent.mockResolvedValueOnce(sseStream);

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:streamGenerateContent',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain(
      'data: {"candidates":[{"content":{"parts":[{"text":"chunk"}]}}]}',
    );
  });

  it('keeps the Gemini error envelope after SSE headers and redacts secrets', async () => {
    mockProxyService.handleGeminiStreamGenerateContent.mockResolvedValueOnce(
      throwError(
        () =>
          new UpstreamRequestError({
            message: 'Bearer abc/def+ghi= for account acc-123 failed',
            status: 503,
            body: JSON.stringify({
              error: {
                message: 'Bearer abc/def+ghi= for account acc-123 failed',
                status: 'UNAVAILABLE',
              },
            }),
          }),
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
      payload: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('"status":"UNAVAILABLE"');
    expect(res.payload).toContain('[REDACTED_TOKEN]');
    expect(res.payload).toContain('account [REDACTED]');
    expect(res.payload).not.toContain('abc/def+ghi=');
    expect(res.payload).not.toContain('acc-123');
  });
});
