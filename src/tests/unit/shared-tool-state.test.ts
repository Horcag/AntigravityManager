import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InvalidFunctionCallArgumentsError,
  normalizeFunctionCallArgs,
} from '@/modules/proxy-gateway/antigravity/function-call-args';
import { OpenAIResponsesStreamingMapper } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import {
  ToolCallIdConflictError,
  ToolCallIdIntegrityTracker,
} from '@/modules/proxy-gateway/antigravity/tool-call-id-integrity';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

afterEach(() => {
  vi.useRealTimers();
});

describe('shared tool-call state', () => {
  it.each([
    ['none', { mode: 'NONE' }],
    ['auto', { mode: 'AUTO' }],
    ['required', { mode: 'ANY' }],
    [{ type: 'none' }, { mode: 'NONE' }],
    [{ type: 'auto' }, { mode: 'AUTO' }],
    [
      { type: 'tool', name: 'lookup' },
      { mode: 'ANY', allowedFunctionNames: ['lookup'] },
    ],
    [
      { type: 'function', function: { name: 'search' } },
      { mode: 'ANY', allowedFunctionNames: ['search'] },
    ],
  ] as const)('maps tool choice %j to an exact Gemini toolConfig', (toolChoice, expected) => {
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Use a tool' }],
      tool_choice: toolChoice,
      tools: [
        {
          name: 'lookup',
          description: 'Lookup a record',
          input_schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
        {
          name: 'search',
          description: 'Search records',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    };

    const body = transformClaudeRequestIn(request);

    expect(body.request.toolConfig?.functionCallingConfig).toEqual(expected);
    expect(body.request.tools?.[0]?.functionDeclarations?.map((tool) => tool.name)).toEqual([
      'lookup',
      'search',
    ]);
  });

  it('preserves parallel tool calls and their matching results by exact id', () => {
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 128,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-a', name: 'lookup', input: { id: 'a' } },
            { type: 'tool_use', id: 'call-b', name: 'search', input: { query: 'b' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-a', content: 'A' },
            { type: 'tool_result', tool_use_id: 'call-b', content: 'B' },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);
    const calls = body.request.contents[0].parts.map((part) => part.functionCall);
    const results = body.request.contents[1].parts.map((part) => part.functionResponse);

    expect(calls).toEqual([
      { id: 'call-a', name: 'lookup', args: { id: 'a' } },
      { id: 'call-b', name: 'search', args: { query: 'b' } },
    ]);
    expect(results).toEqual([
      { id: 'call-a', name: 'lookup', response: { result: 'A' } },
      { id: 'call-b', name: 'search', response: { result: 'B' } },
    ]);
  });

  it('isolates exact signature keys and lets the latest shorter value replace an older one', () => {
    const store = new SignatureStore();
    const key = { accountId: 'account-a', model: 'gemini-3-pro', toolCallId: 'call-1' };

    store.store(key, 'a-very-long-old-signature');
    store.store(key, 'new-short');

    expect(store.get(key)).toBe('new-short');
    expect(store.get({ ...key, accountId: 'account-b' })).toBeNull();
    expect(store.get({ ...key, model: 'gemini-3-flash' })).toBeNull();
    expect(store.get({ ...key, toolCallId: 'call-2' })).toBeNull();
  });

  it('evicts by instance-local capacity and TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00Z'));
    const store = new SignatureStore();
    store.configure({ maxEntries: 2, ttlMs: 100 });

    store.store({ accountId: 'a', model: 'm', toolCallId: '1' }, 'one');
    store.store({ accountId: 'a', model: 'm', toolCallId: '2' }, 'two');
    store.store({ accountId: 'a', model: 'm', toolCallId: '3' }, 'three');

    expect(store.get({ accountId: 'a', model: 'm', toolCallId: '1' })).toBeNull();
    expect(store.size()).toBe(2);

    vi.advanceTimersByTime(100);
    expect(store.get({ accountId: 'a', model: 'm', toolCallId: '2' })).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('normalizes only omitted function arguments and rejects malformed present values', () => {
    expect(normalizeFunctionCallArgs({ name: 'tool' })).toEqual({});
    expect(normalizeFunctionCallArgs({ name: 'tool', args: { value: 1 } })).toEqual({ value: 1 });

    for (const args of [null, [], 'bad', 1]) {
      expect(() => normalizeFunctionCallArgs({ name: 'tool', args })).toThrow(
        InvalidFunctionCallArgumentsError,
      );
    }
  });

  it('treats exact explicit-id repetition as replay and rejects conflicting reuse', () => {
    const tracker = new ToolCallIdIntegrityTracker();

    expect(tracker.record('call-1', 'search', { query: 'api' })).toBe('new');
    expect(tracker.record('call-1', 'search', { query: 'api' })).toBe('replay');
    expect(() => tracker.record('call-1', 'search', { query: 'other' })).toThrow(
      ToolCallIdConflictError,
    );
  });

  it('enforces replay, conflict, and malformed-argument rules in both streaming mappers', () => {
    const responsesMapper = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp-integrity',
    });
    const firstResponsesCall = {
      functionCall: { id: 'call-1', name: 'search', args: { query: 'api' } },
    };

    expect(responsesMapper.processPart(firstResponsesCall)).not.toHaveLength(0);
    expect(responsesMapper.processPart(firstResponsesCall)).toEqual([]);
    expect(() =>
      responsesMapper.processPart({
        functionCall: { id: 'call-1', name: 'search', args: { query: 'other' } },
      }),
    ).toThrow(ToolCallIdConflictError);

    const anthropicProcessor = new PartProcessor(new StreamingState());
    const firstAnthropicCall = {
      functionCall: { id: 'call-2', name: 'lookup', args: { id: 1 } },
    };
    expect(anthropicProcessor.process(firstAnthropicCall)).not.toHaveLength(0);
    expect(anthropicProcessor.process(firstAnthropicCall)).toEqual([]);
    expect(() =>
      new PartProcessor(new StreamingState()).process({
        functionCall: { id: 'bad-args', name: 'lookup', args: null as never },
      }),
    ).toThrow(InvalidFunctionCallArgumentsError);
    expect(() =>
      new OpenAIResponsesStreamingMapper({
        model: 'gemini-3-pro',
        responseId: 'resp-malformed',
      }).processPart({
        functionCall: { id: 'bad-args', name: 'lookup', args: [] },
      }),
    ).toThrow(InvalidFunctionCallArgumentsError);
  });

  it('keeps integrity trackers and signatures isolated between concurrent mapper instances', () => {
    const store = new SignatureStore();
    const mapperA = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp-a',
      signatureState: { accountId: 'account-a', model: 'gemini-3-pro', store },
    });
    const mapperB = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp-b',
      signatureState: { accountId: 'account-b', model: 'gemini-3-pro', store },
    });

    expect(
      mapperA.processPart({
        functionCall: { id: 'shared-id', name: 'search', args: { query: 'a' } },
        thoughtSignature: Buffer.from('signature-a').toString('base64'),
      }),
    ).not.toHaveLength(0);
    expect(
      mapperB.processPart({
        functionCall: { id: 'shared-id', name: 'search', args: { query: 'b' } },
        thoughtSignature: Buffer.from('signature-b').toString('base64'),
      }),
    ).not.toHaveLength(0);

    expect(
      store.get({ accountId: 'account-a', model: 'gemini-3-pro', toolCallId: 'shared-id' }),
    ).toBe('signature-a');
    expect(
      store.get({ accountId: 'account-b', model: 'gemini-3-pro', toolCallId: 'shared-id' }),
    ).toBe('signature-b');
  });

  it('uses an explicit request signature before an exact cached signature', () => {
    const store = new SignatureStore();
    store.store(
      { accountId: 'account-a', model: 'gemini-3-flash', toolCallId: 'call-1' },
      'cached-signature',
    );
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 128,
      thinking: { type: 'enabled', budget_tokens: 64 },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'search',
              input: {},
              signature: 'explicit-signature',
            },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request, undefined, undefined, 'gemini-3-flash', {
      accountId: 'account-a',
      store,
    });
    const functionCallPart = body.request.contents[0].parts.find((part) => part.functionCall);
    expect(functionCallPart?.thoughtSignature).toBe('explicit-signature');
  });

  it('stores a non-stream tool signature under the generated id emitted to the client', () => {
    const store = new SignatureStore();
    const response = transformResponse(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'search', args: {} },
                  thoughtSignature: Buffer.from('generated-id-signature').toString('base64'),
                },
              ],
            },
          },
        ],
      },
      { accountId: 'account-a', model: 'gemini-3-pro', store },
    );
    const toolUse = response.content.find((block) => block.type === 'tool_use');

    expect(toolUse?.type).toBe('tool_use');
    if (toolUse?.type !== 'tool_use') {
      throw new Error('Expected tool_use block');
    }
    expect(
      store.get({ accountId: 'account-a', model: 'gemini-3-pro', toolCallId: toolUse.id }),
    ).toBe('generated-id-signature');
  });

  it('applies the same replay and validation rules to non-stream responses', () => {
    const exactCall = { id: 'call-1', name: 'search', args: { query: 'api' } };
    const response = transformResponse({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: exactCall }, { functionCall: exactCall }],
          },
        },
      ],
    });
    expect(response.content.filter((block) => block.type === 'tool_use')).toHaveLength(1);

    expect(() =>
      transformResponse({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: exactCall },
                { functionCall: { ...exactCall, args: { query: 'other' } } },
              ],
            },
          },
        ],
      }),
    ).toThrow(ToolCallIdConflictError);
    expect(() =>
      transformResponse({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'bad', name: 'search', args: null as never } }],
            },
          },
        ],
      }),
    ).toThrow(InvalidFunctionCallArgumentsError);
  });
});
