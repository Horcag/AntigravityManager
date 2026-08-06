import { Module, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import { getServerConfig } from '../../server/server-config';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/account-lease.service';
import { ProxyController } from '../../modules/proxy-gateway/server/proxy.controller';
import { UpstreamRequestError } from '../../modules/proxy-gateway/server/clients/upstream-error';
import { GeminiController } from '../../modules/proxy-gateway/server/gemini.controller';
import { ProxyGuard } from '../../modules/proxy-gateway/server/proxy.guard';
import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';
import {
  AccountPoolUnavailableException,
  mapOpenAIProtocolError,
  ProxyProtocolExceptionFilter,
} from '../../modules/proxy-gateway/server/openai-protocol-error';

vi.mock('../../server/server-config', () => ({
  getServerConfig: vi.fn(),
}));

afterEach(() => {
  vi.mocked(getServerConfig).mockReset();
});

function createReplyMock() {
  const reply: Record<string, any> = {};
  reply.status = vi.fn(() => reply);
  reply.type = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

async function createHttpApp(proxyService: object) {
  @Module({
    controllers: [ProxyController, GeminiController],
    providers: [
      ProxyGuard,
      { provide: ProxyService, useValue: proxyService },
      { provide: AccountLeaseService, useValue: { getAllCollectedModels: () => new Set() } },
    ],
  })
  class HttpTestModule {}

  const app = await NestFactory.create(HttpTestModule, new FastifyAdapter(), { logger: false });
  await app.init();
  return app;
}

describe('ProxyController Integration', () => {
  it('rejects null and non-object JSON bodies through the assembled Fastify pipeline', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
      handleGeminiGenerateContent: vi.fn(),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    };
    const expectedError = {
      error: {
        message: 'request body must be a JSON object',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    };

    try {
      for (const url of [
        '/v1/chat/completions',
        '/v1/completions',
        '/v1/responses',
        '/v1/images/generations',
        '/v1/images/edits',
        '/v1/audio/transcriptions',
      ]) {
        for (const payload of ['null', '[]']) {
          const response = await server.inject({
            method: 'POST',
            url,
            headers,
            payload,
          });
          expect(response.statusCode, `expected 400 for ${url} with ${payload}`).toBe(400);
          expect(response.json()).toEqual(expectedError);
        }
      }
      for (const url of ['/v1/images/edits', '/v1/audio/transcriptions']) {
        const response = await server.inject({
          method: 'POST',
          url,
          headers,
          payload: '"not-an-object"',
        });
        expect(response.statusCode, `expected 400 for ${url} with a scalar`).toBe(400);
        expect(response.json()).toEqual(expectedError);
      }
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
      expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects invalid OpenAI limits, control fields, and image models before upstream calls', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      [
        '/v1/chat/completions',
        { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 0 },
        'max_tokens',
        'max_tokens must be a positive integer',
      ],
      [
        '/v1/chat/completions',
        {
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'hi' }],
          max_completion_tokens: 1.5,
        },
        'max_completion_tokens',
        'max_completion_tokens must be a positive integer',
      ],
      [
        '/v1/chat/completions',
        { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hi' }], stream: 'false' },
        'stream',
        'stream must be a boolean',
      ],
      [
        '/v1/completions',
        { model: 'gemini-3-flash', prompt: 'hi', max_tokens: 0 },
        'max_tokens',
        'max_tokens must be a positive integer',
      ],
      [
        '/v1/completions',
        { model: 'gemini-3-flash', prompt: 'hi', stream: 'false' },
        'stream',
        'stream must be a boolean',
      ],
      [
        '/v1/responses',
        { model: 'gemini-3-flash', input: 'hi', max_output_tokens: 1.5 },
        'max_output_tokens',
        'max_output_tokens must be a positive integer',
      ],
      [
        '/v1/responses',
        { model: 'gemini-3-flash', input: 'hi', stream: 'false' },
        'stream',
        'stream must be a boolean',
      ],
      [
        '/v1/responses',
        { model: 'gemini-3-flash', input: 'hi', temperature: 3 },
        'temperature',
        'temperature must be between 0 and 2',
      ],
      [
        '/v1/responses',
        { model: 'gemini-3-flash', input: 'hi', top_p: -0.1 },
        'top_p',
        'top_p must be between 0 and 1',
      ],
      [
        '/v1/images/generations',
        { model: ' ', prompt: 'draw a cat' },
        'model',
        'model is required',
      ],
      [
        '/v1/images/edits',
        { model: ' ', prompt: 'make it blue', image: { data: 'AA==' } },
        'model',
        'model is required',
      ],
    ];

    try {
      for (const [url, payload, param, message] of cases) {
        const response = await server.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode, `expected 400 for ${url} ${param}`).toBe(400);
        expect(response.json()).toEqual({
          error: {
            message,
            type: 'invalid_request_error',
            param,
            code: null,
          },
        });
      }
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses structured upstream status and retry-after without parsing error text', () => {
    expect(
      mapOpenAIProtocolError(
        new UpstreamRequestError({
          message: 'upstream throttled request',
          status: 429,
          headers: { retryAfter: '30' },
        }),
      ),
    ).toEqual({
      status: 429,
      retryAfter: '30',
      error: {
        message: 'upstream throttled request',
        type: 'rate_limit_error',
        param: null,
        code: null,
      },
    });
    expect(mapOpenAIProtocolError(new SyntaxError('local parser saw 429 quota')).status).toBe(500);
    expect(
      mapOpenAIProtocolError(
        new UpstreamRequestError({ message: 'upstream resource missing', status: 404 }),
      ),
    ).toMatchObject({
      status: 404,
      error: { type: 'invalid_request_error', param: null, code: null },
    });
    expect(
      mapOpenAIProtocolError(
        new AccountPoolUnavailableException(
          'All available accounts are exhausted or rate limited',
          429,
        ),
      ).status,
    ).toBe(429);
  });

  it('preserves structured status and retry headers when an error message is overridden', () => {
    const controller = new ProxyController({} as any);
    const reply = createReplyMock();

    (controller as any).sendOpenAIErrorResponse(
      reply,
      '/v1/images/generations',
      new UpstreamRequestError({
        message: 'upstream unavailable',
        status: 503,
        headers: { retryAfter: '15' },
      }),
      'Image fallback failed',
    );

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.header).toHaveBeenCalledWith('retry-after', '15');
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'Image fallback failed',
        type: 'server_error',
        param: null,
        code: null,
      },
    });
  });

  it('preserves protocol contracts through the assembled Nest and Fastify pipeline', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn().mockRejectedValue(
        new UpstreamRequestError({
          message: 'upstream throttled request',
          status: 429,
          headers: { retryAfter: '30' },
        }),
      ),
      handleAnthropicMessages: vi.fn().mockRejectedValue(new Error('anthropic upstream failure')),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const authorizedHeaders = { authorization: 'Bearer test-key' };

    try {
      const guardFailure = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'gemini-3.5-flash-medium', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(guardFailure.statusCode).toBe(401);
      expect(guardFailure.json()).toEqual({
        error: {
          message: 'API key validation failed',
          type: 'authentication_error',
          param: null,
          code: null,
        },
      });

      const anthropicFailure = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: authorizedHeaders,
        payload: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(anthropicFailure.statusCode).toBe(500);
      expect(anthropicFailure.json()).toEqual({
        type: 'error',
        error: { type: 'api_error', message: 'anthropic upstream failure' },
      });

      const invalidRequest = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authorizedHeaders,
        payload: { model: '', messages: [] },
      });
      expect(invalidRequest.statusCode).toBe(400);
      expect(invalidRequest.json().error).toMatchObject({
        type: 'invalid_request_error',
        param: 'model',
      });
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();

      const model = await server.inject({
        method: 'GET',
        url: '/v1/models/gemini-3.5-flash-medium',
        headers: authorizedHeaders,
      });
      expect(model.statusCode).toBe(200);
      expect(model.json()).toMatchObject({ id: 'gemini-3.5-flash-medium', object: 'model' });

      const modelMiss = await server.inject({
        method: 'GET',
        url: '/v1/models/does-not-exist',
        headers: authorizedHeaders,
      });
      expect(modelMiss.statusCode).toBe(404);
      expect(modelMiss.json()).toEqual({
        error: {
          message: "The model 'does-not-exist' does not exist",
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      });

      const upstreamFailure = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authorizedHeaders,
        payload: { model: 'gemini-3.5-flash-medium', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(upstreamFailure.statusCode).toBe(429);
      expect(upstreamFailure.headers['retry-after']).toBe('30');
      expect(upstreamFailure.json().error.type).toBe('rate_limit_error');

      const geminiResponse = await server.inject({
        method: 'GET',
        url: '/v1beta/models/unknown-model',
        headers: authorizedHeaders,
      });
      expect(geminiResponse.statusCode).toBe(200);
      expect(geminiResponse.json()).toEqual({
        name: 'models/unknown-model',
        displayName: 'unknown-model',
      });
    } finally {
      await app.close();
    }
  });

  it('returns the OpenAI server-error envelope for assembled upstream 5xx failures', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockRejectedValue(
          new UpstreamRequestError({ message: 'upstream unavailable', status: 503 }),
        ),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: { model: 'gemini-3.5-flash-medium', messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          message: 'upstream unavailable',
          type: 'server_error',
          param: null,
          code: null,
        },
      });
    } finally {
      await app.close();
    }
  });

  it('maps guard authentication failures into the OpenAI envelope', () => {
    const reply = createReplyMock();
    new ProxyProtocolExceptionFilter().catch(
      new UnauthorizedException('API key validation failed'),
      {
        switchToHttp: () => ({
          getRequest: () => ({ url: '/v1/chat/completions' }),
          getResponse: () => reply,
        }),
      } as any,
    );

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'API key validation failed',
        type: 'authentication_error',
        param: null,
        code: null,
      },
    });
  });

  it('rejects invalid chat input before calling ProxyService', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await expect(
      controller.chatCompletions({ model: '', messages: [] } as any, reply as any),
    ).rejects.toMatchObject({ protocolError: { param: 'model' } });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it('retrieves a listed model and returns canonical model-not-found error', () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const hit = createReplyMock();
    const miss = createReplyMock();

    controller.getModel('gemini-3.5-flash-medium', hit as any);
    controller.getModel('does-not-exist', miss as any);

    expect(hit.status).toHaveBeenCalledWith(200);
    expect(hit.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gemini-3.5-flash-medium', object: 'model' }),
    );
    expect(miss.status).toHaveBeenCalledWith(404);
    expect(miss.send).toHaveBeenCalledWith({
      error: {
        message: "The model 'does-not-exist' does not exist",
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found',
      },
    });
  });

  it('lists Antigravity public presets alongside discovered chat models', () => {
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    };
    const accountLeaseService = {
      getAllCollectedModels: vi.fn(
        () =>
          new Set([
            'gemini-3.5-flash-low',
            'gemini-3-flash',
            'gemini-3-pro-image',
            'gemini-imagecraft-chat',
          ]),
      ),
    };
    const controller = new ProxyController(proxyService as any, accountLeaseService as any);
    const reply = createReplyMock();

    controller.listModels(reply as any);

    expect(reply.status).toHaveBeenCalledWith(200);
    const payload = reply.send.mock.calls[0][0];
    const ids = payload.data.map((model: { id: string }) => model.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'gemini-3.5-flash-medium',
        'gemini-3.5-flash-high',
        'gemini-3.5-flash-low',
        'gemini-3.1-pro-low',
        'gemini-3.1-pro-high',
        'claude-sonnet-4-6-thinking',
        'claude-opus-4-6-thinking',
        'gpt-oss-120b-medium',
      ]),
    );
    expect(ids).not.toContain('gemini-3-pro-image');
    expect(ids).toContain('gemini-imagecraft-chat');
  });

  it('routes Claude OpenAI requests to protocol parity path', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({ ok: true }),
      handleAnthropicMessages: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'claude-sonnet-4-5',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();
    expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('accepts the official developer chat role without remapping it', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'gemini-3.5-flash-medium',
        messages: [{ role: 'developer', content: 'Keep replies concise.' }],
      } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'developer', content: 'Keep replies concise.' }],
      }),
    );
  });

  it('returns stream response with SSE headers for parity stream path', async () => {
    const stream = of('data: {"ok":true}\n\n');
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue(stream),
      handleAnthropicMessages: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'claude-sonnet-4-5',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );

    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(reply.send).toHaveBeenCalledWith(stream);
  });

  it('supports OpenAI completions compatibility endpoint', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'hello from assistant',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
      handleAnthropicMessages: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.completions(
      {
        model: 'gpt-4o',
        prompt: 'hello world',
        stream: false,
      },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello world' }],
      }),
      'text-completions',
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        object: 'text_completion',
        model: 'gpt-4o',
        choices: [
          expect.objectContaining({
            text: 'hello from assistant',
            logprobs: null,
          }),
        ],
      }),
    );
  });

  it('supports OpenAI responses compatibility endpoint with normalized input', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_resp',
        object: 'chat.completion',
        created: 1700000001,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              content: 'normalized response',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'search_docs',
                    arguments: '{"query":"token"}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 6,
          total_tokens: 16,
        },
      }),
    };

    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        instructions: 'Follow the tool protocol',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
          {
            type: 'function_call',
            id: 'call_1',
            name: 'search_docs',
            arguments: '{"query":"token"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: { content: 'result: ok' },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'search_docs' } },
      },
      reply as any,
    );

    const callArg = proxyService.handleChatCompletions.mock.calls[0][0];
    expect(callArg.messages[0]).toEqual({
      role: 'system',
      content: 'Follow the tool protocol',
    });
    expect(callArg.messages.some((message: { role: string }) => message.role === 'assistant')).toBe(
      true,
    );
    expect(callArg.messages.some((message: { role: string }) => message.role === 'tool')).toBe(
      true,
    );
    expect(callArg.tool_choice).toEqual({ type: 'function', function: { name: 'search_docs' } });
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'resp_resp',
        object: 'response',
        model: 'gpt-4o',
        status: 'completed',
        output: [
          expect.objectContaining({
            id: 'msg_resp',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'normalized response',
                annotations: [],
              },
            ],
          }),
          expect.objectContaining({
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'search_docs',
            arguments: '{"query":"token"}',
          }),
        ],
        usage: expect.objectContaining({
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 6,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 16,
        }),
      }),
    );
  });

  it('accepts type-omitted Responses messages and valid function calls', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_easy_input',
        created: 1700000003,
        model: 'gpt-4o',
        choices: [{ message: { content: 'done' } }],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        input: [
          { role: 'developer', content: 'Be concise.' },
          { role: 'user', content: [{ type: 'input_text', text: 'Find docs.' }] },
          {
            type: 'function_call',
            call_id: 'call_docs',
            name: 'search_docs',
            arguments: '{ "query": "Responses" }',
          },
        ],
      },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'developer', content: 'Be concise.' },
          { role: 'user', content: 'Find docs.' },
          expect.objectContaining({
            role: 'assistant',
            tool_calls: [
              expect.objectContaining({
                id: 'call_docs',
                function: expect.objectContaining({
                  name: 'search_docs',
                  arguments: '{ "query": "Responses" }',
                }),
              }),
            ],
          }),
        ]),
      }),
      'responses',
    );
  });

  it.each([
    ['a primitive item', ['invalid']],
    ['an unknown item type', [{ type: 'unknown_item_type', content: [] }]],
    ['a null item type', [{ type: null, role: 'user', content: 'hello' }]],
    ['an empty item type', [{ type: '', role: 'user', content: 'hello' }]],
    ['a non-string item type', [{ type: 123, role: 'user', content: 'hello' }]],
    ['an invalid message role', [{ role: 'tool', content: 'result' }]],
    ['an invalid message content block', [{ role: 'user', content: [{ type: 'input_audio' }] }]],
    [
      'a function call without a call id',
      [{ type: 'function_call', name: 'lookup', arguments: '{}' }],
    ],
    [
      'a function call without a name',
      [{ type: 'function_call', call_id: 'call_1', arguments: '{}' }],
    ],
    [
      'a function call with object arguments',
      [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: {} }],
    ],
    [
      'a function call with invalid JSON arguments',
      [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{invalid' }],
    ],
    [
      'a function call with non-object JSON arguments',
      [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '[]' }],
    ],
    ['a malformed tool output', [{ type: 'function_call_output', call_id: 'call_1', output: {} }]],
    ['a malformed local shell call', [{ type: 'local_shell_call', call_id: 'call_1', action: {} }]],
    ['a malformed web search call', [{ type: 'web_search_call', call_id: 'call_1', action: {} }]],
  ])('rejects Responses input containing %s before an upstream call', async (_caseName, input) => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await expect(
      controller.responses({ model: 'gpt-4o', input }, reply as any),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it('supports OpenAI responses compatibility endpoint in stream mode with SSE headers', async () => {
    const stream = of('data: {"id":"chatcmpl_resp_stream"}\n\n');
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue(stream),
    };

    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        instructions: 'stream output',
        input: 'hello',
        stream: true,
      },
      reply as any,
    );

    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(reply.send).toHaveBeenCalledWith(stream);
    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.any(Object),
      'responses',
    );
  });

  it('normalizes web_search_call in /v1/responses into builtin_web_search tool messages', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_resp_search',
        object: 'chat.completion',
        created: 1700000002,
        model: 'gpt-4o',
        choices: [{ index: 0, finish_reason: 'stop', message: { content: 'done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };

    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        input: [
          {
            type: 'web_search_call',
            call_id: 'call_search_1',
            action: { query: 'gemini api' },
          },
          {
            type: 'function_call_output',
            call_id: 'call_search_1',
            output: { content: 'search result' },
          },
        ],
      },
      reply as any,
    );

    const callArg = proxyService.handleChatCompletions.mock.calls[0][0];
    const assistantMessage = callArg.messages.find(
      (message: { role: string }) => message.role === 'assistant',
    );
    const toolMessage = callArg.messages.find(
      (message: { role: string }) => message.role === 'tool',
    );

    expect(assistantMessage?.tool_calls?.[0]?.function?.name).toBe('builtin_web_search');
    expect(toolMessage?.name).toBe('builtin_web_search');
  });

  it('supports image generations endpoint', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: '![img](data:image/png;base64,AAAABBBB)',
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        model: 'gemini-3-pro-image',
        prompt: 'draw a cat',
      },
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            b64_json: 'AAAABBBB',
          }),
        ],
      }),
    );
  });

  it('defaults the image generation model when it is omitted', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '![img](data:image/png;base64,AAAABBBB)' } }],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations({ prompt: 'draw a cat' }, reply as any);

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3-pro-image',
        size: undefined,
        quality: undefined,
      }),
    );
  });

  it('omits image usage even when the upstream response reports aggregate chat token counts', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'data:image/png;base64,AAAABBBB' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations({ prompt: 'draw a cat' }, reply as any);

    expect(reply.send.mock.calls[0][0]).not.toHaveProperty('usage');
  });

  it('omits image usage when upstream token counts are incomplete', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'data:image/png;base64,AAAABBBB' } }],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations({ prompt: 'draw a cat' }, reply as any);

    expect(reply.send.mock.calls[0][0]).not.toHaveProperty('usage');
  });

  it('rejects unsupported image generation options before invoking upstream work', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);

    const unsupportedOptions: Array<{
      option: string;
      value: string | number | boolean;
      message: string;
    }> = [
      { option: 'n', value: 2, message: 'Only n=1 is supported by this proxy.' },
      {
        option: 'response_format',
        value: 'url',
        message: 'Only response_format=b64_json is supported by this proxy.',
      },
      {
        option: 'output_format',
        value: 'jpeg',
        message: 'Only output_format=png is supported by this proxy.',
      },
      {
        option: 'size',
        value: '1536x1024',
        message: 'Only size=auto and size=1024x1024 are supported by this proxy.',
      },
      {
        option: 'quality',
        value: 'high',
        message: 'Only quality=auto is supported by this proxy.',
      },
      {
        option: 'stream',
        value: true,
        message: 'Streaming image generation is not supported by this endpoint.',
      },
      {
        option: 'background',
        value: 'transparent',
        message: 'Only background=auto is supported by this proxy.',
      },
      {
        option: 'moderation',
        value: 'low',
        message: 'Only moderation=auto is supported by this proxy.',
      },
      {
        option: 'output_compression',
        value: 50,
        message: 'output_compression is not supported by this proxy.',
      },
      {
        option: 'partial_images',
        value: 1,
        message: 'Only partial_images=0 is supported by this proxy.',
      },
      { option: 'style', value: 'vivid', message: 'style is not supported by this proxy.' },
      {
        option: 'input_fidelity',
        value: 'high',
        message: 'input_fidelity is not supported by this proxy.',
      },
    ];

    for (const { option, value, message } of unsupportedOptions) {
      const reply = createReplyMock();

      await controller.imageGenerations(
        { prompt: 'draw a cat', [option]: value } as never,
        reply as any,
      );

      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
      expect(reply.send).toHaveBeenCalledWith({
        error: {
          message,
          type: 'invalid_request_error',
          param: option,
          code: 'unsupported_parameter',
        },
      });
    }
  });

  it('rejects malformed image stream values before invoking upstream work', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);

    for (const value of ['False', '', 0, null, {}]) {
      const reply = createReplyMock();
      await controller.imageGenerations(
        { prompt: 'draw a cat', stream: value } as any,
        reply as any,
      );

      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith({
        error: {
          message: 'stream must be a boolean.',
          type: 'invalid_request_error',
          param: 'stream',
          code: 'invalid_value',
        },
      });
    }
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
  });

  it('rejects an explicit image generation user before invoking upstream work', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations({ prompt: 'draw a cat', user: 'end-user-123' }, reply as any);

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message:
          'user is not supported because this proxy cannot preserve end-user identifier semantics.',
        type: 'invalid_request_error',
        param: 'user',
        code: 'unsupported_parameter',
      },
    });
  });

  it('does not infer upstream status from image generation error text', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockRejectedValue(new Error('429 quota exceeded')),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        model: 'gemini-3-pro-image',
        prompt: 'draw a dog',
      },
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(500);
  });

  it('falls back to Gemini image generation when chat path hits project context error', async () => {
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
          ),
        ),
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: 'FALLBACKIMG',
                  },
                },
              ],
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        model: 'gemini-3-pro-image',
        prompt: 'draw a fox',
      },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledOnce();
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            b64_json: 'FALLBACKIMG',
          }),
        ],
      }),
    );
  });

  it('supports image edits endpoint with supplementary image payload', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: '![img](data:image/png;base64,CCCCDDDD)',
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      {
        model: 'gemini-3-pro-image',
        prompt: 'make it brighter',
        image: 'data:image/png;base64,IMGBASE64',
        reference_images: ['data:image/jpeg;base64,REFBASE64'],
      },
      {
        headers: {
          'content-type': 'multipart/form-data; boundary=----parity',
        },
      } as any,
      reply as any,
    );

    const request = proxyService.handleChatCompletions.mock.calls[0][0];
    expect(Array.isArray(request.messages[0].content)).toBe(true);
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('defaults the image edit model when it is omitted', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '![img](data:image/png;base64,CCCCDDDD)' } }],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      { prompt: 'make it brighter', image: 'data:image/png;base64,IMGBASE64' },
      { headers: { 'content-type': 'application/json' } } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-3-pro-image' }),
    );
  });

  it('maps raw JSON base64 image inputs to image/png while preserving explicit MIME types', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'data:image/png;base64,RESULT' } }],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      {
        prompt: 'edit image',
        image: 'RAW_IMAGE',
        reference_images: [{ data: 'EXPLICIT_IMAGE', mimeType: 'image/webp' }],
      },
      { headers: { 'content-type': 'application/json' } } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              { type: 'image_url', image_url: { url: 'data:image/png;base64,RAW_IMAGE' } },
              {
                type: 'image_url',
                image_url: { url: 'data:image/webp;base64,EXPLICIT_IMAGE' },
              },
            ]),
          }),
        ],
      }),
    );
  });

  it('rejects more than sixteen JSON image inputs before invoking upstream work', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      {
        prompt: 'combine images',
        image: 'data:image/png;base64,IMAGE_0',
        reference_images: Array.from(
          { length: 16 },
          (_, index) => `data:image/png;base64,REFERENCE_${index}`,
        ),
      },
      { headers: { 'content-type': 'application/json' } } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'At most 16 image inputs are supported by this endpoint.',
        type: 'invalid_request_error',
        param: 'image',
        code: 'invalid_value',
      },
    });
  });

  it('rejects an explicit JSON image edit user before invoking upstream work', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      {
        prompt: 'make it brighter',
        image: 'data:image/png;base64,IMGBASE64',
        user: 'end-user-123',
      },
      { headers: { 'content-type': 'application/json' } } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message:
          'user is not supported because this proxy cannot preserve end-user identifier semantics.',
        type: 'invalid_request_error',
        param: 'user',
        code: 'unsupported_parameter',
      },
    });
  });

  it('rejects unsupported image edit options with an OpenAI error envelope', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      {
        model: 'gemini-3-pro-image',
        prompt: 'make it brighter',
        image: 'data:image/png;base64,IMGBASE64',
        n: 2,
      },
      {
        headers: {
          'content-type': 'application/json',
        },
      } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'Only n=1 is supported by this proxy.',
        type: 'invalid_request_error',
        param: 'n',
        code: 'unsupported_parameter',
      },
    });
  });

  it('rejects image edit masks rather than treating them as ordinary image inputs', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      {
        prompt: 'make it brighter',
        image: 'data:image/png;base64,IMGBASE64',
        mask: 'data:image/png;base64,MASKBASE64',
      },
      { headers: { 'content-type': 'application/json' } } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'mask is not supported because this proxy cannot preserve mask semantics.',
        type: 'invalid_request_error',
        param: 'mask',
        code: 'unsupported_parameter',
      },
    });
  });

  it('supports audio transcriptions endpoint', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: 'transcribed text' }],
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.audioTranscriptions(
      {
        model: 'gemini-2.5-flash',
        file: 'data:audio/mpeg;base64,QUJDRA==',
      },
      {
        headers: {
          'content-type': 'multipart/form-data; boundary=----parity',
        },
      } as any,
      reply as any,
    );

    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledOnce();
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ text: 'transcribed text' });
  });

  it.each([0, 1])('forwards valid transcription temperature %s', async (temperature) => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'transcribed text' }] } }],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.audioTranscriptions(
      {
        model: 'gemini-3-flash',
        file: 'data:audio/mpeg;base64,QUJDRA==',
        temperature,
      },
      { headers: { 'content-type': 'application/json' } } as any,
      reply as any,
    );

    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'gemini-3-flash',
      expect.objectContaining({ generationConfig: { temperature } }),
    );
  });

  it.each(['not-a-number', Number.POSITIVE_INFINITY, -0.01, 1.01])(
    'rejects invalid transcription temperature %s',
    async (temperature) => {
      const proxyService = {
        handleGeminiGenerateContent: vi.fn(),
      };
      const controller = new ProxyController(proxyService as any);
      const reply = createReplyMock();

      await controller.audioTranscriptions(
        {
          model: 'gemini-3-flash',
          file: 'data:audio/mpeg;base64,QUJDRA==',
          temperature,
        },
        { headers: { 'content-type': 'application/json' } } as any,
        reply as any,
      );

      expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith({
        error: {
          message: 'temperature must be a finite number between 0 and 1.',
          type: 'invalid_request_error',
          param: 'temperature',
          code: 'invalid_value',
        },
      });
    },
  );

  it('returns plain text for audio transcription response_format=text', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'transcribed text' }] } }],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.audioTranscriptions(
      {
        model: 'gemini-3-flash',
        file: 'data:audio/mpeg;base64,QUJDRA==',
        response_format: 'text',
      },
      { headers: { 'content-type': 'application/json' } } as any,
      reply as any,
    );

    expect(reply.type).toHaveBeenCalledWith('text/plain; charset=utf-8');
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith('transcribed text');
  });

  it('rejects unsupported transcription options with an OpenAI error envelope', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.audioTranscriptions(
      {
        model: 'gemini-2.5-flash',
        file: 'data:audio/mpeg;base64,QUJDRA==',
        response_format: 'verbose_json',
      },
      {
        headers: {
          'content-type': 'application/json',
        },
      } as any,
      reply as any,
    );

    expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'Only response_format=json and response_format=text are supported by this proxy.',
        type: 'invalid_request_error',
        param: 'response_format',
        code: 'unsupported_option',
      },
    });
  });

  it.each([
    [
      'a scalar JSON timestamp granularity',
      { timestamp_granularities: 'word' },
      'application/json',
    ],
    [
      'an array JSON timestamp granularity',
      { timestamp_granularities: ['segment', 'word'] },
      'application/json',
    ],
    [
      'the SDK multipart timestamp granularity field',
      { 'timestamp_granularities[]': { type: 'field', value: 'word' } },
      'multipart/form-data; boundary=----timestamps',
    ],
  ])('rejects %s before transcribing', async (_caseName, timestampFields, contentType) => {
    const proxyService = { handleGeminiGenerateContent: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.audioTranscriptions(
      {
        model: 'gemini-3-flash',
        file: 'data:audio/mpeg;base64,QUJDRA==',
        ...timestampFields,
      },
      { headers: { 'content-type': contentType } } as any,
      reply as any,
    );

    expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'timestamp_granularities is not supported by this proxy.',
        type: 'invalid_request_error',
        param: 'timestamp_granularities',
        code: 'unsupported_option',
      },
    });
  });

  it('supports Anthropic messages endpoint', async () => {
    const proxyService = {
      handleAnthropicMessages: vi.fn().mockResolvedValue({
        id: 'msg_1',
        type: 'message',
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.anthropicMessages(
      {
        model: 'claude-sonnet-4-5',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );

    expect(proxyService.handleAnthropicMessages).toHaveBeenCalledOnce();
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('rejects unsupported chat options through the assembled pipeline without any upstream call', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const baseChat = {
      model: 'gemini-3.5-flash-medium',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ n: 2 }, 'n'],
      [{ seed: 42 }, 'seed'],
      [{ presence_penalty: 0.5 }, 'presence_penalty'],
      [{ frequency_penalty: -0.2 }, 'frequency_penalty'],
      [{ logit_bias: { '123': 5 } }, 'logit_bias'],
      [{ logprobs: true }, 'logprobs'],
      [{ top_logprobs: 3 }, 'top_logprobs'],
      [{ response_format: { type: 'json_schema', json_schema: {} } }, 'response_format'],
      [{ response_format: { type: 'yaml' } }, 'response_format'],
      [{ temperature: 3 }, 'temperature'],
      [{ top_p: 1.5 }, 'top_p'],
      [{ stop: ['a', 'b', 'c', 'd', 'e'] }, 'stop'],
      [{ stop: ['a', ''] }, 'stop'],
      [{ stream_options: { include_usage: true } }, 'stream_options'],
    ];

    try {
      for (const [overrides, param] of cases) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers,
          payload: { ...baseChat, ...overrides },
        });
        expect(response.statusCode, `expected 400 for ${param}`).toBe(400);
        expect(response.json().error).toMatchObject({ type: 'invalid_request_error', param });
      }

      // Harmless defaults still pass through to the service.
      proxyService.handleChatCompletions.mockResolvedValue({ ok: true });
      const accepted = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: {
          ...baseChat,
          n: 1,
          presence_penalty: 0,
          frequency_penalty: 0,
          logit_bias: {},
          logprobs: false,
          temperature: 1,
          top_p: 0.9,
          response_format: { type: 'json_object' },
          stop: 'END',
        },
      });
      expect(accepted.statusCode).toBe(200);
      expect(proxyService.handleChatCompletions).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects unsupported legacy completion options through the assembled pipeline', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const baseLegacy = { model: 'gemini-3.5-flash-medium', prompt: 'hi' };

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ suffix: ' tail' }, 'suffix'],
      [{ echo: true }, 'echo'],
      [{ best_of: 3 }, 'best_of'],
      [{ logprobs: 2 }, 'logprobs'],
      [{ n: 4 }, 'n'],
      [{ seed: 7 }, 'seed'],
      [{ prompt: ['first', 'second'] }, 'prompt'],
    ];

    try {
      for (const [overrides, param] of cases) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/completions',
          headers,
          payload: { ...baseLegacy, ...overrides },
        });
        expect(response.statusCode, `expected 400 for ${param}`).toBe(400);
        expect(response.json().error).toMatchObject({ type: 'invalid_request_error', param });
      }
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects an explicit user identifier on both chat and legacy completions without upstream calls', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };

    try {
      for (const [url, payload] of [
        [
          '/v1/chat/completions',
          {
            model: 'gemini-3.5-flash-medium',
            messages: [{ role: 'user', content: 'hi' }],
            user: 'end-user-42',
          },
        ],
        [
          '/v1/completions',
          { model: 'gemini-3.5-flash-medium', prompt: 'hi', user: 'end-user-42' },
        ],
      ] as Array<[string, Record<string, unknown>]>) {
        const response = await server.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode, `expected 400 for ${url}`).toBe(400);
        expect(response.json().error).toEqual({
          message:
            'user is not supported by this gateway: end-user identifiers are not forwarded upstream',
          type: 'invalid_request_error',
          param: 'user',
          code: 'unsupported_parameter',
        });
      }
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects remote OpenAI image URLs with an unsupported-parameter envelope before upstream', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const remoteImage = 'https://example.com/image.png';

    try {
      for (const [url, payload, param] of [
        [
          '/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages: [
              { role: 'user', content: [{ type: 'image_url', image_url: { url: remoteImage } }] },
            ],
          },
          'messages',
        ],
        [
          '/v1/responses',
          {
            model: 'gpt-4o',
            input: [{ role: 'user', content: [{ type: 'input_image', image_url: remoteImage }] }],
          },
          'input.content',
        ],
      ] as Array<[string, Record<string, unknown>, string]>) {
        const response = await server.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: {
            message: `${param} is not supported by this gateway: remote image URLs are not supported by this gateway; use a data URL`,
            type: 'invalid_request_error',
            param,
            code: 'unsupported_parameter',
          },
        });
      }
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('accepts data URLs and skips replayed reasoning items without converting either to text', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_data_url',
        created: 1700000003,
        model: 'gpt-4o',
        choices: [{ message: { content: 'done' } }],
      }),
      handleAnthropicMessages: vi.fn(),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: {
          model: 'gpt-4o',
          input: [
            { type: 'reasoning', encrypted_content: 'replayed metadata' },
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'describe this image' },
                { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
              ],
            },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'describe this image' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
              ],
            },
          ],
        }),
        'responses',
      );
    } finally {
      await app.close();
    }
  });

  it('rejects unhonored explicit Chat and Responses options before upstream', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const chatBase = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    const responsesBase = { model: 'gpt-4o', input: 'hi' };

    try {
      for (const [url, base, param, value] of [
        ['/v1/chat/completions', chatBase, 'service_tier', 'priority'],
        ['/v1/chat/completions', chatBase, 'store', true],
        ['/v1/chat/completions', chatBase, 'metadata', { trace: 'x' }],
        ['/v1/chat/completions', chatBase, 'modalities', ['text', 'audio']],
        ['/v1/chat/completions', chatBase, 'prediction', { type: 'content', content: 'x' }],
        ['/v1/chat/completions', chatBase, 'parallel_tool_calls', false],
        ['/v1/responses', responsesBase, 'previous_response_id', 'resp_previous'],
        ['/v1/responses', responsesBase, 'text', { format: { type: 'json_schema' } }],
        ['/v1/responses', responsesBase, 'background', true],
        ['/v1/responses', responsesBase, 'parallel_tool_calls', false],
        ['/v1/responses', responsesBase, 'store', true],
        ['/v1/responses', responsesBase, 'reasoning', { effort: 'high' }],
        ['/v1/responses', responsesBase, 'truncation', 'auto'],
        ['/v1/responses', responsesBase, 'max_tool_calls', 2],
      ] as Array<[string, Record<string, unknown>, string, unknown]>) {
        const response = await server.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...base, [param]: value },
        });
        expect(response.statusCode, `expected ${param} to fail closed`).toBe(400);
        expect(response.json()).toEqual({
          error: {
            message: `${param} is not supported by this gateway: this option is not forwarded upstream`,
            type: 'invalid_request_error',
            param,
            code: 'unsupported_parameter',
          },
        });
      }
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a response_format object without a usable type instead of treating it as text', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const baseChat = {
      model: 'gemini-3.5-flash-medium',
      messages: [{ role: 'user', content: 'hi' }],
    };

    try {
      for (const responseFormat of [
        {},
        { json_schema: { name: 'x' } },
        { type: '  ' },
        { type: 7 },
      ]) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers,
          payload: { ...baseChat, response_format: responseFormat },
        });
        expect(response.statusCode, `expected 400 for ${JSON.stringify(responseFormat)}`).toBe(400);
        expect(response.json().error).toMatchObject({
          message: "response_format.type is required and must be one of 'text' or 'json_object'",
          type: 'invalid_request_error',
          param: 'response_format',
          code: null,
        });
      }
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();

      // The supported types keep working untouched.
      proxyService.handleChatCompletions.mockResolvedValue({ ok: true });
      for (const type of ['text', 'json_object']) {
        const accepted = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers,
          payload: { ...baseChat, response_format: { type } },
        });
        expect(accepted.statusCode, `expected 200 for ${type}`).toBe(200);
      }

      const jsonSchema = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: { ...baseChat, response_format: { type: 'json_schema', json_schema: {} } },
      });
      expect(jsonSchema.statusCode).toBe(400);
      expect(jsonSchema.json().error).toMatchObject({
        param: 'response_format',
        code: 'unsupported_parameter',
      });
    } finally {
      await app.close();
    }
  });

  it('omits legacy usage and nulls Responses usage when the service reports none', async () => {
    const chatResponse = {
      id: 'chatcmpl_no_usage',
      object: 'chat.completion',
      created: 1700000003,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'no usage here' },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
    };
    const proxyService = { handleChatCompletions: vi.fn().mockResolvedValue(chatResponse) };
    const controller = new ProxyController(proxyService as any);
    const legacyReply = createReplyMock();
    const responsesReply = createReplyMock();

    await controller.completions(
      { model: 'gpt-4o', prompt: 'hi', stream: false },
      legacyReply as any,
    );
    await controller.responses({ model: 'gpt-4o', input: 'hi' }, responsesReply as any);

    const legacyBody = legacyReply.send.mock.calls[0][0];
    expect(legacyBody).toEqual({
      id: 'chatcmpl_no_usage',
      object: 'text_completion',
      created: 1700000003,
      model: 'gpt-4o',
      choices: [{ text: 'no usage here', index: 0, logprobs: null, finish_reason: 'stop' }],
    });
    expect(Object.keys(legacyBody)).not.toContain('usage');
    expect(responsesReply.send.mock.calls[0][0].usage).toBeNull();
  });

  it('maps Chat reasoning-token details to Responses usage without changing totals', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_usage',
        object: 'chat.completion',
        created: 1700000004,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'done' },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 7,
          completion_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 10,
        },
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses({ model: 'gpt-4o', input: 'hi' }, reply as any);

    expect(reply.send.mock.calls[0][0].usage).toEqual({
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 10,
    });
  });

  it('forwards legacy completion stop sequences and streams through the legacy protocol', async () => {
    const legacyStream = of(
      'data: {"object":"text_completion","choices":[{"text":"hi","index":0,"logprobs":null,"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    );
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue(legacyStream),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.completions(
      {
        model: 'gpt-4o',
        prompt: 'hello world',
        stop: ['<<END>>'],
        stream: true,
        stream_options: { include_usage: true },
      } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        stop: ['<<END>>'],
        stream: true,
        stream_options: { include_usage: true },
      }),
      'text-completions',
    );
    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(reply.send).toHaveBeenCalledWith(legacyStream);
  });
});
