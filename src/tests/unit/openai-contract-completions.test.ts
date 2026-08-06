import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';
import { OpenAIProtocolException } from '../../modules/proxy-gateway/server/openai-protocol-error';
import { setServerConfig } from '../../server/server-config';
import { DEFAULT_APP_CONFIG, ProxyConfig } from '@/modules/config/types';

const mockAccountLeaseService = {
  getNextToken: vi.fn(),
  markAsRateLimited: vi.fn(),
  markAsForbidden: vi.fn(),
  markFromUpstreamError: vi.fn(),
  markModelUnrequestable: vi.fn(),
  recordParityError: vi.fn(),
  getModelOutputLimitForAccount: vi.fn(),
  getModelThinkingBudgetForAccount: vi.fn(),
  resolveDynamicModelForAccount: vi.fn((_token: unknown, model: string) => model),
};
const mockGeminiClient = { streamGenerateInternal: vi.fn(), generateInternal: vi.fn() };

function createProxyConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    ...overrides,
    upstream_proxy: {
      ...DEFAULT_APP_CONFIG.proxy.upstream_proxy,
      ...(overrides.upstream_proxy ?? {}),
    },
    experimental: {
      ...DEFAULT_APP_CONFIG.proxy.experimental,
      ...(overrides.experimental ?? {}),
    },
  };
}

function createToken(id = 'acc-1') {
  return {
    id,
    email: `${id}@test.com`,
    token: {
      access_token: 'token',
      refresh_token: 'refresh',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: 'project-1',
      session_id: 'session-1',
      upstream_proxy_url: undefined,
    },
  };
}

function createService(): ProxyService {
  return new ProxyService(mockAccountLeaseService as never, mockGeminiClient as never);
}

/** Exercises the internal protocol mappers directly so wire shapes are asserted at the source. */
function invokePrivate<T>(service: ProxyService, method: string, ...args: unknown[]): T {
  const target = service as unknown as Record<string, (...fnArgs: unknown[]) => unknown>;
  return target[method](...args) as T;
}

interface StreamOutcome {
  chunks: string[];
  error?: Error;
  completed: boolean;
}

