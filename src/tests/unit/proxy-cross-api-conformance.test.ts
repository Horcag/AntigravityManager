import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { of } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelRouteError } from '@/modules/proxy-gateway/server/common/exceptions/model-route-exception';
import { attachModelRouteMetadata } from '@/modules/proxy-gateway/server/common/model-route-metadata';
import {
  createAccountLeaseTokenFixture,
  createProxyConformanceApp,
} from '../support/proxy-conformance-harness';
import { parseSseEvents } from '../support/http-payloads';

const proxyService = {
  handleAnthropicMessages: vi.fn(),
  handleChatCompletions: vi.fn(),
  handleGeminiGenerateContent: vi.fn(),
  handleGeminiStreamGenerateContent: vi.fn(),
};

function routeMetadata(protocol: string) {
  return {
    requestedModel: `public-${protocol}`,
    resolvedModel: `resolved-${protocol}`,
    servedModel: `physical-${protocol}`,
    routeSource: 'configured',
  };
}

function expectRouteHeaders(
  response: { headers: Record<string, number | string | string[] | undefined> },
  protocol: string,
) {
  expect(response.headers['x-antigravity-requested-model']).toBe(`public-${protocol}`);
  expect(response.headers['x-antigravity-resolved-model']).toBe(`resolved-${protocol}`);
  expect(response.headers['x-antigravity-served-model']).toBe(`physical-${protocol}`);
  expect(response.headers['x-antigravity-route-source']).toBe('configured');
  expect(response.headers['x-antigravity-fallback-policy']).toBe('none');
}

