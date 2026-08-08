import { afterEach, describe, expect, it, vi } from 'vitest';
import { of, Subject, throwError } from 'rxjs';
import { EventEmitter } from 'node:events';

import { ProxyController } from '../../modules/proxy-gateway/server/proxy.controller';
import { OpenAIResponsesSessionStore } from '../../modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';
import { UpstreamRequestError } from '../../modules/proxy-gateway/server/common/exceptions/upstream-request-exception';
import { ModelRouteError } from '../../modules/proxy-gateway/server/common/exceptions/model-route-exception';
import {
  attachUpstreamBackpressure,
  pauseObservableUpstream,
  resumeObservableUpstream,
} from '../../modules/proxy-gateway/server/common/stream-backpressure';
import { attachModelRouteMetadata } from '../../modules/proxy-gateway/server/common/model-route-metadata';

const generatedPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]).toString('base64');

function createReplyMock() {
  const reply: Record<string, any> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

function createMultipartRequest(
  parts: Array<
    | { fieldname: string; type: 'field'; value: string }
    | {
        data: Buffer;
        fieldname: string;
        filename: string;
        mimetype: string;
        type: 'file';
      }
  >,
) {
  return {
    headers: {
      'content-type': 'multipart/form-data; boundary=----parity',
    },
    isMultipart: () => true,
    async *parts() {
      for (const part of parts) {
        if (part.type === 'field') {
          yield {
            ...part,
            encoding: '7bit',
            fields: {},
            fieldnameTruncated: false,
            mimetype: 'text/plain',
            valueTruncated: false,
          };
        } else {
          yield {
            ...part,
            encoding: '7bit',
            fields: {},
            toBuffer: async () => part.data,
          };
        }
      }
    },
  };
}

describe('ProxyController Integration', () => {
  afterEach(() => {
    OpenAIResponsesSessionStore.clear();
  });

  it('preserves Responses tool choice and sampling compatibility fields', () => {
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: 'update the file',
      tool_choice: { type: 'function', function: { name: 'apply_patch' } },
      presence_penalty: 0.25,
      frequency_penalty: 0.5,
      seed: 42,
    });

    expect(prepared?.request).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'apply_patch' } },
      presence_penalty: 0.25,
      frequency_penalty: 0.5,
      seed: 42,
    });
  });

  it('drops incomplete custom calls and their matching outputs from Responses history', () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    } as any);

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        {
          type: 'custom_tool_call',
          call_id: 'call_incomplete',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
          status: 'incomplete',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_incomplete',
          output: 'failed',
        },
        {
          type: 'message',
          role: 'user',
          content: 'Continue without the incomplete call.',
        },
      ],
    });

    expect(prepared?.request.messages).toEqual([
      {
        role: 'user',
        content: 'Continue without the incomplete call.',
      },
    ]);
  });

  it('drops orphan custom tool outputs from Responses history', () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    } as any);

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        {
          type: 'custom_tool_call_output',
          call_id: 'call_missing',
          output: 'No matching call exists.',
        },
        {
          type: 'message',
          role: 'user',
          content: 'Continue without the orphan output.',
        },
      ],
    });

    expect(prepared?.request.messages).toEqual([
      {
        role: 'user',
        content: 'Continue without the orphan output.',
      },
    ]);
  });

  it('compacts repeated apply_patch failures in Responses history', () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    } as any);
    const failure = [
      'apply_patch verification failed',
      'Failed to find expected lines in src/example.ts:',
      'const value = 1;',
    ].join('\n');

    const prepared = controller.prepareResponsesRequest({
      model: 'gpt-5-codex',
      input: [
        {
          type: 'custom_tool_call',
          call_id: 'call_failure_1',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_failure_1',
          output: failure,
        },
        {
          type: 'custom_tool_call',
          call_id: 'call_failure_2',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_failure_2',
          output: failure,
        },
      ],
    });

    const toolMessages = prepared?.request.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toEqual([
      expect.objectContaining({ content: failure }),
      expect.objectContaining({
        content:
          '[Repeated apply_patch failure omitted: the same error was already provided earlier in this request.]',
      }),
    ]);
  });

  it('lists only discovered chat models instead of synthetic compatibility aliases', () => {
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
      getCatalogModelRoleIndex: vi.fn(() => undefined),
    };
    const controller = new ProxyController(proxyService as any, accountLeaseService as any);
    const reply = createReplyMock();

    controller.listModels(reply as any);

    expect(reply.status).toHaveBeenCalledWith(200);
    const payload = reply.send.mock.calls[0][0];
    const ids = payload.data.map((model: { id: string }) => model.id);
    expect(ids).toEqual([
      'gemini-3-flash',
      'gemini-3-pro-image',
      'gemini-3.5-flash-low',
      'gemini-imagecraft-chat',
    ]);
    expect(ids).not.toContain('gpt-4o');
    expect(ids).not.toContain('claude-opus-4-6-thinking');
  });

  it('excludes provider-advertised non-chat service ids from the standard model list', () => {
    const proxyService = {
      handleChatCompletions: vi.fn(),
      handleAnthropicMessages: vi.fn(),
    };
    const accountLeaseService = {
      getAllCollectedModels: vi.fn(
        () =>
          new Set([
            'gemini-3-flash',
            'chat_20706',
            'chat_23310',
            'tab_flash_lite_preview',
            'tab_jump_flash_lite_preview',
          ]),
      ),
      getCatalogModelRoleIndex: vi.fn(() => undefined),
    };
    const controller = new ProxyController(proxyService as any, accountLeaseService as any);
    const reply = createReplyMock();

    controller.listModels(reply as any);

    const payload = reply.send.mock.calls[0][0];
    const ids = payload.data.map((model: { id: string }) => model.id);
    expect(ids).toEqual(['gemini-3-flash']);
  });

  it('reports configured routes separately from the standard model list', () => {
    const accountLeaseService = {
      getAllCollectedModels: vi.fn(() => new Set(['gemini-3-flash'])),
      getCatalogModelRoleIndex: vi.fn(() => undefined),
      getModelCatalogStatus: vi.fn(() => 'known'),
      getModelRouteAvailability: vi.fn(() => [
        {
          accountId: 'acc-1',
          exact: true,
          resolvedModel: 'gemini-3-flash',
          status: 'available',
        },
      ]),
    };
    const routingService = {
      getConfiguredRoutes: vi.fn(() => [
        {
          alias: 'my-fast',
          target: 'gemini-3-flash',
          enabled: true,
          source: 'configured',
          wildcard: false,
        },
      ]),
    };
    const availabilityService = {
      getSnapshot: vi.fn(() => []),
    };
    const controller = new ProxyController(
      {} as any,
      accountLeaseService as any,
      undefined,
      routingService as any,
      availabilityService as any,
    );
    const reply = createReplyMock();

    controller.listModelRoutes(reply as any);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        object: 'model_route_list',
        canonical_models: ['gemini-3-flash'],
        data: [
          expect.objectContaining({
            alias: 'my-fast',
            target: 'gemini-3-flash',
            target_status: 'known',
          }),
        ],
      }),
    );
  });

  it('keeps provider-advertised non-chat service ids visible in model-routes diagnostics', () => {
    const accountLeaseService = {
      getAllCollectedModels: vi.fn(
        () => new Set(['gemini-3-flash', 'chat_20706', 'tab_flash_lite_preview']),
      ),
      getCatalogModelRoleIndex: vi.fn(() => undefined),
      getModelCatalogStatus: vi.fn(() => 'known'),
      getModelRouteAvailability: vi.fn(() => []),
    };
    const routingService = {
      getConfiguredRoutes: vi.fn(() => []),
    };
    const availabilityService = {
      getSnapshot: vi.fn(() => []),
    };
    const controller = new ProxyController(
      {} as any,
      accountLeaseService as any,
      undefined,
      routingService as any,
      availabilityService as any,
    );
    const reply = createReplyMock();

    controller.listModelRoutes(reply as any);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        canonical_models: ['chat_20706', 'gemini-3-flash', 'tab_flash_lite_preview'],
        unpublished_catalog_ids: [
          { id: 'chat_20706', reason: 'override', roles: [] },
          { id: 'tab_flash_lite_preview', reason: 'override', roles: [] },
        ],
      }),
    );
  });

  it('names the provider role that withheld an id in model-routes diagnostics', () => {
    const accountLeaseService = {
      getAllCollectedModels: vi.fn(
        () => new Set(['gemini-3-flash', 'tab_lite_preview', 'commit_helper']),
      ),
      getCatalogModelRoleIndex: vi.fn(() => ({
        nonChatRoles: new Map([
          ['tab_lite_preview', ['tab']],
          ['commit_helper', ['commit_message']],
        ]),
        chatModelIds: new Set(['gemini-3-flash']),
        hasChatRoleData: true,
      })),
      getModelCatalogStatus: vi.fn(() => 'known'),
      getModelRouteAvailability: vi.fn(() => []),
    };
    const controller = new ProxyController(
      {} as any,
      accountLeaseService as any,
      undefined,
      { getConfiguredRoutes: vi.fn(() => []) } as any,
      { getSnapshot: vi.fn(() => []) } as any,
    );
    const reply = createReplyMock();

    controller.listModelRoutes(reply as any);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        canonical_models: ['commit_helper', 'gemini-3-flash', 'tab_lite_preview'],
        unpublished_catalog_ids: [
          { id: 'commit_helper', reason: 'role', roles: ['commit_message'] },
          { id: 'tab_lite_preview', reason: 'role', roles: ['tab'] },
        ],
      }),
    );
  });

  it('withholds provider role members from the standard model list', () => {
    const accountLeaseService = {
      getAllCollectedModels: vi.fn(() => new Set(['gemini-3-flash', 'tab_lite_preview'])),
      getCatalogModelRoleIndex: vi.fn(() => ({
        nonChatRoles: new Map([['tab_lite_preview', ['tab']]]),
        chatModelIds: new Set(['gemini-3-flash']),
        hasChatRoleData: true,
      })),
    };
    const controller = new ProxyController(
      { handleChatCompletions: vi.fn(), handleAnthropicMessages: vi.fn() } as any,
      accountLeaseService as any,
    );
    const reply = createReplyMock();

    controller.listModels(reply as any);

    const payload = reply.send.mock.calls[0][0];
    expect(payload.data.map((model: { id: string }) => model.id)).toEqual(['gemini-3-flash']);
  });

  it('returns recent model misses as part of the model routes response', () => {
    const accountLeaseService = {
      getAllCollectedModels: vi.fn(() => new Set(['gemini-3-flash'])),
      getCatalogModelRoleIndex: vi.fn(() => undefined),
      getModelCatalogStatus: vi.fn(() => 'known'),
      getModelRouteAvailability: vi.fn(() => []),
    };
    const routingService = {
      getConfiguredRoutes: vi.fn(() => []),
    };
    const availabilityService = {
      getSnapshot: vi.fn(() => []),
    };
    const modelRouteMissJournalService = {
      getSnapshot: vi.fn(() => [
        {
          model: 'model-not-found',
          count: 3,
          lastSeen: 1_700_000_123_456,
        },
      ]),
    };
    const controller = new ProxyController(
      {} as any,
      accountLeaseService as any,
      undefined,
      routingService as any,
      availabilityService as any,
      modelRouteMissJournalService as any,
    );
    const reply = createReplyMock();

    controller.listModelRoutes(reply as any);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        object: 'model_route_list',
        recent_misses: [
          {
            model: 'model-not-found',
            count: 3,
            lastSeen: 1_700_000_123_456,
          },
        ],
      }),
    );
  });

  it('clears recent model misses', () => {
    const missJournal = {
      clear: vi.fn(),
    };
    const controller = new ProxyController(
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      missJournal as any,
    );
    const reply = createReplyMock();

    controller.clearMissJournal(reply as any);

    expect(missJournal.clear).toHaveBeenCalledOnce();
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      object: 'model-route-miss-journal-cleared',
    });
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

  it('returns requested, resolved, and served model identity headers', async () => {
    const response = attachModelRouteMetadata(
      {
        id: 'chatcmpl-route',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'gemini-3-flash-001',
        choices: [],
      },
      {
        requestedModel: 'my-fast',
        resolvedModel: 'gemini-3-flash',
        servedModel: 'gemini-3-flash-001',
        routeSource: 'configured',
      },
    );
    const controller = new ProxyController({
      handleChatCompletions: vi.fn().mockResolvedValue(response),
    } as any);
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'my-fast',
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );

    expect(reply.header).toHaveBeenCalledWith('x-antigravity-requested-model', 'my-fast');
    expect(reply.header).toHaveBeenCalledWith('x-antigravity-resolved-model', 'gemini-3-flash');
    expect(reply.header).toHaveBeenCalledWith('x-antigravity-served-model', 'gemini-3-flash-001');
    expect(reply.header).toHaveBeenCalledWith('x-antigravity-fallback-policy', 'none');
  });

  it('pauses and resumes the exact upstream stream on socket backpressure', async () => {
    const source = new Subject<string>();
    const upstream = { pause: vi.fn(), resume: vi.fn() };
    const stream = attachModelRouteMetadata(attachUpstreamBackpressure(source, upstream as any), {
      requestedModel: 'my-fast',
      resolvedModel: 'gemini-3-flash',
      servedModel: 'gemini-3-flash',
      routeSource: 'configured',
    });
    const controller = new ProxyController({
      handleChatCompletions: vi.fn().mockResolvedValue(stream),
    } as any);
    const raw = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      writableEnded: boolean;
      write: ReturnType<typeof vi.fn>;
      writeHead: ReturnType<typeof vi.fn>;
    };
    raw.end = vi.fn();
    raw.writableEnded = false;
    raw.write = vi.fn().mockReturnValue(false);
    raw.writeHead = vi.fn();
    const reply = {
      raw,
      hijack: vi.fn(),
      header: vi.fn(),
      send: vi.fn(),
      status: vi.fn(),
    };

    await controller.chatCompletions(
      {
        model: 'my-fast',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );
    source.next('data: {"ok":true}\n\n');

    expect(upstream.pause).toHaveBeenCalledOnce();
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'x-antigravity-served-model': 'gemini-3-flash',
      }),
    );

    raw.emit('drain');
    expect(upstream.resume).toHaveBeenCalledOnce();

    raw.emit('close');
    expect(source.observed).toBe(false);
  });

  it('supports OpenAI completions compatibility endpoint', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl-test',
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
          {
            index: 1,
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: 'second candidate',
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
        id: 'cmpl-test',
        object: 'text_completion',
        model: 'gpt-4o',
        choices: [
          expect.objectContaining({
            text: 'hello from assistant',
            logprobs: null,
          }),
          expect.objectContaining({
            index: 1,
            text: 'second candidate',
            finish_reason: 'length',
          }),
        ],
      }),
    );
  });

  it('returns an OpenAI validation envelope without calling upstream', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        store: true,
      },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'stored Chat Completions are not implemented by this proxy',
        type: 'invalid_request_error',
        param: 'store',
        code: 'unsupported_parameter',
      },
    });
  });

  it('converts Chat SSE chunks into legacy text_completion chunks', async () => {
    const upstream = { pause: vi.fn(), resume: vi.fn() };
    const chatStream = attachUpstreamBackpressure(
      of(
        `data: ${JSON.stringify({
          id: 'chatcmpl-stream',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'gemini-3-flash',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          usage: null,
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-stream',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'gemini-3-flash',
          choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
          usage: null,
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-stream',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'gemini-3-flash',
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ),
      upstream as any,
    );
    const proxyService = { handleChatCompletions: vi.fn().mockResolvedValue(chatStream) };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.completions(
      {
        model: 'gemini-3-flash',
        prompt: 'hello',
        stream: true,
        stream_options: { include_usage: true },
      },
      reply as any,
    );

    const convertedStream = reply.send.mock.calls[0][0];
    pauseObservableUpstream(convertedStream);
    resumeObservableUpstream(convertedStream);
    expect(upstream.pause).toHaveBeenCalledOnce();
    expect(upstream.resume).toHaveBeenCalledOnce();
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      convertedStream.subscribe({
        next: (chunk: string) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });
    const payloads = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));

    expect(payloads.every((payload) => payload.object === 'text_completion')).toBe(true);
    expect(payloads.every((payload) => payload.id === 'cmpl-stream')).toBe(true);
    expect(
      payloads.flatMap((payload) => payload.choices).some((choice) => choice.text === 'hello'),
    ).toBe(true);
    expect(payloads.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n');
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
        metadata: { session_id: 'responses-session-1' },
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
      },
      reply as any,
    );

    const callArg = proxyService.handleChatCompletions.mock.calls[0][0];
    expect(callArg.messages[0]).toEqual({
      role: 'system',
      content: 'Follow the tool protocol',
    });
    expect(callArg.extra).toMatchObject({ session_id: 'responses-session-1' });
    expect(callArg.messages.some((message: { role: string }) => message.role === 'assistant')).toBe(
      true,
    );
    expect(callArg.messages.some((message: { role: string }) => message.role === 'tool')).toBe(
      true,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        object: 'response',
        model: 'gpt-4o',
        output: [
          expect.objectContaining({
            content: [
              expect.objectContaining({
                text: 'normalized response',
                type: 'output_text',
              }),
            ],
            type: 'message',
          }),
        ],
        status: 'completed',
        type: 'response',
        usage: expect.objectContaining({
          input_tokens: 10,
          output_tokens: 6,
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
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ subscribe: expect.any(Function) }),
    );
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

  it('preserves apply_patch custom tool calls in /v1/responses', async () => {
    const patch = '*** Begin Patch\n*** Update File: src/example.ts\n*** End Patch';
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'chatcmpl_resp_patch',
        object: 'chat.completion',
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
                  id: 'call_patch_2',
                  type: 'function',
                  function: {
                    name: 'apply_patch',
                    arguments: JSON.stringify({ command: ['apply_patch', patch] }),
                  },
                },
              ],
            },
          },
        ],
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
            type: 'custom_tool_call',
            call_id: 'call_patch_1',
            name: 'apply_patch',
            input: patch,
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_patch_1',
            output: 'Done',
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

    expect(assistantMessage?.tool_calls?.[0]).toMatchObject({
      custom_input: patch,
      function: { name: 'apply_patch' },
    });
    expect(toolMessage).toMatchObject({
      content: 'Done',
      name: 'apply_patch',
      tool_call_id: 'call_patch_1',
    });
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        output: [
          expect.objectContaining({
            call_id: 'call_patch_2',
            input: patch,
            name: 'apply_patch',
            type: 'custom_tool_call',
          }),
        ],
      }),
    );
  });

  it('continues a Responses conversation from previous_response_id', async () => {
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'resp_previous_1',
          object: 'chat.completion',
          created: 1700000004,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { content: 'First answer' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        .mockResolvedValueOnce({
          id: 'resp_previous_2',
          object: 'chat.completion',
          created: 1700000005,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { content: 'Second answer' },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
    };
    const controller = new ProxyController(proxyService as any);

    await controller.responses(
      { input: 'First question', model: 'gpt-4o' },
      createReplyMock() as any,
    );
    await controller.responses(
      { input: 'Second question', previous_response_id: 'resp_previous_1' },
      createReplyMock() as any,
    );

    const continuationRequest = proxyService.handleChatCompletions.mock.calls[1][0];
    expect(continuationRequest).toMatchObject({ model: 'gpt-4o' });
    expect(continuationRequest.messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ]);
  });

  it('does not inherit instructions across previous_response_id', async () => {
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'resp_instruction_1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4o',
          choices: [{ index: 0, finish_reason: 'stop', message: { content: 'First answer' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        .mockResolvedValueOnce({
          id: 'resp_instruction_2',
          object: 'chat.completion',
          created: 2,
          model: 'gpt-4o',
          choices: [{ index: 0, finish_reason: 'stop', message: { content: 'Second answer' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
    };
    const controller = new ProxyController(proxyService as any);

    await controller.responses(
      { input: 'First question', instructions: 'First-turn only', model: 'gpt-4o' },
      createReplyMock() as any,
    );
    await controller.responses(
      { input: 'Second question', previous_response_id: 'resp_instruction_1' },
      createReplyMock() as any,
    );

    expect(proxyService.handleChatCompletions.mock.calls[1][0].messages).not.toContainEqual(
      expect.objectContaining({ role: 'system' }),
    );
  });

  it('keeps store=false Responses out of the persistent continuation store', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        id: 'resp_ephemeral',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, finish_reason: 'stop', message: { content: 'Done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };
    const controller = new ProxyController(proxyService as any);

    await controller.responses(
      { input: 'Ephemeral', model: 'gpt-4o', store: false },
      createReplyMock() as any,
    );

    expect(OpenAIResponsesSessionStore.get('resp_ephemeral')).toBeNull();
  });

  it('rejects unsupported background Responses with an OpenAI error contract', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      { background: true, input: 'Run later', model: 'gpt-4o' },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'unsupported_parameter',
        message: 'background Responses are not implemented by this proxy',
        param: 'background',
        type: 'invalid_request_error',
      },
    });
  });

  it('maps extended Responses reasoning efforts onto Gemini-supported tiers', () => {
    const controller = new ProxyController({ handleChatCompletions: vi.fn() } as any);

    expect(
      controller.prepareResponsesRequest({
        input: 'Think hard',
        model: 'gemini-3-pro',
        reasoning: { effort: 'xhigh', summary: 'auto' },
      })?.request,
    ).toMatchObject({
      reasoning_effort: 'high',
      thinking: { type: 'enabled', effort: 'high' },
    });
    expect(
      controller.prepareResponsesRequest({
        input: 'Do not reason',
        model: 'gemini-3-pro',
        reasoning: { effort: 'none' },
      })?.request,
    ).toMatchObject({ thinking: { type: 'disabled' } });
  });

  it('repairs an apply_patch call when a compacted continuation only sends its output', async () => {
    const patch = '*** Begin Patch\n*** Add File: src/new.ts\n+export {};\n*** End Patch';
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'resp_compaction_1',
          object: 'chat.completion',
          created: 1700000006,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call_patch_compacted',
                    type: 'function',
                    function: {
                      name: 'apply_patch',
                      arguments: JSON.stringify({ command: ['apply_patch', patch] }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        .mockResolvedValueOnce({
          id: 'resp_compaction_2',
          object: 'chat.completion',
          created: 1700000007,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { content: 'Applied' },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
    };
    const controller = new ProxyController(proxyService as any);

    await controller.responses(
      { input: 'Create the file', model: 'gpt-4o' },
      createReplyMock() as any,
    );
    await controller.responses(
      {
        previous_response_id: 'resp_compaction_1',
        input: [
          { type: 'compaction_summary', content: 'Earlier context was compacted.' },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_patch_compacted',
            output: 'Done',
          },
        ],
      },
      createReplyMock() as any,
    );

    const continuationRequest = proxyService.handleChatCompletions.mock.calls[1][0];
    expect(continuationRequest.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          expect.objectContaining({
            custom_input: patch,
            id: 'call_patch_compacted',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({ input: patch }),
            },
          }),
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_patch_compacted',
        name: 'apply_patch',
        content: 'Done',
      },
    ]);
  });

  it('rejects an unknown previous_response_id', async () => {
    const proxyService = { handleChatCompletions: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.responses(
      { input: 'Continue', previous_response_id: 'resp_missing' },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'previous_response_not_found',
        message: 'Unknown or expired previous_response_id: resp_missing',
        param: 'previous_response_id',
        type: 'invalid_request_error',
      },
    });
  });

  it('supports image generations endpoint', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: `![img](data:image/png;base64,${generatedPng})`,
            },
          },
        ],
      }),
    };
    const imageQuotaRefresh = vi.fn().mockResolvedValue(undefined);
    const controller = new ProxyController(proxyService as any, undefined, imageQuotaRefresh);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        prompt: 'draw a cat',
      },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.1-flash-image',
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            b64_json: generatedPng,
          }),
        ],
      }),
    );
    expect(imageQuotaRefresh).toHaveBeenCalledOnce();
  });

  it('returns the last buffered image when Gemini emits intermediate image frames', async () => {
    const intermediate = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([1]),
    ]).toString('base64');
    const final = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([2]),
    ]).toString('base64');
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: [
                `![intermediate](data:image/png;base64,${intermediate})`,
                `![final](data:image/png;base64,${final})`,
              ].join('\n'),
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations({ prompt: 'draw a cat' }, reply as any);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ b64_json: final })],
      }),
    );
  });

  it('maps image generation upstream quota errors to 429', async () => {
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

    expect(reply.status).toHaveBeenCalledWith(429);
  });

  it('preserves a structured image upstream status when the message has no status hint', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockRejectedValue(
        new UpstreamRequestError({
          message: 'Temporary upstream failure',
          status: 503,
        }),
      ),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        prompt: 'draw a dog',
      },
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(503);
  });

  it('returns 502 when an image upstream emits malformed inline bytes', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '![img](data:image/png;base64,QUJDRA==)' } }],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations({ prompt: 'draw a dog' }, reply as any);

    expect(reply.status).toHaveBeenCalledWith(502);
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
                    data: generatedPng,
                  },
                },
              ],
            },
          },
        ],
      }),
    };
    const imageQuotaRefresh = vi.fn().mockResolvedValue(undefined);
    const controller = new ProxyController(proxyService as any, undefined, imageQuotaRefresh);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        model: 'gemini-3-pro-image',
        prompt: 'draw a fox',
        quality: 'medium',
        size: '1536x1024',
      },
      reply as any,
    );

    expect(proxyService.handleChatCompletions).toHaveBeenCalledOnce();
    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'gemini-3-pro-image',
      expect.objectContaining({
        generationConfig: {
          imageConfig: {
            aspectRatio: '3:2',
            imageSize: '2K',
          },
        },
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            b64_json: generatedPng,
          }),
        ],
      }),
    );
    expect(imageQuotaRefresh).toHaveBeenCalledOnce();
  });

  it('uses the last non-thought image from the direct Gemini fallback', async () => {
    const intermediate = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([3]),
    ]).toString('base64');
    const final = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([4]),
    ]).toString('base64');
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
                { inlineData: { mimeType: 'image/png', data: intermediate }, thought: true },
                { inlineData: { mimeType: 'image/png', data: final } },
              ],
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations({ prompt: 'draw a fox' }, reply as any);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ b64_json: final })],
      }),
    );
  });

  it('returns 502 when the direct Gemini image fallback has no inline image', async () => {
    const proxyService = {
      handleChatCompletions: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
          ),
        ),
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({
        candidates: [],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageGenerations(
      {
        prompt: 'draw a fox',
      },
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(502);
  });

  it('supports image edits endpoint with supplementary image payload', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: `![img](data:image/png;base64,${generatedPng})`,
            },
          },
        ],
      }),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();
    const mainImage = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);
    const maskImage = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
      Buffer.alloc(8),
    ]);
    const referenceImage = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

    await controller.imageEdits(
      createMultipartRequest([
        { type: 'field', fieldname: 'prompt', value: 'make it brighter' },
        {
          type: 'file',
          fieldname: 'image',
          filename: 'main.png',
          mimetype: 'image/png',
          data: mainImage,
        },
        {
          type: 'file',
          fieldname: 'mask',
          filename: 'mask.webp',
          mimetype: 'image/webp',
          data: maskImage,
        },
        {
          type: 'file',
          fieldname: 'image1',
          filename: 'reference.jpg',
          mimetype: 'image/jpeg',
          data: referenceImage,
        },
      ]) as any,
      reply as any,
    );

    const request = proxyService.handleChatCompletions.mock.calls[0][0];
    expect(request).toMatchObject({
      model: 'gemini-3.1-flash-image',
      messages: [
        {
          content: [
            {
              type: 'text',
              text: 'make it brighter',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${mainImage.toString('base64')}`,
              },
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${referenceImage.toString('base64')}`,
              },
            },
            {
              type: 'text',
              text: 'Use the following image as the edit mask.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/webp;base64,${maskImage.toString('base64')}`,
              },
            },
          ],
        },
      ],
    });
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('rejects image edits request without multipart boundary', async () => {
    const proxyService = {
      handleChatCompletions: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.imageEdits(
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
      error: expect.objectContaining({
        code: 'invalid_value',
        type: 'invalid_request_error',
      }),
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
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WAVE'),
      Buffer.alloc(8),
    ]);

    await controller.audioTranscriptions(
      createMultipartRequest([
        { type: 'field', fieldname: 'model', value: 'gemini-2.5-flash' },
        {
          type: 'file',
          fieldname: 'file',
          filename: 'speech.wav',
          mimetype: 'audio/wav',
          data: wav,
        },
      ]) as any,
      reply as any,
    );

    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledOnce();
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ text: 'transcribed text' });
  });

  it('rejects audio transcription request without multipart boundary', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn(),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.audioTranscriptions(
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
      error: expect.objectContaining({
        code: 'invalid_value',
        type: 'invalid_request_error',
      }),
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
        max_tokens: 64,
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );

    expect(proxyService.handleAnthropicMessages).toHaveBeenCalledOnce();
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('returns Anthropic validation errors with request identity', async () => {
    const proxyService = { handleAnthropicMessages: vi.fn() };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.anthropicMessages(
      {
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [{ role: 'system', content: 'invalid role' }],
      } as any,
      reply as any,
    );

    expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.header).toHaveBeenCalledWith('request-id', expect.stringMatching(/^req_/));
    expect(reply.send).toHaveBeenCalledWith({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: expect.stringContaining('role'),
      },
      request_id: expect.stringMatching(/^req_/),
    });
  });

  it('maps upstream quota failures to Anthropic rate-limit errors', async () => {
    const proxyService = {
      handleAnthropicMessages: vi
        .fn()
        .mockRejectedValue(new UpstreamRequestError({ message: 'quota', status: 429 })),
    };
    const controller = new ProxyController(proxyService as any);
    const reply = createReplyMock();

    await controller.anthropicMessages(
      {
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      },
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'quota' },
      request_id: expect.stringMatching(/^req_/),
    });
  });

  it('returns a model-specific OpenAI 404 instead of a generic account error', async () => {
    const controller = new ProxyController({
      handleChatCompletions: vi.fn().mockRejectedValue(
        new ModelRouteError({
          message: "Unknown model 'not-a-model'",
          status: 404,
          code: 'model_not_found',
        }),
      ),
    } as any);
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'not-a-model',
        messages: [{ role: 'user', content: 'hello' }],
      } as any,
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: "Unknown model 'not-a-model'",
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found',
      },
    });
  });

  it('writes post-header failures as named Anthropic SSE error events', async () => {
    const proxyService = {
      handleAnthropicMessages: vi
        .fn()
        .mockResolvedValue(throwError(() => new Error('upstream interrupted'))),
    };
    const controller = new ProxyController(proxyService as any);
    const raw = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      writableEnded: boolean;
      write: ReturnType<typeof vi.fn>;
      writeHead: ReturnType<typeof vi.fn>;
    };
    raw.writableEnded = false;
    raw.writeHead = vi.fn();
    raw.write = vi.fn();
    raw.end = vi.fn(() => {
      raw.writableEnded = true;
    });
    const reply = {
      hijack: vi.fn(),
      raw,
      status: vi.fn(),
      header: vi.fn(),
      send: vi.fn(),
    };

    await controller.anthropicMessages(
      {
        model: 'claude-opus-5',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
      reply as any,
    );

    expect(raw.write).toHaveBeenCalledWith(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream interrupted"}}\n\n',
    );
    expect(raw.end).toHaveBeenCalledOnce();
  });
});