function collectStream(
  observable: Observable<string>,
  emit?: (stream: EventEmitter) => void,
  stream?: EventEmitter,
): Promise<StreamOutcome> {
  return new Promise<StreamOutcome>((resolve) => {
    const chunks: string[] = [];
    observable.subscribe({
      next: (chunk) => chunks.push(chunk),
      error: (error: unknown) =>
        resolve({
          chunks,
          completed: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      complete: () => resolve({ chunks, completed: true }),
    });

    if (emit && stream) {
      emit(stream);
    }
  });
}

function parseSseData(chunks: string[]): Array<Record<string, unknown> | '[DONE]'> {
  return chunks
    .join('')
    .split('\n\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      const payload = line.slice('data: '.length);
      return payload === '[DONE]' ? '[DONE]' : (JSON.parse(payload) as Record<string, unknown>);
    });
}

function isStringValue(value: unknown): value is string {
  return typeof value === 'string';
}

function geminiChunk(payload: unknown): Buffer {
  return Buffer.from(`data: ${JSON.stringify(payload)}\n`);
}

describe('OpenAI Chat and legacy Completions contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setServerConfig(createProxyConfig());
  });

  it('emits genuine legacy text_completion chunks for streamed /v1/completions', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
      undefined,
      { variant: 'text', includeUsage: false },
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [{ text: 'legacy text' }] } }],
          }),
        );
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          }),
        );
      },
      stream,
    );

    const events = parseSseData(outcome.chunks);
    const raw = outcome.chunks.join('');
    expect(raw).not.toContain('chat.completion.chunk');
    expect(raw).not.toContain('"delta"');
    expect(events.at(-1)).toBe('[DONE]');

    const payloads = events.filter((event): event is Record<string, unknown> => event !== '[DONE]');
    for (const payload of payloads) {
      expect(payload.object).toBe('text_completion');
      expect(payload).not.toHaveProperty('usage');
      for (const choice of payload.choices as Array<Record<string, unknown>>) {
        expect(choice).toMatchObject({ index: 0, logprobs: null });
        expect(typeof choice.text).toBe('string');
      }
    }
    expect(payloads[0].choices).toEqual([
      { text: 'legacy text', index: 0, logprobs: null, finish_reason: null },
    ]);
    expect(payloads.at(-1)?.choices).toEqual([
      { text: '', index: 0, logprobs: null, finish_reason: 'stop' },
    ]);
  });

  it('starts real chat streams with one assistant-role delta before content', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const outcome = await collectStream(
      invokePrivate<Observable<string>>(service, 'processStreamResponse', stream, 'gpt-4o-mini'),
      (source) => {
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
          }),
        );
      },
      stream,
    );

    const payloads = parseSseData(outcome.chunks).filter(
      (event): event is Record<string, unknown> => event !== '[DONE]',
    );
    expect(payloads[0]?.choices).toEqual([
      { index: 0, delta: { role: 'assistant' }, finish_reason: null },
    ]);
    expect(
      payloads.filter((payload) => {
        const choice = (payload.choices as Array<Record<string, unknown>>)[0];
        return (choice?.delta as Record<string, unknown> | undefined)?.role === 'assistant';
      }),
    ).toHaveLength(1);
    expect(payloads[1]?.choices).toEqual([
      { index: 0, delta: { content: 'hello' }, finish_reason: null },
    ]);
  });

  it('honours stream_options.include_usage on the live chat stream', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
      undefined,
      { variant: 'chat', includeUsage: true },
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [{ text: 'hello' }] } }],
          }),
        );
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 11,
              candidatesTokenCount: 7,
              thoughtsTokenCount: 2,
              totalTokenCount: 20,
            },
          }),
        );
      },
      stream,
    );

    const events = parseSseData(outcome.chunks);
    expect(events.at(-1)).toBe('[DONE]');
    const payloads = events.filter((event): event is Record<string, unknown> => event !== '[DONE]');

    // Every normal chunk carries usage:null; exactly one extra chunk precedes [DONE].
    for (const payload of payloads.slice(0, -1)) {
      expect(payload.usage).toBeNull();
      expect((payload.choices as unknown[]).length).toBe(1);
    }
    const usageChunk = payloads.at(-1);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 9,
      completion_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 20,
    });
    expect(payloads.filter((payload) => (payload.choices as unknown[]).length === 0).length).toBe(
      1,
    );
  });

  it('never turns empty or partial upstream usage metadata into a usage frame', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
      undefined,
      { variant: 'chat', includeUsage: true },
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [{ text: 'hello' }] } }],
            usageMetadata: {},
          }),
        );
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
            // Only a total: neither prompt nor completion can be told truthfully.
            usageMetadata: { totalTokenCount: 20 },
          }),
        );
      },
      stream,
    );

    const events = parseSseData(outcome.chunks);
    expect(events.at(-1)).toBe('[DONE]');
    const payloads = events.filter((event): event is Record<string, unknown> => event !== '[DONE]');
    // Opting in still marks every normal chunk with usage:null, but no usage-only frame
    // is invented and no zero-filled counters reach the wire.
    expect(payloads.every((payload) => payload.usage === null)).toBe(true);
    expect(payloads.every((payload) => (payload.choices as unknown[]).length === 1)).toBe(true);
    expect(outcome.chunks.join('')).not.toContain('prompt_tokens');
  });

  it('keeps the last real usage when a later upstream chunk reports partial metadata', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
      undefined,
      { variant: 'chat', includeUsage: true },
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [{ text: 'hello' }] } }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          }),
        );
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
            usageMetadata: { trafficType: 'ON_DEMAND' },
          }),
        );
      },
      stream,
    );

    const payloads = parseSseData(outcome.chunks).filter(
      (event): event is Record<string, unknown> => event !== '[DONE]',
    );
    expect(payloads.at(-1)).toEqual({
      id: expect.any(String),
      object: 'chat.completion.chunk',
      created: expect.any(Number),
      model: 'gpt-4o-mini',
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
  });

  it('never fabricates usage chunks when include_usage is absent', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          }),
        );
      },
      stream,
    );

    expect(outcome.chunks.join('')).not.toContain('"usage"');
    const payloads = parseSseData(outcome.chunks).filter(
      (event): event is Record<string, unknown> => event !== '[DONE]',
    );
    expect(payloads.every((payload) => (payload.choices as unknown[]).length === 1)).toBe(true);
  });

  it('applies include_usage semantics to the synthetic fallback stream', async () => {
    const service = createService();
    const response = {
      id: 'chatcmpl-synthetic',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4o-mini',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'synthetic' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    };
    const withUsage = parseSseData(
      (
        await collectStream(
          invokePrivate<Observable<string>>(service, 'createSyntheticOpenAIStream', response, {
            variant: 'chat',
            includeUsage: true,
          }),
        )
      ).chunks,
    );
    const withUsagePayloads = withUsage.filter(
      (event): event is Record<string, unknown> => event !== '[DONE]',
    );
    expect(withUsage.at(-1)).toBe('[DONE]');
    expect(withUsagePayloads.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    expect(withUsagePayloads.slice(0, -1).every((payload) => payload.usage === null)).toBe(true);

    const withoutUsage = await collectStream(
      invokePrivate<Observable<string>>(service, 'createSyntheticOpenAIStream', response),
    );
    expect(withoutUsage.chunks.join('')).not.toContain('"usage"');
    expect(parseSseData(withoutUsage.chunks).at(-1)).toBe('[DONE]');
  });

  it('keeps stable tool call ids/indexes and finishes with tool_calls', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit(
          'data',
          geminiChunk({
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { id: 'call_a', name: 'alpha', args: { a: 1 } } },
                    { functionCall: { id: 'call_b', name: 'beta', args: {} } },
                    { functionCall: { id: 'call_a', name: 'alpha', args: { a: 2 } } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
        );
      },
      stream,
    );

    const payloads = parseSseData(outcome.chunks).filter(
      (event): event is Record<string, unknown> => event !== '[DONE]',
    );
    const toolCalls = payloads.flatMap((payload) => {
      const choice = (payload.choices as Array<Record<string, unknown>>)[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      return (delta?.tool_calls as Array<Record<string, unknown>>) ?? [];
    });

    expect(toolCalls.map((call) => [call.id, call.index])).toEqual([
      ['call_a', 0],
      ['call_b', 1],
      ['call_a', 0],
    ]);
    expect(toolCalls.every((call) => call.type === 'function')).toBe(true);
    expect(payloads.at(-1)?.choices).toEqual([
      { index: 0, delta: {}, finish_reason: 'tool_calls' },
    ]);
  });

  it('surfaces one terminal stream error for malformed upstream chat SSE', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit('data', Buffer.from('data: {"candidates": [oops\n'));
        source.emit('end');
      },
      stream,
    );

    expect(outcome.completed).toBe(false);
    expect(outcome.error?.message).toContain('Malformed upstream stream payload');
    expect(outcome.chunks.join('')).not.toContain('[DONE]');
  });

  it('parses both "data:" and "data: " SSE prefixes from upstream', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        // No space after the colon: still a valid SSE data line.
        source.emit(
          'data',
          Buffer.from(
            `data:${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'tight' }] } }] })}\n`,
          ),
        );
        source.emit(
          'data',
          geminiChunk({
            candidates: [{ content: { parts: [{ text: 'spaced' }] }, finishReason: 'STOP' }],
          }),
        );
      },
      stream,
    );

    expect(outcome.completed).toBe(true);
    const payloads = parseSseData(outcome.chunks).filter(
      (event): event is Record<string, unknown> => event !== '[DONE]',
    );
    const texts = payloads.flatMap((payload) => {
      const choice = (payload.choices as Array<Record<string, unknown>>)[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      return isStringValue(delta?.content) ? [delta.content] : [];
    });
    expect(texts).toEqual(['tight', 'spaced']);
  });

  it('processes a final buffered SSE event that has no trailing newline', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit(
          'data',
          Buffer.from(
            `data: ${JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'tail' }] }, finishReason: 'STOP' }],
            })}`,
          ),
        );
        source.emit('end');
      },
      stream,
    );

    expect(outcome.completed).toBe(true);
    const events = parseSseData(outcome.chunks);
    expect(events.at(-1)).toBe('[DONE]');
    const payloads = events.filter((event): event is Record<string, unknown> => event !== '[DONE]');
    const texts = payloads.flatMap((payload) => {
      const choice = (payload.choices as Array<Record<string, unknown>>)[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      return isStringValue(delta?.content) ? [delta.content] : [];
    });
    expect(texts).toEqual(['tail']);
    expect(payloads.at(-1)?.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  });

  it('surfaces one terminal error for a top-level upstream error payload', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit('data', geminiChunk({ error: { code: 429, message: 'quota exceeded' } }));
        source.emit('data', geminiChunk({ error: { code: 429, message: 'quota exceeded again' } }));
        source.emit('end');
      },
      stream,
    );

    expect(outcome.completed).toBe(false);
    expect(outcome.error?.message).toContain('quota exceeded');
    expect(outcome.chunks.join('')).not.toContain('[DONE]');
  });

  it('fails an empty upstream stream instead of emitting a false [DONE]', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
    );

    const outcome = await collectStream(observable, (source) => source.emit('end'), stream);

    expect(outcome.completed).toBe(false);
    expect(outcome.error?.message).toContain('without any usable content');
    expect(outcome.chunks.join('')).not.toContain('[DONE]');
  });

  it('fails a stream that carries no usable content before ending', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit('data', Buffer.from(': keep-alive comment\n\n'));
        source.emit('data', geminiChunk({ candidates: [{ content: { parts: [] } }] }));
        source.emit('end');
      },
      stream,
    );

    expect(outcome.completed).toBe(false);
    expect(outcome.error?.message).toContain('without any usable content');
    expect(outcome.chunks.join('')).not.toContain('[DONE]');
  });

  it('surfaces one terminal error on an upstream socket error and never emits [DONE]', async () => {
    const service = createService();
    const stream = new EventEmitter();
    const observable = invokePrivate<Observable<string>>(
      service,
      'processStreamResponse',
      stream,
      'gpt-4o-mini',
    );

    const outcome = await collectStream(
      observable,
      (source) => {
        source.emit(
          'data',
          geminiChunk({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }),
        );
        source.emit('error', new Error('socket hang up'));
        // A late `end` after the failure must not resurrect a success terminator.
        source.emit('end');
      },
      stream,
    );

    expect(outcome.completed).toBe(false);
    expect(outcome.error?.message).toBe('socket hang up');
    expect(outcome.chunks.join('')).not.toContain('[DONE]');
  });

  it('fails the stream on idle timeout without a false [DONE]', async () => {
    vi.useFakeTimers();
    try {
      const service = createService();
      const stream = new EventEmitter();
      const observable = invokePrivate<Observable<string>>(
        service,
        'processStreamResponse',
        stream,
        'gpt-4o-mini',
      );

      const chunks: string[] = [];
      let error: Error | undefined;
      let completed = false;
      observable.subscribe({
        next: (chunk) => chunks.push(chunk),
        error: (err: unknown) => {
          error = err instanceof Error ? err : new Error(String(err));
        },
        complete: () => {
          completed = true;
        },
      });

      stream.emit(
        'data',
        geminiChunk({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }),
      );
      vi.advanceTimersByTime(300_001);

      expect(completed).toBe(false);
      expect(error?.message).toContain('idle timeout');
      expect(chunks.join('')).not.toContain('[DONE]');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays tool calls on the synthetic fallback stream before finish_reason=tool_calls', async () => {
    const service = createService();
    const response = {
      id: 'chatcmpl-synthetic-tools',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_a',
                type: 'function',
                function: { name: 'alpha', arguments: '{"a":1}' },
              },
              {
                id: 'call_b',
                type: 'function',
                function: { name: 'beta', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };

    const outcome = await collectStream(
      invokePrivate<Observable<string>>(service, 'createSyntheticOpenAIStream', response),
    );

    const events = parseSseData(outcome.chunks);
    expect(events.at(-1)).toBe('[DONE]');
    const payloads = events.filter((event): event is Record<string, unknown> => event !== '[DONE]');
    expect(payloads[0]?.choices).toEqual([
      { index: 0, delta: { role: 'assistant' }, finish_reason: null },
    ]);
    expect(
      payloads.filter((payload) => {
        const choice = (payload.choices as Array<Record<string, unknown>>)[0];
        return (choice?.delta as Record<string, unknown> | undefined)?.role === 'assistant';
      }),
    ).toHaveLength(1);
    const toolCalls = payloads.flatMap((payload) => {
      const choice = (payload.choices as Array<Record<string, unknown>>)[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      return (delta?.tool_calls as Array<Record<string, unknown>>) ?? [];
    });

    expect(toolCalls.map((call) => [call.id, call.index, call.type])).toEqual([
      ['call_a', 0, 'function'],
      ['call_b', 1, 'function'],
    ]);
    expect(toolCalls.map((call) => call.function)).toEqual([
      { name: 'alpha', arguments: '{"a":1}' },
      { name: 'beta', arguments: '{}' },
    ]);
    // The terminal chunk comes last and upgrades the finish reason to tool_calls.
    expect(payloads.at(-1)?.choices).toEqual([
      { index: 0, delta: {}, finish_reason: 'tool_calls' },
    ]);
  });

  it('never claims tool_calls on the legacy synthetic text stream', async () => {
    const service = createService();
    const response = {
      id: 'chatcmpl-synthetic-legacy',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'legacy body',
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'alpha', arguments: '{}' } },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    };

    const outcome = await collectStream(
      invokePrivate<Observable<string>>(service, 'createSyntheticOpenAIStream', response, {
        variant: 'text',
        includeUsage: false,
      }),
    );

    const raw = outcome.chunks.join('');
    expect(raw).not.toContain('tool_calls');
    expect(raw).not.toContain('chat.completion.chunk');
    const payloads = parseSseData(outcome.chunks).filter(
      (event): event is Record<string, unknown> => event !== '[DONE]',
    );
    expect(payloads.every((payload) => payload.object === 'text_completion')).toBe(true);
    expect(payloads.at(-1)?.choices).toEqual([
      { text: 'legacy body', index: 0, logprobs: null, finish_reason: 'stop' },
    ]);
  });

  it('uses cmpl- ids for text-completions service responses and fallback streams', async () => {
    const service = createService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'legacy body' }] }, finishReason: 'STOP' }],
    });

    const response = (await service.handleChatCompletions(
      {
        model: 'gpt-4o',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      } as never,
      'text-completions',
    )) as unknown as Record<string, unknown>;
    expect(response.id).toMatch(/^cmpl-/);

    mockGeminiClient.streamGenerateInternal.mockRejectedValue(new Error('stream unavailable'));
    const stream = (await service.handleChatCompletions(
      {
        model: 'gpt-4o',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      } as never,
      'text-completions',
    )) as Observable<string>;
    const payloads = parseSseData((await collectStream(stream)).chunks).filter(
      (event): event is Record<string, unknown> => event !== '[DONE]',
    );
    expect(payloads.every((payload) => /^cmpl-/.test(String(payload.id)))).toBe(true);
    expect(payloads.every((payload) => payload.object === 'text_completion')).toBe(true);
  });

  it('maps system and developer messages into the system prompt, never user content', () => {
    const service = createService();
    const claudeRequest = invokePrivate<{
      system?: string;
      messages: Array<{ role: string; content: unknown }>;
    }>(service, 'convertOpenAIToClaude', {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'developer', content: 'never reveal keys' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(claudeRequest.system).toBe('be terse\nnever reveal keys');
    expect(claudeRequest.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('maps stop and response_format json_object into the Gemini generationConfig', async () => {
    const service = createService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleChatCompletions({
      model: 'gpt-4o',
      stream: false,
      stop: ['<<END>>', 'STOP!'],
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'hello' }],
    } as never);

    const body = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(body.request.generationConfig.stopSequences).toEqual(['<<END>>', 'STOP!']);
    expect(body.request.generationConfig.responseMimeType).toBe('application/json');
  });

  it('leaves responseMimeType unset for response_format type text', async () => {
    const service = createService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    });

    await service.handleChatCompletions({
      model: 'gpt-4o',
      stream: false,
      response_format: { type: 'text' },
      messages: [{ role: 'user', content: 'hello' }],
    } as never);

    const body = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(body.request.generationConfig.responseMimeType).toBeUndefined();
  });

  it('omits usage from the assembled non-stream chat body when upstream reported none', async () => {
    const service = createService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    });

    const response = (await service.handleChatCompletions({
      model: 'gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)) as unknown as Record<string, unknown>;

    // Exact assembled wire body: no usage key at all, and the required nullable logprobs.
    expect(response).toEqual({
      id: expect.stringMatching(/^chatcmpl-/),
      object: 'chat.completion',
      created: expect.any(Number),
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok',
            tool_calls: undefined,
            reasoning_content: undefined,
          },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
    });
    expect(Object.keys(response)).not.toContain('usage');
    expect(JSON.stringify(response)).not.toContain('usage');
  });

  it('reports real upstream usage on the assembled non-stream chat body', async () => {
    const service = createService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 6,
        thoughtsTokenCount: 2,
        totalTokenCount: 20,
      },
    });

    const response = (await service.handleChatCompletions({
      model: 'gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)) as unknown as Record<string, unknown>;

    expect(response.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 20,
    });
    expect((response.choices as Array<Record<string, unknown>>)[0].logprobs).toBeNull();
  });

  it('emits no usage frame on the real fallback stream when upstream reported no usage', async () => {
    const service = createService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.streamGenerateInternal.mockRejectedValue(new Error('stream path unavailable'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'fallback body' }] }, finishReason: 'STOP' }],
    });

    const result = await service.handleChatCompletions({
      model: 'gpt-4o',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    } as never);

    const outcome = await collectStream(result as Observable<string>);
    const events = parseSseData(outcome.chunks);
    expect(events.at(-1)).toBe('[DONE]');
    const payloads = events.filter((event): event is Record<string, unknown> => event !== '[DONE]');
    expect(payloads.every((payload) => payload.usage === null)).toBe(true);
    expect(payloads.every((payload) => (payload.choices as unknown[]).length === 1)).toBe(true);
    expect(outcome.chunks.join('')).not.toContain('prompt_tokens');
  });

  it('replays real upstream usage on the fallback stream when include_usage is set', async () => {
    const service = createService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.streamGenerateInternal.mockRejectedValue(new Error('stream path unavailable'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'fallback body' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
    });

    const result = await service.handleChatCompletions({
      model: 'gpt-4o',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    } as never);

    const payloads = parseSseData(
      (await collectStream(result as Observable<string>)).chunks,
    ).filter((event): event is Record<string, unknown> => event !== '[DONE]');
    expect(payloads.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  });

  it('rejects a response_format object without a usable type before any account is leased', async () => {
    const service = createService();

    for (const responseFormat of [{}, { json_schema: { name: 'x' } }, { type: '' }, { type: 7 }]) {
      await expect(
        service.handleChatCompletions({
          model: 'gpt-4o',
          stream: false,
          response_format: responseFormat,
          messages: [{ role: 'user', content: 'hello' }],
        } as never),
      ).rejects.toBeInstanceOf(OpenAIProtocolException);
    }

    expect(mockAccountLeaseService.getNextToken).not.toHaveBeenCalled();
    expect(mockGeminiClient.generateInternal).not.toHaveBeenCalled();
    expect(mockGeminiClient.streamGenerateInternal).not.toHaveBeenCalled();
  });

  it('rejects local mapping failures without selecting or penalizing any account', async () => {
    const service = createService();

    await expect(
      service.handleChatCompletions({
        model: 'gpt-4o',
        stream: false,
        response_format: { type: 'json_schema', json_schema: { name: 'x' } },
        messages: [{ role: 'user', content: 'hello' }],
      } as never),
    ).rejects.toBeInstanceOf(OpenAIProtocolException);

    await expect(
      service.handleChatCompletions({
        model: 'gpt-4o',
        stream: false,
        tool_choice: { type: 'function', function: { name: 'missing_tool' } },
        messages: [{ role: 'user', content: 'hello' }],
      } as never),
    ).rejects.toBeInstanceOf(OpenAIProtocolException);

    expect(mockAccountLeaseService.getNextToken).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markAsRateLimited).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
    expect(mockGeminiClient.generateInternal).not.toHaveBeenCalled();
    expect(mockGeminiClient.streamGenerateInternal).not.toHaveBeenCalled();
  });
});
