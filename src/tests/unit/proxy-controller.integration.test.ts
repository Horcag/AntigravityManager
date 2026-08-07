import { Controller, HttpStatus, Module, Post, UnauthorizedException } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { concat, of, throwError } from 'rxjs';

import { getServerConfig } from '../../server/server-config';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/account-lease.service';
import { ProxyController } from '../../modules/proxy-gateway/server/proxy.controller';
import { UpstreamRequestError } from '../../modules/proxy-gateway/server/clients/upstream-error';
import { GeminiController } from '../../modules/proxy-gateway/server/gemini.controller';
import { ProxyGuard } from '../../modules/proxy-gateway/server/proxy.guard';
import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';
import { MultipartOpenAIExceptionFilter } from '../../modules/proxy-gateway/server/fastify-multipart.provider';
import { transformClaudeRequestIn } from '../../modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import {
  AccountPoolUnavailableException,
  mapAnthropicProtocolError,
  mapOpenAIProtocolError,
  OpenAIProtocolException,
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

async function createHttpApp(proxyService: object, bodyLimit?: number) {
  @Controller('outside')
  class OutsideController {
    @Post('json')
    acceptJson(): { ok: true } {
      return { ok: true };
    }
  }

  @Module({
    controllers: [ProxyController, GeminiController, OutsideController],
    providers: [
      ProxyGuard,
      { provide: ProxyService, useValue: proxyService },
      { provide: AccountLeaseService, useValue: { getAllCollectedModels: () => new Set() } },
      { provide: APP_FILTER, useClass: MultipartOpenAIExceptionFilter },
    ],
  })
  class HttpTestModule {}

  const app = await NestFactory.create(
    HttpTestModule,
    new FastifyAdapter(bodyLimit ? { bodyLimit } : undefined),
    { logger: false },
  );
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

  it.each(['system', 'developer', 'user', 'tool'] as const)(
    'rejects tool_calls on a %s message through the assembled Fastify pipeline',
    async (role) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = { handleChatCompletions: vi.fn() };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: 'Bearer test-key',
            'content-type': 'application/json',
          },
          payload: {
            model: 'gpt-4o',
            messages: [
              {
                role,
                content: role === 'tool' ? 'tool result' : 'hello',
                ...(role === 'tool' ? { tool_call_id: 'call_1' } : {}),
                tool_calls: [],
              },
            ],
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: {
            message: 'tool_calls is only supported on assistant messages',
            type: 'invalid_request_error',
            param: 'messages[0].tool_calls',
            code: null,
          },
        });
        expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    ['omitted', undefined],
    ['null', null],
  ])(
    'accepts an assistant tool-call loop with %s content through the assembled Fastify pipeline',
    async (_contentKind, content) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = {
        handleChatCompletions: vi.fn().mockResolvedValue({ ok: true }),
      };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: 'Bearer test-key' },
          payload: {
            model: 'gpt-4o',
            messages: [
              { role: 'user', content: 'What is the weather?' },
              {
                role: 'assistant',
                ...(content === undefined ? {} : { content }),
                tool_calls: [
                  {
                    id: 'call_weather',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                  },
                ],
              },
              { role: 'tool', tool_call_id: 'call_weather', content: 'Sunny' },
            ],
          },
        });

        expect(response.statusCode).toBe(200);
        expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();
      } finally {
        await app.close();
      }
    },
  );

  it.each(['user', 'system', 'developer', 'tool'] as const)(
    'rejects null content on a %s message through the assembled Fastify pipeline',
    async (role) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = { handleChatCompletions: vi.fn() };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: 'Bearer test-key',
            'content-type': 'application/json',
          },
          payload: {
            model: 'gpt-4o',
            messages: [
              {
                role,
                content: null,
                ...(role === 'tool' ? { tool_call_id: 'call_1' } : {}),
              },
            ],
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatchObject({
          type: 'invalid_request_error',
          param: 'messages[0].content',
        });
        expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it('validates Responses tool calls and outputs in input order through the assembled Fastify pipeline', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_resp',
        object: 'chat.completion',
        created: 1700000001,
        model: 'gpt-4o',
        choices: [{ index: 0, finish_reason: 'stop', message: { content: 'done' } }],
      }),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };

    try {
      const outputBeforeCall = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: {
          model: 'gpt-4o',
          input: [
            { type: 'function_call_output', call_id: 'call_1', output: 'result' },
            { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
          ],
        },
      });
      expect(outputBeforeCall.statusCode).toBe(400);
      expect(outputBeforeCall.json().error).toMatchObject({ param: 'input[0].call_id' });

      const duplicateCall = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: {
          model: 'gpt-4o',
          input: [
            { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
            { type: 'local_shell_call', call_id: 'call_1', action: { exec: { command: 'dir' } } },
          ],
        },
      });
      expect(duplicateCall.statusCode).toBe(400);
      expect(duplicateCall.json().error).toMatchObject({ param: 'input[1].call_id' });

      const standaloneCustomToolOutput = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: {
          model: 'gpt-4o',
          input: [{ type: 'custom_tool_call_output', call_id: 'call_1', output: 'result' }],
        },
      });
      expect(standaloneCustomToolOutput.statusCode).toBe(400);
      expect(standaloneCustomToolOutput.json()).toEqual({
        error: {
          message:
            'input[0].type is not supported by this gateway: custom_tool_call_output requires unsupported custom tools',
          type: 'invalid_request_error',
          param: 'input[0].type',
          code: 'unsupported_parameter',
        },
      });

      const duplicateOutput = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: {
          model: 'gpt-4o',
          input: [
            { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'first result' },
            { type: 'function_call_output', call_id: 'call_1', output: 'duplicate result' },
          ],
        },
      });
      expect(duplicateOutput.statusCode).toBe(400);
      expect(duplicateOutput.json().error).toMatchObject({ param: 'input[2].call_id' });

      const validCallThenOutput = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: {
          model: 'gpt-4o',
          input: [
            { type: 'function_call', id: 'call_1', name: 'lookup', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'result' },
          ],
        },
      });
      expect(validCallThenOutput.statusCode).toBe(200);
      expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();

      proxyService.handleChatCompletions.mockClear();
      const validTwoCallsThenOutputs = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: {
          model: 'gpt-4o',
          input: [
            { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
            { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_2', output: 'second result' },
            { type: 'function_call_output', call_id: 'call_1', output: 'first result' },
          ],
        },
      });
      expect(validTwoCallsThenOutputs.statusCode).toBe(200);
      expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each([
    [
      'an assistant message without content or tool calls',
      { model: 'gpt-4o', messages: [{ role: 'assistant' }] },
      'messages[0].content',
    ],
    [
      'an assistant message with null content and no tool calls',
      { model: 'gpt-4o', messages: [{ role: 'assistant', content: null }] },
      'messages[0].content',
    ],
    [
      'an assistant message with omitted content and empty tool calls',
      { model: 'gpt-4o', messages: [{ role: 'assistant', tool_calls: [] }] },
      'messages[0].content',
    ],
    [
      'an assistant message with null content and empty tool calls',
      { model: 'gpt-4o', messages: [{ role: 'assistant', content: null, tool_calls: [] }] },
      'messages[0].content',
    ],
    [
      'a tool result that does not reference an earlier assistant tool call',
      {
        model: 'gpt-4o',
        messages: [{ role: 'tool', tool_call_id: 'call_missing', content: 'Sunny' }],
      },
      'messages[0].tool_call_id',
    ],
  ])(
    'rejects %s through the assembled Fastify pipeline before an upstream call',
    async (_caseName, payload, param) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = { handleChatCompletions: vi.fn() };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: 'Bearer test-key' },
          payload,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatchObject({ type: 'invalid_request_error', param });
        expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it('rejects duplicate assistant tool-call ids through the assembled Fastify pipeline', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: {
          model: 'gpt-4o',
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_weather',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{}' },
                },
                {
                  id: 'call_weather',
                  type: 'function',
                  function: { name: 'get_forecast', arguments: '{}' },
                },
              ],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        type: 'invalid_request_error',
        param: 'messages[0].tool_calls[1].id',
      });
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a duplicate chat tool result while accepting distinct results in any declared order', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn().mockResolvedValue({ ok: true }) };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      },
      {
        id: 'call_2',
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      },
    ];

    try {
      const duplicateResult = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: {
          model: 'gpt-4o',
          messages: [
            { role: 'assistant', content: null, tool_calls: toolCalls },
            { role: 'tool', tool_call_id: 'call_1', content: 'first result' },
            { role: 'tool', tool_call_id: 'call_1', content: 'duplicate result' },
          ],
        },
      });
      expect(duplicateResult.statusCode).toBe(400);
      expect(duplicateResult.json().error).toMatchObject({ param: 'messages[2].tool_call_id' });
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();

      const distinctResults = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: {
          model: 'gpt-4o',
          messages: [
            { role: 'assistant', content: null, tool_calls: toolCalls },
            { role: 'tool', tool_call_id: 'call_2', content: 'second result' },
            { role: 'tool', tool_call_id: 'call_1', content: 'first result' },
          ],
        },
      });
      expect(distinctResults.statusCode).toBe(200);
      expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each(['/v1/chat/completions', '/v1/responses'] as const)(
    'rejects invalid forced function selections through %s before the assembled upstream call',
    async (url) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = { handleChatCompletions: vi.fn() };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();
      const base =
        url === '/v1/chat/completions'
          ? { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
          : { model: 'gpt-4o', input: 'hi' };
      const tools =
        url === '/v1/chat/completions'
          ? [{ type: 'function', function: { name: 'lookup' } }]
          : [{ type: 'function', name: 'lookup' }];
      const invalidChoices =
        url === '/v1/chat/completions'
          ? [
              { type: 'function', function: {} },
              { type: 'function', function: { name: 'missing' } },
            ]
          : [
              { type: 'function', name: '' },
              { type: 'function', name: 'missing' },
            ];

      try {
        for (const toolChoice of invalidChoices) {
          const response = await server.inject({
            method: 'POST',
            url,
            headers: { authorization: 'Bearer test-key' },
            payload: {
              ...base,
              tools,
              tool_choice: toolChoice,
            },
          });

          expect(response.statusCode).toBe(400);
          expect(response.json().error).toMatchObject({
            type: 'invalid_request_error',
            param: 'tool_choice',
          });
        }
        expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it.each(['/v1/chat/completions', '/v1/responses'] as const)(
    'preserves valid tool-choice controls through %s',
    async (url) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = {
        handleChatCompletions: vi.fn().mockResolvedValue({
          id: 'chatcmpl_1',
          created: 1700000000,
          model: 'gpt-4o',
          choices: [{ message: { content: 'done' } }],
        }),
      };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();
      const base =
        url === '/v1/chat/completions'
          ? { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
          : { model: 'gpt-4o', input: 'hi' };
      const tools =
        url === '/v1/chat/completions'
          ? [{ type: 'function', function: { name: 'lookup' } }]
          : [{ type: 'function', name: 'lookup' }];
      const toolChoices =
        url === '/v1/chat/completions'
          ? ['auto', 'none', 'required', { type: 'function', function: { name: 'lookup' } }]
          : ['auto', 'none', 'required', { type: 'function', name: 'lookup' }];

      try {
        for (const toolChoice of toolChoices) {
          const response = await server.inject({
            method: 'POST',
            url,
            headers: { authorization: 'Bearer test-key' },
            payload: {
              ...base,
              tools,
              tool_choice: toolChoice,
            },
          });

          expect(response.statusCode, response.body).toBe(200);
        }
        expect(proxyService.handleChatCompletions).toHaveBeenCalledTimes(4);
      } finally {
        await app.close();
      }
    },
  );

  it('rejects unsupported Responses built-in, MCP, custom, and allowed-tools variants before upstream', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };

    try {
      for (const payload of [
        { tools: [{ type: 'web_search_preview' }] },
        { tools: [{ type: 'mcp', server_label: 'docs' }] },
        { tools: [{ type: 'custom', name: 'code' }] },
        { tool_choice: { type: 'allowed_tools', tools: [{ type: 'function', name: 'lookup' }] } },
      ]) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/responses',
          headers,
          payload: { model: 'gpt-4o', input: 'hi', ...payload },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatchObject({
          type: 'invalid_request_error',
          code: 'unsupported_parameter',
        });
      }
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects malformed OpenAI and Anthropic request shapes before invoking services', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const anthropicResult = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'gemini-3-flash',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn().mockResolvedValue(anthropicResult),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const invalidOpenAIRequests: Array<[string, Record<string, unknown>, string]> = [
      [
        '/v1/chat/completions',
        { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hi' }], tools: [null] },
        'tools',
      ],
      ['/v1/responses', { model: 'gemini-3-flash', input: 'hi', tools: [null] }, 'tools'],
      [
        '/v1/chat/completions',
        { model: 'gemini-3-flash', messages: [{ role: 'user', content: [null] }] },
        'messages',
      ],
    ];
    const invalidAnthropicBodies: unknown[] = [
      {},
      [],
      { model: 42, messages: [{ role: 'user', content: 'hi' }] },
      { messages: [{ role: 'user', content: 'hi' }] },
      { model: 'claude-sonnet-4-5', messages: null },
      { model: 'claude-sonnet-4-5', messages: [] },
      { model: 'claude-sonnet-4-5', messages: [null] },
      { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: null }] },
      { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: [] }] },
      { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: [null] }] },
      {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [null],
      },
      {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: null }],
      },
    ];

    try {
      for (const [url, payload, param] of invalidOpenAIRequests) {
        const response = await server.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatchObject({ type: 'invalid_request_error', param });
      }
      for (const payload of invalidAnthropicBodies) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          type: 'error',
          error: { type: 'invalid_request_error' },
        });
      }
      const invalidStops = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers,
        payload: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'hi' }],
          stop_sequences: [],
        },
      });
      expect(invalidStops.statusCode).toBe(400);
      expect(invalidStops.json()).toEqual({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'stop_sequences must be an array of 1 to 5 non-empty strings',
        },
      });
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
      expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();

      const validAnthropic = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers,
        payload: {
          model: 'claude-sonnet-4-5',
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Use the supplied tool.' }],
            },
          ],
          tools: [{ name: 'lookup_weather', input_schema: { type: 'object' } }],
          stop_sequences: ['custom', '<|user|>', 'custom', '[DONE]', 'another'],
        },
      });
      expect(validAnthropic.statusCode).toBe(200);
      expect(validAnthropic.json()).toEqual(anthropicResult);
      expect(proxyService.handleAnthropicMessages).toHaveBeenCalledOnce();
      const [request] = proxyService.handleAnthropicMessages.mock.calls[0];
      expect(
        transformClaudeRequestIn(request, 'project_1', 'test-agent').request.generationConfig,
      ).toMatchObject({
        stopSequences: ['custom', '<|user|>', 'custom', '[DONE]', 'another'],
      });
    } finally {
      await app.close();
    }
  });

  it('preserves tool-use arguments through the assembled Anthropic messages pipeline', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', type: 'message' }),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const input = {
      type: 'MARKDOWN',
      default: { format: 'uri', pattern: '^https://example\\.com$' },
      examples: [{ required: ['literal'], additionalProperties: false }],
      nested: { if: { const: 'value' }, not: { items: ['unchanged'] } },
      values: [null, false, 0, 'text'],
    };
    const payload = {
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'inspect', input }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'done' }],
        },
      ],
    };
    const payloadBeforeRequest = structuredClone(payload);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer test-key' },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(proxyService.handleAnthropicMessages).toHaveBeenCalledOnce();
      expect(payload).toEqual(payloadBeforeRequest);

      const [request] = proxyService.handleAnthropicMessages.mock.calls[0];
      const requestBeforeTransform = structuredClone(request);
      const firstMapped = transformClaudeRequestIn(request, 'project_1', 'test-agent');
      const secondMapped = transformClaudeRequestIn(request, 'project_1', 'test-agent');
      const firstArgs = firstMapped.request.contents
        .flatMap((content) => content.parts)
        .find((part) => part.functionCall)?.functionCall?.args;
      const secondArgs = secondMapped.request.contents
        .flatMap((content) => content.parts)
        .find((part) => part.functionCall)?.functionCall?.args;

      expect(firstArgs).toEqual(input);
      expect(secondArgs).toEqual(input);
      expect(request).toEqual(requestBeforeTransform);
    } finally {
      await app.close();
    }
  });

  it('accepts empty Anthropic tool results through the assembled messages pipeline', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', type: 'message' }),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const basePayload = {
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'lookup_weather', input: {} }],
        },
      ],
    };

    try {
      for (const content of [undefined, []] as const) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: {
            ...basePayload,
            messages: [
              ...basePayload.messages,
              {
                role: 'user',
                content: [
                  content === undefined
                    ? { type: 'tool_result', tool_use_id: 'tool_1' }
                    : { type: 'tool_result', tool_use_id: 'tool_1', content },
                ],
              },
            ],
          },
        });

        expect(response.statusCode).toBe(200);
      }
      expect(proxyService.handleAnthropicMessages).toHaveBeenCalledTimes(2);
      expect(
        proxyService.handleAnthropicMessages.mock.calls.map(([request]) => {
          const mapped = transformClaudeRequestIn(request, 'project_1', 'test-agent');

          return mapped.request.contents.at(-1)?.parts[0]?.functionResponse?.response.result;
        }),
      ).toEqual(['(no content)', '(no content)']);

      for (const content of [
        null,
        42,
        [{ type: 'text' }],
        [{ type: 'unsupported' }],
        [{ type: 'thinking', thinking: 'hidden' }],
        [{ type: 'tool_use', id: 'nested_tool', name: 'nested', input: {} }],
        [{ type: 'tool_result', tool_use_id: 'nested_tool' }],
        [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'aGVsbG8=' },
          },
        ],
        [{ type: 'search_result', content: 'not mapped' }],
      ]) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: {
            ...basePayload,
            messages: [
              ...basePayload.messages,
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'tool_1', content }],
              },
            ],
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          type: 'error',
          error: { type: 'invalid_request_error' },
        });
      }
      expect(proxyService.handleAnthropicMessages).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('rejects empty Anthropic message text before upstream calls and preserves valid text bytes', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', type: 'message' }),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };

    try {
      for (const content of ['', ' \t\n '] as const) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content }] },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          type: 'error',
          error: { type: 'invalid_request_error' },
        });
      }
      for (const content of [
        [{ type: 'text', text: '' }],
        [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
          { type: 'text', text: ' \t\n ' },
        ],
      ]) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content }] },
        });

        expect(response.statusCode).toBe(400);
      }
      expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();

      const validText = '  keep leading\n\ninternal blank lines\t  ';
      const validResponse = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers,
        payload: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: [{ type: 'text', text: validText }] }],
        },
      });

      expect(validResponse.statusCode).toBe(200);
      expect(proxyService.handleAnthropicMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: [{ type: 'text', text: validText }] }],
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('validates Anthropic tool block identifiers and preserves valid tool results before upstream calls', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', type: 'message' }),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const basePayload = {
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'lookup_weather', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'result' }],
        },
      ],
    };

    try {
      for (const content of [
        [{ type: 'tool_use', id: '', name: 'lookup_weather', input: {} }],
        [{ type: 'tool_use', id: ' \t', name: 'lookup_weather', input: {} }],
        [{ type: 'tool_use', id: 'tool_1', name: '', input: {} }],
        [{ type: 'tool_use', id: 'tool_1', name: ' \n', input: {} }],
      ]) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: { model: basePayload.model, messages: [{ role: 'assistant', content }] },
        });

        expect(response.statusCode).toBe(400);
      }

      for (const toolResult of [
        { tool_use_id: '' },
        { tool_use_id: ' \t' },
        { tool_use_id: 'tool_1', is_error: 'true' },
        { tool_use_id: 'tool_1', is_error: 1 },
        { tool_use_id: 'tool_1', is_error: null },
        { tool_use_id: 'tool_1', is_error: [] },
        { tool_use_id: 'tool_1', is_error: {} },
      ]) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: {
            ...basePayload,
            messages: [
              basePayload.messages[0],
              { role: 'user', content: [{ type: 'tool_result', ...toolResult }] },
            ],
          },
        });

        expect(response.statusCode).toBe(400);
      }
      expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();

      for (const isError of [true, false]) {
        const toolUseId = ' tool_1 ';
        const toolName = ' lookup_weather ';
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: {
            model: basePayload.model,
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: {} }],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    is_error: isError,
                    content: [
                      { type: 'text', text: ' \t ' },
                      {
                        type: 'image',
                        source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });

        expect(response.statusCode).toBe(200);
        const [request] = proxyService.handleAnthropicMessages.mock.calls.at(-1) ?? [];
        const mapped = transformClaudeRequestIn(request, 'project_1', 'test-agent').request
          .contents;
        expect(mapped[0]?.parts[0]?.functionCall).toMatchObject({ id: toolUseId, name: toolName });
        expect(mapped[1]?.parts[0]?.functionResponse).toMatchObject({
          id: toolUseId,
          name: toolName,
          response: { [isError ? 'error' : 'result']: [' \t ', { $ref: expect.any(String) }] },
          parts: [
            {
              inlineData: expect.objectContaining({ mimeType: 'image/png', data: 'aGVsbG8=' }),
            },
          ],
        });
      }
      expect(proxyService.handleAnthropicMessages).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('enforces Anthropic tool history pairing before the assembled messages upstream call', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', type: 'message' }),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'lookup_weather', input: {} });
    const toolResult = (toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `${toolUseId} result`,
    });

    try {
      const validHistories = [
        [
          { role: 'assistant', content: [toolUse('call_single')] },
          { role: 'user', content: [toolResult('call_single')] },
        ],
        [
          { role: 'assistant', content: [toolUse('call_one'), toolUse('call_two')] },
          {
            role: 'user',
            content: [
              toolResult('call_one'),
              toolResult('call_two'),
              { type: 'text', text: 'continue' },
            ],
          },
        ],
        [
          { role: 'assistant', content: [toolUse('call_split')] },
          { role: 'assistant', content: [{ type: 'text', text: 'I will use this result.' }] },
          { role: 'user', content: [toolResult('call_split')] },
          { role: 'user', content: [{ type: 'text', text: 'and then explain it' }] },
        ],
      ];

      for (const messages of validHistories) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: { model: 'claude-sonnet-4-5', messages },
        });
        expect(response.statusCode).toBe(200);
      }
      expect(proxyService.handleAnthropicMessages).toHaveBeenCalledTimes(validHistories.length);
      proxyService.handleAnthropicMessages.mockClear();

      const invalidHistories = [
        [{ role: 'user', content: [toolUse('call_user')] }],
        [{ role: 'assistant', content: [toolResult('call_assistant')] }],
        [{ role: 'user', content: [toolResult('call_orphan')] }],
        [
          { role: 'assistant', content: [toolUse('call_expected')] },
          { role: 'user', content: [toolResult('call_unexpected')] },
        ],
        [
          { role: 'assistant', content: [toolUse('call_duplicate'), toolUse('call_duplicate')] },
          { role: 'user', content: [toolResult('call_duplicate')] },
        ],
        [
          { role: 'assistant', content: [toolUse('call_first'), toolUse('call_second')] },
          { role: 'user', content: [toolResult('call_first')] },
        ],
        [
          { role: 'assistant', content: [toolUse('call_repeated')] },
          { role: 'user', content: [toolResult('call_repeated'), toolResult('call_repeated')] },
        ],
        [{ role: 'assistant', content: [toolUse('call_unresolved')] }],
        [
          { role: 'assistant', content: [toolUse('call_delayed')] },
          { role: 'user', content: [{ type: 'text', text: 'wait' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'intervening turn' }] },
          { role: 'user', content: [toolResult('call_delayed')] },
        ],
        [
          { role: 'assistant', content: [toolUse('call_order')] },
          {
            role: 'user',
            content: [{ type: 'text', text: 'before result' }, toolResult('call_order')],
          },
        ],
        [
          { role: 'user', content: [toolResult('call_before')] },
          { role: 'assistant', content: [toolUse('call_before')] },
        ],
      ];

      for (const messages of invalidHistories) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: { model: 'claude-sonnet-4-5', messages },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          type: 'error',
          error: { type: 'invalid_request_error' },
        });
      }
      expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(['claude-sonnet-4-6', 'gemini-3.5-flash-high'])(
    'forwards final Anthropic assistant prefills for %s to canonical service routing',
    async (model) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = {
        handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', type: 'message' }),
      };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers: { authorization: 'Bearer test-key' },
          payload: {
            model,
            messages: [
              { role: 'user', content: 'start' },
              { role: 'assistant', content: 'continue from this prefill' },
            ],
          },
        });

        expect(response.statusCode).toBe(200);
        expect(proxyService.handleAnthropicMessages).toHaveBeenCalledOnce();
      } finally {
        await app.close();
      }
    },
  );

  it('returns the Anthropic invalid-request envelope for a service prefill rejection', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleAnthropicMessages: vi
        .fn()
        .mockRejectedValue(
          new OpenAIProtocolException(
            'Final assistant prefill is not supported for this model.',
            HttpStatus.BAD_REQUEST,
            { param: 'messages' },
          ),
        ),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer test-key' },
        payload: {
          model: 'public-medium',
          messages: [
            { role: 'user', content: 'start' },
            { role: 'assistant', content: 'continue from this prefill' },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Final assistant prefill is not supported for this model.',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('allows a user-final Anthropic history for targets that reject assistant prefills', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', type: 'message' }),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer test-key' },
        payload: {
          model: 'gemini-3.5-flash-high',
          messages: [
            { role: 'assistant', content: 'prior reply' },
            { role: 'user', content: 'new request' },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(proxyService.handleAnthropicMessages).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('preserves final assistant prefills for the explicitly supported legacy target', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', type: 'message' }),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const messages = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'continue from this prefill' },
    ];

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer test-key' },
        payload: { model: 'gemini-3-flash', messages },
      });

      expect(response.statusCode).toBe(200);
      expect(proxyService.handleAnthropicMessages).toHaveBeenCalledWith(
        expect.objectContaining({ messages }),
      );
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

  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [402, 'billing_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [409, 'conflict_error'],
    [413, 'request_too_large'],
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [503, 'api_error'],
    [504, 'timeout_error'],
    [529, 'overloaded_error'],
  ])('maps Anthropic upstream status %i to %s', (status, type) => {
    expect(
      mapAnthropicProtocolError(new UpstreamRequestError({ message: 'upstream failure', status })),
    ).toMatchObject({ status, error: { type, message: 'upstream failure' } });
  });

  it('preserves retry-after and Anthropic error types through the assembled Fastify route', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleAnthropicMessages: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamRequestError({
            message: 'upstream throttled request',
            status: 429,
            headers: { retryAfter: '30' },
          }),
        )
        .mockRejectedValueOnce(
          new UpstreamRequestError({ message: 'upstream timeout', status: 504 }),
        )
        .mockRejectedValueOnce(
          new UpstreamRequestError({ message: 'upstream billing issue', status: 402 }),
        )
        .mockRejectedValueOnce(
          new UpstreamRequestError({ message: 'upstream resource conflict', status: 409 }),
        ),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const request = {
      method: 'POST' as const,
      url: '/v1/messages',
      headers: { authorization: 'Bearer test-key' },
      payload: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
    };

    try {
      const rateLimited = await server.inject(request);
      expect(rateLimited.statusCode).toBe(429);
      expect(rateLimited.headers['retry-after']).toBe('30');
      expect(rateLimited.json()).toEqual({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'upstream throttled request' },
      });

      const timedOut = await server.inject(request);
      expect(timedOut.statusCode).toBe(504);
      expect(timedOut.json()).toEqual({
        type: 'error',
        error: { type: 'timeout_error', message: 'upstream timeout' },
      });

      const billingFailure = await server.inject(request);
      expect(billingFailure.statusCode).toBe(402);
      expect(billingFailure.json()).toEqual({
        type: 'error',
        error: { type: 'billing_error', message: 'upstream billing issue' },
      });

      const conflictFailure = await server.inject(request);
      expect(conflictFailure.statusCode).toBe(409);
      expect(conflictFailure.json()).toEqual({
        type: 'error',
        error: { type: 'conflict_error', message: 'upstream resource conflict' },
      });
    } finally {
      await app.close();
    }
  });

  it('does not expose unexpected 5xx implementation details while preserving protocol exceptions', () => {
    expect(mapOpenAIProtocolError(new Error('e is not iterable'))).toMatchObject({
      status: 500,
      error: { message: 'Internal Server Error', type: 'server_error' },
    });
    expect(
      mapOpenAIProtocolError(
        new OpenAIProtocolException('Safe protocol message', HttpStatus.SERVICE_UNAVAILABLE),
      ),
    ).toMatchObject({
      status: 503,
      error: { message: 'Safe protocol message', type: 'server_error' },
    });
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

  it('contains unexpected Anthropic endpoint failures through the assembled Nest and Fastify pipeline', async () => {
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
        error: { type: 'api_error', message: 'Internal Server Error' },
      });

      proxyService.handleAnthropicMessages.mockRejectedValueOnce(
        new UpstreamRequestError({ message: 'trusted upstream failure', status: 503 }),
      );
      const trustedAnthropicFailure = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: authorizedHeaders,
        payload: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(trustedAnthropicFailure.statusCode).toBe(503);
      expect(trustedAnthropicFailure.json()).toEqual({
        type: 'error',
        error: { type: 'api_error', message: 'trusted upstream failure' },
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
      expect(geminiResponse.statusCode).toBe(404);
      expect(geminiResponse.json()).toEqual({
        error: {
          code: 404,
          message: 'Model not found: models/unknown-model',
          status: 'NOT_FOUND',
        },
      });

      const knownGeminiModel = await server.inject({
        method: 'GET',
        url: '/v1beta/models/gemini-3.5-flash-medium',
        headers: authorizedHeaders,
      });
      expect(knownGeminiModel.statusCode).toBe(200);
      expect(knownGeminiModel.json()).toEqual({
        name: 'models/gemini-3.5-flash-medium',
        displayName: 'gemini-3.5-flash-medium',
      });
    } finally {
      await app.close();
    }
  });

  it('uses Anthropic JSON wire envelopes only for POST /v1/messages', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    };
    const headers = {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    };
    const malformedPayload = '{"model":';

    const malformedApp = await createHttpApp(proxyService);
    const malformedServer = malformedApp.getHttpAdapter().getInstance();

    try {
      const anthropicResponse = await malformedServer.inject({
        method: 'POST',
        url: '/v1/messages',
        headers,
        payload: malformedPayload,
      });
      expect(anthropicResponse.statusCode).toBe(400);
      expect(anthropicResponse.json()).toEqual({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Malformed JSON request body.' },
      });

      const openAIResponse = await malformedServer.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: malformedPayload,
      });
      expect(openAIResponse.statusCode).toBe(400);
      expect(openAIResponse.json()).toEqual({
        error: {
          message: 'Malformed JSON request body.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_json',
        },
      });

      const outsideResponse = await malformedServer.inject({
        method: 'POST',
        url: '/outside/json',
        headers: { 'content-type': 'application/json' },
        payload: malformedPayload,
      });
      expect(outsideResponse.statusCode).toBe(400);
      expect(outsideResponse.json()).toMatchObject({ statusCode: 400 });
      expect(outsideResponse.json()).not.toHaveProperty('error.type');
    } finally {
      await malformedApp.close();
    }

    const limitedApp = await createHttpApp(proxyService, 1);
    const limitedServer = limitedApp.getHttpAdapter().getInstance();

    try {
      const bodyLimitResponse = await limitedServer.inject({
        method: 'POST',
        url: '/v1/messages',
        headers,
        payload: '{"model":"claude-sonnet-4-5"}',
      });
      expect(bodyLimitResponse.statusCode).toBe(413);
      expect(bodyLimitResponse.json()).toEqual({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Request body too large.' },
      });
    } finally {
      await limitedApp.close();
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

  it('uses Google envelopes for assembled v1beta failures and preserves generate metadata', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const upstreamFailures = [
      new UpstreamRequestError({ message: 'invalid upstream request', status: 400 }),
      new UpstreamRequestError({ message: 'upstream access denied', status: 403 }),
      new UpstreamRequestError({
        message: 'upstream quota exhausted',
        status: 429,
        headers: { retryAfter: '45' },
      }),
      new UpstreamRequestError({ message: 'upstream unavailable', status: 503 }),
    ];
    const proxyService = {
      handleGeminiGenerateContent: vi
        .fn()
        .mockRejectedValueOnce(upstreamFailures[0])
        .mockRejectedValueOnce(upstreamFailures[1])
        .mockRejectedValueOnce(upstreamFailures[2])
        .mockRejectedValueOnce(upstreamFailures[3])
        .mockResolvedValueOnce({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'hello' }] },
              finishReason: 'STOP',
              safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' }],
              groundingMetadata: { webSearchQueries: ['hello'] },
            },
          ],
          modelVersion: 'gemini-2.5-flash-latest',
          responseId: 'response-123',
          promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' },
        }),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };

    try {
      for (const [status, googleStatus] of [
        [400, 'INVALID_ARGUMENT'],
        [403, 'PERMISSION_DENIED'],
        [429, 'RESOURCE_EXHAUSTED'],
        [503, 'UNAVAILABLE'],
      ]) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1beta/models/gemini-2.5-flash:generateContent',
          headers,
          payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({
          error: { code: status, status: googleStatus },
        });
        if (status === 429) {
          expect(response.headers['retry-after']).toBe('45');
        }
      }

      const generated = await server.inject({
        method: 'POST',
        url: '/v1beta/models/gemini-2.5-flash:generateContent',
        headers,
        payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      });
      expect(generated.statusCode).toBe(200);
      expect(generated.json()).toMatchObject({
        modelVersion: 'gemini-2.5-flash-latest',
        responseId: 'response-123',
        promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' },
        candidates: [
          {
            index: 0,
            safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH' }],
            groundingMetadata: { webSearchQueries: ['hello'] },
          },
        ],
      });

      const countTokens = await server.inject({
        method: 'POST',
        url: '/v1beta/models/gemini-2.5-flash:countTokens',
        headers,
        payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      });
      expect(countTokens.statusCode).toBe(501);
      expect(countTokens.json()).toEqual({
        error: {
          code: 501,
          message: 'countTokens is not supported by the configured upstream.',
          status: 'UNIMPLEMENTED',
        },
      });

      const authFailure = await server.inject({
        method: 'GET',
        url: '/v1beta/models',
      });
      expect(authFailure.statusCode).toBe(401);
      expect(authFailure.json()).toEqual({
        error: {
          code: 401,
          message: 'API key validation failed',
          status: 'UNAUTHENTICATED',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('uses Google envelopes for v1beta parser failures through the assembled Fastify pipeline', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const headers = {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    };
    const malformedApp = await createHttpApp({ handleGeminiGenerateContent: vi.fn() });
    const malformedServer = malformedApp.getHttpAdapter().getInstance();

    try {
      const malformed = await malformedServer.inject({
        method: 'POST',
        url: '/v1beta/models/gemini-2.5-flash:generateContent',
        headers,
        payload: '{"contents":',
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({
        error: {
          code: 400,
          message: "Body is not valid JSON but content-type is set to 'application/json'",
          status: 'INVALID_ARGUMENT',
        },
      });
    } finally {
      await malformedApp.close();
    }

    const limitedApp = await createHttpApp({ handleGeminiGenerateContent: vi.fn() }, 1);
    const limitedServer = limitedApp.getHttpAdapter().getInstance();

    try {
      const tooLarge = await limitedServer.inject({
        method: 'POST',
        url: '/v1beta/models/gemini-2.5-flash:generateContent',
        headers,
        payload: '{"contents":[]}',
      });
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json()).toEqual({
        error: {
          code: 413,
          message: 'Request body is too large',
          status: 'RESOURCE_EXHAUSTED',
        },
      });
    } finally {
      await limitedApp.close();
    }
  });

  it('sanitizes unknown non-HTTP failures under the assembled v1beta route', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const app = await createHttpApp({
      handleGeminiGenerateContent: vi
        .fn()
        .mockRejectedValue(new Error('internal implementation detail')),
    });
    const server = app.getHttpAdapter().getInstance();

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1beta/models/gemini-2.5-flash:generateContent',
        headers: { authorization: 'Bearer test-key' },
        payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 500, message: 'Internal Server Error', status: 'INTERNAL' },
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

  it('lists Antigravity public catalog models alongside discovered chat models', () => {
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
    expect(ids).toContain('gemini-3-pro-image');
    expect(ids).toContain('gemini-imagecraft-chat');

    for (const defaultModel of ['gemini-3-flash', 'gemini-3-pro-image']) {
      const modelReply = createReplyMock();
      controller.getModel(defaultModel, modelReply as any);

      expect(modelReply.status).toHaveBeenCalledWith(200);
      expect(modelReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ id: defaultModel, object: 'model' }),
      );
    }
  });

  it('lists every exact configured routing alias without advertising wildcard mappings', () => {
    vi.mocked(getServerConfig).mockReturnValue({
      custom_mapping: {
        'custom-exact': 'gemini-3-flash',
        'custom-*': 'gemini-3-flash',
        duplicate: 'gemini-3-flash',
      },
      anthropic_mapping: {
        'anthropic-exact': 'claude-sonnet-4-6-thinking',
        duplicate: 'claude-sonnet-4-6-thinking',
        'anthropic-*': 'claude-sonnet-4-6-thinking',
      },
    } as never);
    const controller = new ProxyController({ handleChatCompletions: vi.fn() } as any);
    const listReply = createReplyMock();
    const modelReply = createReplyMock();

    controller.listModels(listReply as any);
    controller.getModel('anthropic-exact', modelReply as any);

    const ids = listReply.send.mock.calls[0][0].data.map((model: { id: string }) => model.id);
    expect(ids).toEqual(expect.arrayContaining(['custom-exact', 'anthropic-exact', 'duplicate']));
    expect(ids).not.toEqual(expect.arrayContaining(['custom-*', 'anthropic-*']));
    expect(ids.filter((id: string) => id === 'duplicate')).toHaveLength(1);
    expect(modelReply.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'anthropic-exact', object: 'model' }),
    );
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

  it.each(['tool_calls', 'function_call'])(
    'normalizes legacy completion finish reason %s',
    async (finishReason) => {
      const proxyService = {
        handleChatCompletions: vi.fn().mockResolvedValue({
          id: 'chatcmpl_legacy_finish',
          created: 1700000000,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              finish_reason: finishReason,
              message: { role: 'assistant', content: 'legacy output' },
            },
          ],
        }),
      };
      const controller = new ProxyController(proxyService as any);
      const reply = createReplyMock();

      await controller.completions({ model: 'gpt-4o', prompt: 'hi' }, reply as any);

      expect(reply.send.mock.calls[0][0].choices[0].finish_reason).toBe('stop');
    },
  );

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
        tools: [
          {
            type: 'function',
            name: 'search_docs',
            description: 'Search indexed documentation',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
            strict: true,
          },
        ],
        tool_choice: { type: 'function', name: 'search_docs' },
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
    expect(callArg.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'search_docs',
          description: 'Search indexed documentation',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
          strict: true,
        },
      },
    ]);
    expect(callArg.tool_choice).toEqual({ type: 'function', function: { name: 'search_docs' } });
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'resp_resp',
        object: 'response',
        model: 'gpt-4o',
        instructions: 'Follow the tool protocol',
        max_output_tokens: null,
        metadata: {},
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: null,
        status: 'completed',
        store: false,
        temperature: 1,
        text: { format: { type: 'text' } },
        tool_choice: { type: 'function', name: 'search_docs' },
        tools: [
          {
            type: 'function',
            name: 'search_docs',
            description: 'Search indexed documentation',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
            strict: true,
          },
        ],
        top_p: 1,
        truncation: 'disabled',
        output: [
          expect.objectContaining({
            id: 'msg_resp',
            type: 'message',
            role: 'assistant',
            status: 'completed',
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

  it('allocates unique non-stream Responses function-call output IDs without changing call IDs', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_response',
        created: 1700000002,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'first', arguments: '{}' },
                },
                {
                  id: '1',
                  type: 'function',
                  function: { name: 'second', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses({ model: 'gpt-4o', input: 'Call both tools.' }, reply as any);

    const output = reply.send.mock.calls[0][0].output;
    expect(output.map((item: { id: string }) => item.id)).toEqual(['fc_1', 'fc_1_2']);
    expect(output.map((item: { call_id: string }) => item.call_id)).toEqual(['call_1', '1']);
    expect(output.map((item: { name: string }) => item.name)).toEqual(['first', 'second']);
  });

  it('avoids collisions between generated Responses output suffixes and later normalized IDs', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_response',
        created: 1700000003,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'first', arguments: '{}' },
                },
                {
                  id: '1',
                  type: 'function',
                  function: { name: 'second', arguments: '{}' },
                },
                {
                  id: 'call_1_2',
                  type: 'function',
                  function: { name: 'third', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses({ model: 'gpt-4o', input: 'Call three tools.' }, reply as any);

    const output = reply.send.mock.calls[0][0].output;
    expect(output.map((item: { id: string }) => item.id)).toEqual(['fc_1', 'fc_1_2', 'fc_1_2_2']);
    expect(output.map((item: { call_id: string }) => item.call_id)).toEqual([
      'call_1',
      '1',
      'call_1_2',
    ]);
  });

  it('keeps a non-colliding Responses function-call output ID unchanged', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_response',
        created: 1700000004,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_ordinary',
                  type: 'function',
                  function: { name: 'ordinary', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses({ model: 'gpt-4o', input: 'Call one tool.' }, reply as any);

    const output = reply.send.mock.calls[0][0].output;
    expect(output).toEqual([
      expect.objectContaining({ id: 'fc_ordinary', call_id: 'call_ordinary', name: 'ordinary' }),
    ]);
  });

  it('groups consecutive Responses function calls and preserves ordered tool outputs', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_resp',
        object: 'chat.completion',
        created: 1700000001,
        model: 'gpt-4o',
        choices: [{ index: 0, finish_reason: 'stop', message: { content: 'done' } }],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gemini-3-flash',
        input: [
          { type: 'message', role: 'user', content: 'Look up both cities.' },
          {
            type: 'function_call',
            call_id: 'call_paris',
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
          },
          {
            type: 'function_call',
            call_id: 'call_tokyo',
            name: 'get_weather',
            arguments: '{"city":"Tokyo"}',
          },
          { type: 'function_call_output', call_id: 'call_paris', output: 'Paris: 18 C' },
          { type: 'function_call_output', call_id: 'call_tokyo', output: 'Tokyo: 24 C' },
        ],
      },
      reply as any,
    );

    const chatRequest = proxyService.handleChatCompletions.mock.calls[0][0];
    expect(chatRequest.messages).toEqual([
      { role: 'user', content: 'Look up both cities.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_paris',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
          {
            id: 'call_tokyo',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_paris', name: 'get_weather', content: 'Paris: 18 C' },
      { role: 'tool', tool_call_id: 'call_tokyo', name: 'get_weather', content: 'Tokyo: 24 C' },
    ]);

    const converter = new ProxyService({} as never, {} as never) as unknown as {
      convertOpenAIToClaude: (
        request: typeof chatRequest,
      ) => Parameters<typeof transformClaudeRequestIn>[0];
    };
    const body = transformClaudeRequestIn(converter.convertOpenAIToClaude(chatRequest));

    expect(body.request.contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
    expect(body.request.contents[1]?.parts.map((part) => part.functionCall?.id)).toEqual([
      'call_paris',
      'call_tokyo',
    ]);
    expect(body.request.contents[2]?.parts.map((part) => part.functionResponse?.id)).toEqual([
      'call_paris',
      'call_tokyo',
    ]);
  });

  it('groups Responses function calls separated by replayed reasoning and preserves ordered tool outputs', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_resp',
        object: 'chat.completion',
        created: 1700000001,
        model: 'gpt-4o',
        choices: [{ index: 0, finish_reason: 'stop', message: { content: 'done' } }],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gemini-3-flash',
        input: [
          { type: 'message', role: 'user', content: 'Look up both cities.' },
          {
            type: 'function_call',
            call_id: 'call_paris',
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
          },
          { type: 'reasoning', encrypted_content: 'replayed metadata' },
          {
            type: 'function_call',
            call_id: 'call_tokyo',
            name: 'get_weather',
            arguments: '{"city":"Tokyo"}',
          },
          { type: 'function_call_output', call_id: 'call_paris', output: 'Paris: 18 C' },
          { type: 'function_call_output', call_id: 'call_tokyo', output: 'Tokyo: 24 C' },
        ],
      },
      reply as any,
    );

    const chatRequest = proxyService.handleChatCompletions.mock.calls[0][0];
    expect(chatRequest.messages).toEqual([
      { role: 'user', content: 'Look up both cities.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_paris',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
          {
            id: 'call_tokyo',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_paris', name: 'get_weather', content: 'Paris: 18 C' },
      { role: 'tool', tool_call_id: 'call_tokyo', name: 'get_weather', content: 'Tokyo: 24 C' },
    ]);

    const converter = new ProxyService({} as never, {} as never) as unknown as {
      convertOpenAIToClaude: (
        request: typeof chatRequest,
      ) => Parameters<typeof transformClaudeRequestIn>[0];
    };
    const body = transformClaudeRequestIn(converter.convertOpenAIToClaude(chatRequest));

    expect(body.request.contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
    expect(body.request.contents[1]?.parts.map((part) => part.functionCall?.id)).toEqual([
      'call_paris',
      'call_tokyo',
    ]);
    expect(body.request.contents[2]?.parts.map((part) => part.functionResponse?.id)).toEqual([
      'call_paris',
      'call_tokyo',
    ]);
  });

  it('marks non-stream Responses output as incomplete when Chat reaches its length limit', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_length',
        created: 1700000005,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: { content: 'cut off' },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses({ model: 'gpt-4o', input: 'hi' }, reply as any);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        incomplete_details: { reason: 'max_output_tokens' },
        output: [expect.objectContaining({ status: 'incomplete', type: 'message' })],
        status: 'incomplete',
      }),
    );
  });

  it.each(['content_filter', 'SAFETY', 'recitation'])(
    'maps non-stream Responses finish reason %s to content_filter',
    async (finishReason) => {
      const proxyService = {
        handleChatCompletions: vi.fn().mockResolvedValue({
          id: 'chatcmpl_filtered',
          created: 1700000006,
          model: 'gpt-4o',
          choices: [{ finish_reason: finishReason, message: { content: '' } }],
        }),
      };
      const controller = new ProxyController(proxyService as any);
      const reply = createReplyMock();

      await controller.responses({ model: 'gpt-4o', input: 'hi' }, reply as any);

      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          incomplete_details: { reason: 'content_filter' },
          status: 'incomplete',
        }),
      );
    },
  );

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
      expect.objectContaining({
        parallel_tool_calls: true,
        tool_choice: 'auto',
        tools: [],
      }),
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

  it.each([
    [
      'a malformed tool call entry',
      {
        model: 'gpt-4o',
        messages: [{ role: 'assistant', content: null, tool_calls: [{}] }],
      },
      'messages[0].tool_calls[0].type',
    ],
    [
      'a tool result without a tool call id',
      {
        model: 'gpt-4o',
        messages: [{ role: 'tool', content: 'result' }],
      },
      'messages[0].tool_call_id',
    ],
    [
      'a tool result with an empty tool call id',
      {
        model: 'gpt-4o',
        messages: [{ role: 'tool', tool_call_id: '   ', content: 'result' }],
      },
      'messages[0].tool_call_id',
    ],
  ])(
    'rejects chat completions containing %s before an upstream call',
    async (_caseName, body, param) => {
      const proxyService = { handleChatCompletions: vi.fn() };
      const controller = new ProxyController(proxyService as any);
      const reply = createReplyMock();

      await expect(controller.chatCompletions(body as any, reply as any)).rejects.toMatchObject({
        status: 400,
        protocolError: { param },
      });
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    },
  );

  it('rejects orphan Responses function-call output before an upstream call', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await expect(
      controller.responses(
        {
          model: 'gpt-4o',
          input: [
            { type: 'message', role: 'user', content: 'Use a tool.' },
            { type: 'function_call_output', call_id: 'call_missing', output: 'result' },
          ],
        },
        reply as any,
      ),
    ).rejects.toMatchObject({
      status: 400,
      protocolError: { param: 'input[1].call_id' },
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
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
        tool_choice: { type: 'function', name: 'lookup' },
      },
      reply as any,
    );

    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(reply.send).toHaveBeenCalledWith(stream);
    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        tool_choice: { type: 'function', function: { name: 'lookup' } },
      }),
      'responses',
      expect.objectContaining({
        instructions: 'stream output',
        temperature: 1,
        top_p: 1,
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
        tool_choice: { type: 'function', name: 'lookup' },
      }),
    );
  });

  it('writes a safe sequenced Responses error event for a transport-level stream failure', () => {
    const controller = new ProxyController({} as any);
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };
    const reply = { hijack: vi.fn(), raw };
    const stream = concat(
      of('event: response.in_progress\ndata: {"sequence_number":4}\n\n'),
      throwError(() => new Error('transport broke')),
    );

    (controller as any).writeSseResponse(reply, stream, 'responses');

    expect(raw.write).toHaveBeenLastCalledWith(
      'event: error\ndata: {"code":"server_error","message":"Internal Server Error","param":null,"sequence_number":5,"type":"error"}\n\n',
    );
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid_request_error', 400],
    ['authentication_error', 401],
    ['billing_error', 402],
    ['permission_error', 403],
    ['not_found_error', 404],
    ['conflict_error', 409],
    ['request_too_large', 413],
    ['rate_limit_error', 429],
    ['api_error', 500],
    ['timeout_error', 504],
    ['overloaded_error', 529],
  ])('preserves Anthropic SSE error type %s for status %i after partial output', (type, status) => {
    const controller = new ProxyController({} as any);
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };
    const reply = { hijack: vi.fn(), raw };
    const stream = concat(
      of('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'),
      throwError(() => new UpstreamRequestError({ message: 'upstream failure', status })),
    );

    (controller as any).writeSseResponse(reply, stream, 'anthropic');

    expect(raw.write).toHaveBeenNthCalledWith(
      2,
      `event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type, message: 'upstream failure' },
      })}\n\n`,
    );
    expect(raw.write.mock.calls.flat().join('')).not.toContain('[DONE]');
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('sanitizes unexpected Anthropic SSE failures after partial output', () => {
    const controller = new ProxyController({} as any);
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };
    const reply = { hijack: vi.fn(), raw };
    const stream = concat(
      of('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'),
      throwError(() => new Error('internal implementation detail')),
    );

    (controller as any).writeSseResponse(reply, stream, 'anthropic');

    expect(raw.write).toHaveBeenLastCalledWith(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Internal Server Error"}}\n\n',
    );
    expect(raw.write.mock.calls.flat().join('')).not.toContain('[DONE]');
    expect(raw.end).toHaveBeenCalledOnce();
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
        image: 'data:image/png;base64,AQID',
        reference_images: ['data:image/jpeg;base64,BAUG'],
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

  it('returns the OpenAI multipart parse error shape for an image edit without a boundary', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
      {},
      { headers: { 'content-type': 'multipart/form-data' } } as any,
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'Invalid boundary for multipart/form-data request.',
        type: 'invalid_request_error',
        param: null,
        code: 'multipart_parse_error',
      },
    });
    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
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
      { prompt: 'make it brighter', image: 'data:image/png;base64,AQID' },
      { headers: { 'content-type': 'application/json' } } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-3-pro-image' }),
    );
  });

  it('maps raw JSON base64 image inputs with a detected PNG signature while preserving explicit MIME types', async () => {
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
        image: 'iVBORw0KGgo=',
        reference_images: [{ data: 'CgsM', mimeType: 'image/webp' }],
      },
      { headers: { 'content-type': 'application/json' } } as any,
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
              },
              {
                type: 'image_url',
                image_url: { url: 'data:image/webp;base64,CgsM' },
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

  it.each([
    [{ type: 'auto' }, { mode: 'auto' }],
    [{ type: 'any' }, { mode: 'any' }],
    [{ type: 'none' }, { mode: 'none' }],
    [
      { type: 'tool', name: 'lookup' },
      { mode: 'tool', name: 'lookup' },
    ],
  ])(
    'passes the valid Anthropic tool choice %o through the assembled messages route',
    async (toolChoice, _expected) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = {
        handleAnthropicMessages: vi.fn().mockResolvedValue({ id: 'msg_1', type: 'message' }),
      };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers: { authorization: 'Bearer test-key' },
          payload: {
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: 'hello' }],
            tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
            tool_choice: toolChoice,
          },
        });

        expect(response.statusCode).toBe(200);
        expect(proxyService.handleAnthropicMessages).toHaveBeenCalledWith(
          expect.objectContaining({ tool_choice: expect.objectContaining(toolChoice) }),
        );
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    { type: 'tool', name: 'missing' },
    { type: 'tool' },
    { type: 'required' },
    { type: 'auto', disable_parallel_tool_use: true },
    { type: 'auto', disable_parallel_tool_use: 'yes' },
  ])(
    'rejects invalid Anthropic tool choice %o before the assembled messages upstream call',
    async (toolChoice) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = { handleAnthropicMessages: vi.fn() };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/messages',
          headers: { authorization: 'Bearer test-key' },
          payload: {
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: 'hello' }],
            tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
            tool_choice: toolChoice,
          },
        });

        expect(response.statusCode).toBe(400);
        expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it('rejects Anthropic tool_choice any without tool declarations before the assembled messages upstream call', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer test-key' },
        payload: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'hello' }],
          tool_choice: { type: 'any' },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
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

  it('accepts parameterized, whitespace-wrapped image data URLs on Chat and Responses paths', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_parameterized_data_url',
        created: 1700000003,
        model: 'gpt-4o',
        choices: [{ message: { content: 'done' } }],
      }),
      handleAnthropicMessages: vi.fn(),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };
    const imageUrl = 'DATA:IMAGE/PNG;charset=utf-8;BASE64,QU\nJDRA==';

    try {
      for (const [url, payload] of [
        [
          '/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages: [
              { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] },
            ],
          },
        ],
        [
          '/v1/responses',
          {
            model: 'gpt-4o',
            input: [{ role: 'user', content: [{ type: 'input_image', image_url: imageUrl }] }],
          },
        ],
      ] as Array<[string, Record<string, unknown>]>) {
        const response = await server.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode, response.body).toBe(200);
      }
      expect(proxyService.handleChatCompletions).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('converts parameterized, whitespace-wrapped image data URLs into normalized Anthropic image blocks', () => {
    const service = new ProxyService({} as never, {} as never) as unknown as {
      convertOpenAIToClaude: (request: {
        model: string;
        messages: Array<{
          role: 'user';
          content: Array<{ type: 'image_url'; image_url: { url: string } }>;
        }>;
      }) => {
        messages: Array<{ content: unknown }>;
      };
    };

    const result = service.convertOpenAIToClaude({
      model: 'claude-test',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'DATA:IMAGE/PNG;charset=utf-8;BASE64,QU\nJDRA==' },
            },
          ],
        },
      ],
    });

    expect(result.messages[0]?.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'QUJDRA==' },
      },
    ]);

    const rejectedDataUrl = service.convertOpenAIToClaude({
      model: 'claude-test',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:text/html;base64,PGgxPk5vPC9oMT4=' },
            },
          ],
        },
      ],
    });
    expect(rejectedDataUrl.messages[0]?.content).toBe('');
  });

  it('rejects non-image JSON image edits and normalizes accepted composite image data URLs', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'data:image/png;base64,UkVTVUxU' } }],
      }),
      handleAnthropicMessages: vi.fn(),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };

    try {
      for (const [payload, param] of [
        [{ prompt: 'edit', image: 'data:text/html;base64,PGgxPk5vPC9oMT4=' }, 'image'],
        [
          {
            prompt: 'edit',
            image: 'iVBORw0KGgo=',
            reference_images: [{ data: 'QUJDRA==', mimeType: 'text/html' }],
          },
          'reference_images',
        ],
      ] as Array<[Record<string, unknown>, string]>) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/images/edits',
          headers,
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: { type: 'invalid_request_error', param, code: 'invalid_value' },
        });
      }

      const response = await server.inject({
        method: 'POST',
        url: '/v1/images/edits',
        headers,
        payload: { prompt: 'edit', image: 'DATA:IMAGE/PNG;charset=utf-8;BASE64,QU\nJDRA==' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(proxyService.handleChatCompletions).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              content: expect.arrayContaining([
                { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDRA==' } },
              ]),
            }),
          ],
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('rejects malformed image data URLs on Chat and Responses paths before upstream', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const headers = { authorization: 'Bearer test-key' };

    try {
      for (const [url, payload, param] of [
        [
          '/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: 'data:text/plain;base64,QUJDRA==' } },
                ],
              },
            ],
          },
          'messages',
        ],
        [
          '/v1/responses',
          {
            model: 'gpt-4o',
            input: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_image',
                    image_url: 'data:text/plain;base64,QUJDRA==',
                  },
                ],
              },
            ],
          },
          'input.content',
        ],
        [
          '/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: { url: 'data:application/octet-stream;base64,QUJDRA==' },
                  },
                ],
              },
            ],
          },
          'messages',
        ],
        [
          '/v1/responses',
          {
            model: 'gpt-4o',
            input: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_image',
                    image_url: 'data:application/octet-stream;base64,QUJDRA==',
                  },
                ],
              },
            ],
          },
          'input.content',
        ],
        [
          '/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: 'data:image/png;base64,QU=JDRA==' } },
                ],
              },
            ],
          },
          'messages',
        ],
        [
          '/v1/responses',
          {
            model: 'gpt-4o',
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_image', image_url: 'data:image/png;charset;base64,QUJDRA==' },
                ],
              },
            ],
          },
          'input.content',
        ],
        [
          '/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' } }],
              },
            ],
          },
          'messages',
        ],
        [
          '/v1/responses',
          {
            model: 'gpt-4o',
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_image', image_url: 'data:image/png;base64,QUJDRA==;ignored' },
                ],
              },
            ],
          },
          'input.content',
        ],
      ] as Array<[string, Record<string, unknown>, string]>) {
        const response = await server.inject({ method: 'POST', url, headers, payload });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: {
            message: `${param} must contain a valid base64 image data URL`,
            type: 'invalid_request_error',
            param,
            code: 'invalid_value',
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
        expect.objectContaining({
          parallel_tool_calls: true,
          tool_choice: 'auto',
          tools: [],
        }),
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
        ['/v1/responses', responsesBase, 'include', ['reasoning.encrypted_content']],
        ['/v1/responses', responsesBase, 'service_tier', 'priority'],
        ['/v1/responses', responsesBase, 'prompt_cache_key', 'cache-key'],
        ['/v1/responses', responsesBase, 'prompt_cache_retention', '24h'],
        ['/v1/responses', responsesBase, 'safety_identifier', 'safety-id'],
        ['/v1/responses', responsesBase, 'conversation', 'conv_123'],
        ['/v1/responses', responsesBase, 'prompt', { id: 'pmpt_123' }],
        ['/v1/responses', responsesBase, 'top_logprobs', 2],
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

  it('rejects Responses user before an upstream call', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
    const app = await createHttpApp(proxyService);

    try {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/responses',
          headers: { authorization: 'Bearer test-key' },
          payload: { model: 'gpt-4o', input: 'hi', user: 'end-user-42' },
        });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        param: 'user',
        code: 'unsupported_parameter',
      });
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('preserves valid Responses metadata without forwarding it upstream', async () => {
    vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_metadata',
        created: 1700000010,
        model: 'gpt-4o',
        choices: [{ message: { content: 'done' } }],
      }),
      handleAnthropicMessages: vi.fn(),
    };
    const app = await createHttpApp(proxyService);
    const server = app.getHttpAdapter().getInstance();
    const metadata = { request_id: 'req_123', tenant: 'example' };

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { authorization: 'Bearer test-key' },
        payload: { model: 'gpt-4o', input: 'hi', metadata },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().metadata).toEqual(metadata);
      expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
        expect.not.objectContaining({ metadata: expect.anything() }),
        'responses',
        expect.objectContaining({ metadata }),
      );
    } finally {
      await app.close();
    }
  });

  it.each([null, [], { valid: 1 }, { nested: { value: 'nope' } }])(
    'rejects invalid Responses metadata %j before upstream',
    async (metadata) => {
      vi.mocked(getServerConfig).mockReturnValue({ api_key: 'test-key' } as never);
      const proxyService = { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() };
      const app = await createHttpApp(proxyService);
      const server = app.getHttpAdapter().getInstance();

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/responses',
          headers: { authorization: 'Bearer test-key' },
          payload: { model: 'gpt-4o', input: 'hi', metadata },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatchObject({
          message: 'metadata must be an object with string values',
          param: 'metadata',
        });
        expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

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
