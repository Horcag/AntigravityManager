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
        code: 'invalid_request_error',
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
});