describe('assembled proxy cross-API conformance', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createProxyConformanceApp({
      proxyService,
      accountTokens: [
        createAccountLeaseTokenFixture({
          model_quotas: {
            'public-anthropic': 100,
            'public-gemini': 100,
            'public-openai': 100,
          },
        }),
      ],
    });
  });

  beforeEach(() => {
    for (const handler of Object.values(proxyService)) {
      handler.mockReset();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    {
      protocol: 'openai',
      configure: () =>
        proxyService.handleChatCompletions.mockResolvedValueOnce(
          attachModelRouteMetadata(
            {
              id: 'chatcmpl-conformance',
              object: 'chat.completion',
              created: 1_900_000_000,
              model: 'physical-openai',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'openai-ok' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
            routeMetadata('openai'),
          ),
        ),
      request: {
        method: 'POST' as const,
        url: '/v1/chat/completions',
        payload: {
          model: 'public-openai',
          messages: [{ role: 'user', content: 'hello' }],
        },
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({ object: 'chat.completion', model: 'physical-openai' });
      },
    },
    {
      protocol: 'anthropic',
      configure: () =>
        proxyService.handleAnthropicMessages.mockResolvedValueOnce(
          attachModelRouteMetadata(
            {
              id: 'msg_conformance',
              type: 'message',
              role: 'assistant',
              model: 'physical-anthropic',
              content: [{ type: 'text', text: 'anthropic-ok' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            routeMetadata('anthropic'),
          ),
        ),
      request: {
        method: 'POST' as const,
        url: '/v1/messages',
        payload: {
          model: 'public-anthropic',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        },
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({ type: 'message', model: 'physical-anthropic' });
      },
    },
    {
      protocol: 'gemini',
      configure: () =>
        proxyService.handleGeminiGenerateContent.mockResolvedValueOnce(
          attachModelRouteMetadata(
            {
              candidates: [
                { content: { role: 'model', parts: [{ text: 'gemini-ok' }] }, index: 0 },
              ],
              modelVersion: 'physical-gemini',
            },
            routeMetadata('gemini'),
          ),
        ),
      request: {
        method: 'POST' as const,
        url: '/v1beta/models/public-gemini:generateContent',
        payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({ modelVersion: 'physical-gemini' });
      },
    },
  ])('$protocol preserves its non-stream envelope and route identity', async (testCase) => {
    testCase.configure();
    const response = await app.inject(testCase.request);

    expect(response.statusCode).toBe(200);
    expectRouteHeaders(response, testCase.protocol);
    testCase.assertBody(response.json());
  });

  it.each([
    {
      protocol: 'openai',
      configure: () =>
        proxyService.handleChatCompletions.mockResolvedValueOnce(
          attachModelRouteMetadata(
            of(
              `data: ${JSON.stringify({
                id: 'chatcmpl-stream',
                object: 'chat.completion.chunk',
                model: 'physical-openai',
                choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }],
              })}\n\n`,
              'data: [DONE]\n\n',
            ),
            routeMetadata('openai'),
          ),
        ),
      request: {
        method: 'POST' as const,
        url: '/v1/chat/completions',
        payload: {
          model: 'public-openai',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        },
      },
      assertEvents: (events: ReturnType<typeof parseSseEvents>) => {
        expect(JSON.parse(events[0].data)).toMatchObject({
          object: 'chat.completion.chunk',
          model: 'physical-openai',
        });
        expect(events.at(-1)?.data).toBe('[DONE]');
      },
    },
    {
      protocol: 'anthropic',
      configure: () =>
        proxyService.handleAnthropicMessages.mockResolvedValueOnce(
          attachModelRouteMetadata(
            of(
              `event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: { id: 'msg_stream', model: 'physical-anthropic' },
              })}\n\n`,
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ),
            routeMetadata('anthropic'),
          ),
        ),
      request: {
        method: 'POST' as const,
        url: '/v1/messages',
        payload: {
          model: 'public-anthropic',
          max_tokens: 64,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        },
      },
      assertEvents: (events: ReturnType<typeof parseSseEvents>) => {
        expect(events.map((event) => event.event)).toEqual(['message_start', 'message_stop']);
        expect(events.some((event) => event.data === '[DONE]')).toBe(false);
      },
    },
    {
      protocol: 'gemini',
      configure: () =>
        proxyService.handleGeminiStreamGenerateContent.mockResolvedValueOnce(
          attachModelRouteMetadata(
            of(
              `data: ${JSON.stringify({
                candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, index: 0 }],
                modelVersion: 'physical-gemini',
              })}\n\n`,
            ),
            routeMetadata('gemini'),
          ),
        ),
      request: {
        method: 'POST' as const,
        url: '/v1beta/models/public-gemini:streamGenerateContent',
        payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      },
      assertEvents: (events: ReturnType<typeof parseSseEvents>) => {
        expect(events).toHaveLength(1);
        expect(events[0].event).toBeUndefined();
        expect(JSON.parse(events[0].data)).toMatchObject({ modelVersion: 'physical-gemini' });
      },
    },
  ])('$protocol preserves its SSE wire contract', async (testCase) => {
    testCase.configure();
    const response = await app.inject(testCase.request);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expectRouteHeaders(response, testCase.protocol);
    testCase.assertEvents(parseSseEvents(response.body));
  });

  it.each([
    {
      protocol: 'openai',
      configure: (error: ModelRouteError) =>
        proxyService.handleChatCompletions.mockRejectedValueOnce(error),
      request: {
        method: 'POST' as const,
        url: '/v1/chat/completions',
        payload: {
          model: 'missing-openai',
          messages: [{ role: 'user', content: 'hello' }],
        },
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toEqual({
          error: {
            message: "Unknown model 'missing-openai'",
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
          },
        });
      },
    },
    {
      protocol: 'anthropic',
      configure: (error: ModelRouteError) =>
        proxyService.handleAnthropicMessages.mockRejectedValueOnce(error),
      request: {
        method: 'POST' as const,
        url: '/v1/messages',
        payload: {
          model: 'missing-anthropic',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        },
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          type: 'error',
          error: { type: 'not_found_error', message: "Unknown model 'missing-anthropic'" },
          request_id: expect.stringMatching(/^req_/u),
        });
      },
    },
    {
      protocol: 'gemini',
      configure: (error: ModelRouteError) =>
        proxyService.handleGeminiGenerateContent.mockRejectedValueOnce(error),
      request: {
        method: 'POST' as const,
        url: '/v1beta/models/missing-gemini:generateContent',
        payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      },
      assertBody: (body: Record<string, unknown>) => {
        expect(body).toEqual({
          error: {
            code: 404,
            message: "Unknown model 'missing-gemini'",
            status: 'NOT_FOUND',
          },
        });
      },
    },
  ])('$protocol returns its native unknown-model error envelope', async (testCase) => {
    testCase.configure(
      new ModelRouteError({
        message: `Unknown model 'missing-${testCase.protocol}'`,
        status: 404,
        code: 'model_not_found',
      }),
    );
    const response = await app.inject(testCase.request);

    expect(response.statusCode).toBe(404);
    testCase.assertBody(response.json());
  });
});
