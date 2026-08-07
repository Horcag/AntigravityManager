import { beforeEach, describe, it, expect, vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import { EventEmitter } from 'events';
import { Readable } from 'node:stream';
import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';
import { ProxyController } from '../../modules/proxy-gateway/server/proxy.controller';
import { Observable } from 'rxjs';
import { GeminiClient } from '../../modules/proxy-gateway/server/clients/gemini.client';
import { transformResponse } from '../../modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import { setServerConfig } from '../../server/server-config';
import { DEFAULT_APP_CONFIG, ProxyConfig } from '@/modules/config/types';

// Mock dependencies
const mockAccountLeaseService = {
  getNextToken: vi.fn(),
  markAsRateLimited: vi.fn(),
  markAsForbidden: vi.fn(),
  markFromUpstreamError: vi.fn(),
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

// Subclass to access private method
class TestableProxyService extends ProxyService {
  constructor() {
    super(mockAccountLeaseService as any, mockGeminiClient as any);
  }

  public testProcessStream(stream: any, model: string = 'model'): Observable<string> {
    // Access private method using type assertion
    return (this as any).processAnthropicInternalStream(stream, model);
  }

  public testOpenAIStream(
    stream: any,
    model: string = 'model',
    streamOptions?: { variant: 'chat' | 'text'; includeUsage: boolean },
  ): Observable<string> {
    return (this as any).processStreamResponse(stream, model, undefined, streamOptions);
  }

  public testResponsesStream(stream: any, model: string = 'model'): Observable<string> {
    return (this as any).processResponsesStreamResponse(stream, model);
  }

  public testPassthroughStream(stream: any): Observable<string> {
    return (this as any).passthroughSseStream(stream);
  }

  public testCollectStream(stream: any): Promise<unknown> {
    return (this as any).collectGeminiStreamAsResponse(stream);
  }

  public testModelHeaders(model: string): Record<string, string> {
    return (this as any).createModelSpecificHeaders(model);
  }
}

function createToken(id: string = 'acc-1') {
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

describe('ProxyService Empty Stream Retry Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setServerConfig(createProxyConfig());
  });

  it('classifies retry matrix consistently', () => {
    const service = new TestableProxyService();
    const classify = (message: string) => (service as any).classifyUpstreamFailure(message);

    expect(classify('401 unauthorized token')).toEqual({
      retry: true,
      markAsForbidden: true,
      markAsRateLimited: false,
    });
    expect(classify('403 permission_denied')).toEqual({
      retry: true,
      markAsForbidden: true,
      markAsRateLimited: false,
    });
    expect(classify('429 quota exceeded')).toEqual({
      retry: true,
      markAsForbidden: false,
      markAsRateLimited: true,
    });
    expect(classify('500 internal error')).toEqual({
      retry: true,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
    expect(classify('400 invalid argument')).toEqual({
      retry: false,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
  });

  it('builds Claude-specific beta headers consistently', () => {
    const service = new TestableProxyService();
    const claudeHeaders = service.testModelHeaders('claude-sonnet-4-5');
    const geminiHeaders = service.testModelHeaders('gemini-2.5-flash');

    expect(claudeHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(geminiHeaders).toEqual({});
  });

  it.each([
    ['exact custom alias', { 'public-fast': 'gemini-3-flash' }, 'public-fast'],
    ['wildcard custom alias', { 'public-*': 'gemini-3-flash' }, 'public-fast'],
  ])(
    'allows final assistant prefill through an %s mapped to gemini-3-flash',
    async (_caseName, custom_mapping, model) => {
      setServerConfig(createProxyConfig({ custom_mapping }));
      const service = new TestableProxyService();
      mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
      mockGeminiClient.generateInternal.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });

      await service.handleAnthropicMessages({
        model,
        messages: [
          { role: 'user', content: 'start' },
          { role: 'assistant', content: 'continue from this prefill' },
        ],
      } as any);

      expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledOnce();
      expect(mockGeminiClient.generateInternal.mock.calls[0][0].model).toBe('gemini-3-flash');
    },
  );

  it.each([
    ['exact alias', { 'public-medium': 'gemini-3.5-flash-high' }, 'public-medium', false],
    ['wildcard alias', { 'public-*': 'claude-sonnet-4-6-thinking' }, 'public-claude', true],
  ])(
    'rejects final assistant prefill for an unsupported %s before token lease and upstream in %s mode',
    async (_caseName, custom_mapping, model, stream) => {
      setServerConfig(createProxyConfig({ custom_mapping }));
      const service = new TestableProxyService();

      await expect(
        service.handleAnthropicMessages({
          model,
          stream,
          messages: [
            { role: 'user', content: 'start' },
            { role: 'assistant', content: 'continue from this prefill' },
          ],
        } as any),
      ).rejects.toThrow('Final assistant prefill is not supported for this model.');

      expect(mockAccountLeaseService.getNextToken).not.toHaveBeenCalled();
      expect(mockGeminiClient.generateInternal).not.toHaveBeenCalled();
      expect(mockGeminiClient.streamGenerateInternal).not.toHaveBeenCalled();
    },
  );

  it('should emit error when stream ends without data', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

    const resultObservable = service.testProcessStream(stream);

    let errorReceived: Error | undefined;

    const promise = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: () => {},
        error: (err) => {
          errorReceived = err;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    // Simulate empty stream: straight to end
    setTimeout(() => stream.emit('end'), 10);

    await promise;

    expect(errorReceived).toBeDefined();
    expect(errorReceived?.message).toBe('Empty response stream');
  });

  it('should NOT emit error when stream has data', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

    const resultObservable = service.testProcessStream(stream);

    let errorReceived: Error | undefined;
    const receivedChunks: string[] = [];

    const promise = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: (c) => receivedChunks.push(c),
        error: (err) => {
          errorReceived = err;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    // Simulate valid data stream
    setTimeout(() => {
      const validJson = JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'hello' }] },
            finishReason: 'STOP',
          },
        ],
      });
      stream.emit('data', Buffer.from(`data: ${validJson}\n\n`));
      stream.emit('end');
    }, 10);

    await promise;

    expect(errorReceived).toBeUndefined();
    // It should produce chunks (though exact number depends on mapper logic, at least it shouldn't error)
    // Actually our mapper might produce "message_start", "content_block_start" etc.
    // We just care that it didn't error with "Empty response stream"
  });

  it('falls back to stream aggregation when non-stream response is empty', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

    mockGeminiClient.generateInternal.mockResolvedValueOnce({ candidates: [] });
    mockGeminiClient.streamGenerateInternal.mockResolvedValueOnce(stream);

    const promise = (service as any).generateInternalWithStreamFallback(
      { model: 'gemini-2.5-flash' },
      'token',
      undefined,
    );

    setTimeout(() => {
      const payload = JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'fallback text' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { totalTokenCount: 5 },
      });
      stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
      stream.emit('end');
    }, 10);

    const result = await promise;
    expect(mockGeminiClient.streamGenerateInternal).toHaveBeenCalledOnce();
    expect(result.candidates[0].content.parts[0].text).toBe('fallback text');
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('rejects malformed direct function arguments before stream fallback can return a partial response', async () => {
    const service = new TestableProxyService();
    mockGeminiClient.generateInternal.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { args: [], name: 'invalid' }, text: 'partial' }],
          },
        },
      ],
    });

    await expect(
      (service as any).generateInternalWithStreamFallback(
        { model: 'gemini-2.5-flash' },
        'token',
        undefined,
      ),
    ).rejects.toThrow('functionCall.args');
    expect(mockGeminiClient.streamGenerateInternal).not.toHaveBeenCalled();
  });

  it('collects no-space SSE frames during the non-stream fallback', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

    mockGeminiClient.generateInternal.mockResolvedValueOnce({ candidates: [] });
    mockGeminiClient.streamGenerateInternal.mockResolvedValueOnce(stream);

    const resultPromise = (service as any).generateInternalWithStreamFallback(
      { model: 'gemini-2.5-flash' },
      'token',
      undefined,
    );

    setTimeout(() => {
      const payload = JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'no-space fallback text' }] },
            finishReason: 'STOP',
          },
        ],
      });
      stream.emit('data', Buffer.from(`data:${payload}\n\n`));
      stream.emit('end');
    }, 10);

    const result = await resultPromise;
    expect(result.candidates[0].content.parts[0].text).toBe('no-space fallback text');
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('collects a valid final fallback frame without a trailing newline', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const resultPromise = service.testCollectStream(stream) as Promise<any>;

    stream.emit(
      'data',
      Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"final frame"}]}}]}'),
    );
    stream.emit('end');

    await expect(resultPromise).resolves.toMatchObject({
      candidates: [{ content: { parts: [{ text: 'final frame' }] } }],
    });
  });

  it('preserves a zero-parameter function call during fallback collection and normalizes args', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const resultPromise = service.testCollectStream(stream) as Promise<any>;

    stream.emit(
      'data',
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_empty","name":"no_args"}}]}}]}\n\n',
      ),
    );
    stream.emit('end');

    await expect(resultPromise).resolves.toMatchObject({
      candidates: [
        { content: { parts: [{ functionCall: { args: {}, id: 'call_empty', name: 'no_args' } }] } },
      ],
    });
  });

  it('rejects a fallback function call whose present args are not an object', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const resultPromise = service.testCollectStream(stream);

    stream.emit(
      'data',
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"bad_args","args":[]}}]}}]}\n\n',
      ),
    );
    stream.emit('end');

    await expect(resultPromise).rejects.toThrow('functionCall.args');
  });

  it('preserves and deduplicates grounding metadata during fallback collection', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const resultPromise = service.testCollectStream(stream) as Promise<any>;
    const groundingMetadata = {
      groundingChunks: [{ web: { title: 'Gemini Docs', uri: 'https://example.com/docs' } }],
      webSearchQueries: ['gemini api'],
    };

    for (const candidate of [
      { content: { parts: [{ text: 'fallback answer' }] }, groundingMetadata },
      { groundingMetadata },
    ]) {
      stream.emit('data', Buffer.from(`data: ${JSON.stringify({ candidates: [candidate] })}\n\n`));
    }
    stream.emit('end');

    await expect(resultPromise).resolves.toMatchObject({
      candidates: [
        {
          content: { parts: [{ text: 'fallback answer' }] },
          groundingMetadata: {
            groundingChunks: [{ web: { title: 'Gemini Docs', uri: 'https://example.com/docs' } }],
            webSearchQueries: ['gemini api'],
          },
        },
      ],
    });
  });

  it.each([
    ['object', { code: 429, message: 'quota exhausted' }, 'quota exhausted'],
    ['string', 'quota exhausted', 'quota exhausted'],
    ['primitive', 429, 'Upstream stream error: 429'],
  ])('rejects an in-band %s error during fallback collection', async (_kind, error, message) => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const resultPromise = service.testCollectStream(stream);

    stream.emit('data', Buffer.from(`data: ${JSON.stringify({ error })}\n\n`));
    stream.emit('end');

    await expect(resultPromise).rejects.toThrow(message);
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
  });

  it('rejects candidate-free, usage-only, and no-op fallback streams', async () => {
    const service = new TestableProxyService();

    for (const payload of [
      { candidates: [] },
      { usageMetadata: { totalTokenCount: 3 }, candidates: [{ finishReason: 'STOP' }] },
      { candidates: [{ content: { parts: [{}] } }] },
      { candidates: [{ content: { parts: [{ text: '' }] } }] },
    ]) {
      const stream = new EventEmitter();
      const resultPromise = service.testCollectStream(stream);
      stream.emit('data', Buffer.from(`data: ${JSON.stringify(payload)}\n\n`));
      stream.emit('end');
      await expect(resultPromise).rejects.toThrow('Empty response stream');
    }
  });

  it('suppresses exact explicit tool-call replays across fallback frames before protocol mapping', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const resultPromise = service.testCollectStream(stream) as Promise<any>;

    for (const parts of [
      [{ functionCall: { id: 'call_a', name: 'alpha', args: { a: 1 } } }],
      [{ functionCall: { id: 'call_b', name: 'beta', args: {} } }],
      [{ functionCall: { id: 'call_a', name: 'alpha', args: { a: 1 } } }],
    ]) {
      stream.emit(
        'data',
        Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n\n`),
      );
    }
    stream.emit('end');

    const result = await resultPromise;
    expect(
      result.candidates[0].content.parts.map(
        (part: { functionCall?: { id?: string } }) => part.functionCall?.id,
      ),
    ).toEqual(['call_a', 'call_b']);

    const claudeResponse = transformResponse(result);
    const anthropicResponse = (service as any).toAnthropicChatResponse(claudeResponse);
    const chatResponse = (service as any).convertClaudeToOpenAIResponse(
      claudeResponse,
      'gpt-4o-mini',
    );
    const responsesResponse = (service as any).convertClaudeToOpenAIResponse(
      claudeResponse,
      'gpt-4o-mini',
      undefined,
      'responses',
    );

    expect(anthropicResponse.content.map((part: { id?: string }) => part.id)).toEqual([
      'call_a',
      'call_b',
    ]);
    expect(
      chatResponse.choices[0].message.tool_calls.map((call: { id: string }) => call.id),
    ).toEqual(['call_a', 'call_b']);
    expect(
      responsesResponse.choices[0].message.tool_calls.map((call: { id: string }) => call.id),
    ).toEqual(['call_a', 'call_b']);
  });

  it('rejects conflicting explicit tool-call reuse once and clears its idle timer', async () => {
    vi.useFakeTimers();
    try {
      const service = new TestableProxyService();
      (service as any).streamIdleTimeoutMs = 1;
      const stream = new EventEmitter();
      const resultPromise = service.testCollectStream(stream);

      for (const args of [{ city: 'London' }, { city: 'Paris' }]) {
        stream.emit(
          'data',
          Buffer.from(
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: 'call_weather', name: 'weather', args } }] } }] })}\n\n`,
          ),
        );
      }

      await expect(resultPromise).rejects.toThrow('Conflicting function call reuse');
      expect(vi.getTimerCount()).toBe(0);
      expect(stream.listenerCount('data')).toBe(0);
      expect(stream.listenerCount('end')).toBe(0);
      expect(stream.listenerCount('error')).toBe(0);

      stream.emit(
        'data',
        Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"late"}]}}]}\n\n'),
      );
      stream.emit('end');
      vi.advanceTimersByTime(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles fallback collection once for normal end, upstream error, and idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const service = new TestableProxyService();
      (service as any).streamIdleTimeoutMs = 1;

      const ended = new EventEmitter();
      const endedPromise = service.testCollectStream(ended) as Promise<any>;
      ended.emit(
        'data',
        Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"complete"}]}}]}\n\n'),
      );
      ended.emit('end');
      await expect(endedPromise).resolves.toMatchObject({
        candidates: [{ content: { parts: [{ text: 'complete' }] } }],
      });
      expect(vi.getTimerCount()).toBe(0);

      const errored = new EventEmitter();
      const erroredPromise = service.testCollectStream(errored);
      errored.emit('error', new Error('upstream interrupted'));
      await expect(erroredPromise).rejects.toThrow('upstream interrupted');
      expect(vi.getTimerCount()).toBe(0);

      const idle = new EventEmitter();
      const idlePromise = service.testCollectStream(idle);
      vi.advanceTimersByTime(1);
      await expect(idlePromise).rejects.toThrow('Stream idle timeout');
      expect(vi.getTimerCount()).toBe(0);
      expect(idle.listenerCount('data')).toBe(0);
      expect(idle.listenerCount('end')).toBe(0);
      expect(idle.listenerCount('error')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits an ordered Anthropic response for a no-space SSE frame', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];

    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    const payload = JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: 'no-space stream text' }] },
          finishReason: 'STOP',
        },
      ],
    });
    stream.emit('data', Buffer.from(`data:${payload}\n\n`));
    stream.emit('end');
    await completed;

    const eventTypes = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .filter((payload) => payload !== '[DONE]')
      .map((payload) => JSON.parse(payload).type);

    expect(eventTypes).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(chunks.join('')).toContain('no-space stream text');
  });

  it('keeps downstream text visible after a pending signature on the Anthropic wire', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    const payload = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: '', thoughtSignature: Buffer.from('wire-signature').toString('base64') },
              { text: 'downstream visible text' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
    stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
    stream.emit('end');
    await completed;

    const events = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)))
      .filter((event) => event.type.startsWith('content_block'));
    const starts = events.filter((event) => event.type === 'content_block_start');
    const stops = events.filter((event) => event.type === 'content_block_stop');

    expect(chunks.join('')).toContain('downstream visible text');
    expect(starts.map((event) => event.index)).toEqual([0, 1]);
    expect(stops.map((event) => event.index)).toEqual([0, 1]);
  });

  it('uses the requested model and zero usage in Anthropic message_start when the first chunk omits them', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream, 'claude-sonnet-4-5').subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.emit(
      'data',
      Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n'),
    );
    stream.emit('end');
    await completed;

    const messageStart = JSON.parse(
      chunks.find((chunk) => chunk.includes('event: message_start'))!.split('data: ')[1],
    );
    expect(messageStart.message).toMatchObject({
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });

  it.each([
    [{ type: 'auto' }, { mode: 'AUTO' }],
    [{ type: 'any' }, { mode: 'ANY' }],
    [{ type: 'none' }, { mode: 'NONE' }],
    [
      { type: 'tool', name: 'lookup' },
      { mode: 'ANY', allowedFunctionNames: ['lookup'] },
    ],
  ])(
    'maps Anthropic tool choice %o into the upstream function configuration',
    async (toolChoice, expected) => {
      const service = new TestableProxyService();
      mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
      mockGeminiClient.generateInternal.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });

      await service.handleAnthropicMessages({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        tool_choice: toolChoice,
      } as any);

      expect(mockGeminiClient.generateInternal.mock.calls[0][0].request.toolConfig).toEqual({
        functionCallingConfig: expected,
      });
    },
  );

  it('uses the caller-requested model when direct and stream-aggregated Anthropic responses omit modelVersion', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.generateInternal.mockResolvedValueOnce({
      candidates: [{ content: { parts: [{ text: 'direct' }] }, finishReason: 'STOP' }],
    });

    const direct = await service.handleAnthropicMessages({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hello' }],
    } as any);
    expect((direct as any).model).toBe('claude-sonnet-4-5');

    const stream = new EventEmitter();
    mockGeminiClient.generateInternal.mockResolvedValueOnce({ candidates: [] });
    mockGeminiClient.streamGenerateInternal.mockResolvedValueOnce(stream);
    const fallback = service.handleAnthropicMessages({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hello' }],
    } as any);
    await vi.waitFor(() => expect(mockGeminiClient.streamGenerateInternal).toHaveBeenCalledOnce());
    stream.emit(
      'data',
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"text":"fallback"}]},"finishReason":"STOP"}]}\n\n',
      ),
    );
    stream.emit('end');

    expect(((await fallback) as any).model).toBe('claude-sonnet-4-5');
  });

  it('uses the caller-requested Anthropic alias in a direct stream when modelVersion is absent', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    setServerConfig(
      createProxyConfig({
        anthropic_mapping: { 'claude-public-alias': 'gemini-3-flash' },
      }),
    );
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValueOnce(stream);

    const response = await service.handleAnthropicMessages({
      model: 'claude-public-alias',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    } as any);
    const completed = new Promise<void>((resolve, reject) => {
      (response as Observable<string>).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.emit(
      'data',
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}\n\n',
      ),
    );
    stream.emit('end');
    await completed;

    const messageStart = JSON.parse(
      chunks.find((chunk) => chunk.includes('event: message_start'))!.split('data: ')[1],
    );
    expect(messageStart.message.model).toBe('claude-public-alias');
    expect(mockGeminiClient.streamGenerateInternal.mock.calls[0][0].model).toBe('gemini-3-flash');
  });

  it('emits an Anthropic response from a valid final SSE frame without a trailing newline', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.emit(
      'data',
      Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"final stream"}]}}]}'),
    );
    stream.emit('end');
    await completed;

    expect(chunks.join('')).toContain('final stream');
    expect(chunks.join('')).toContain('message_stop');
  });

  it('emits one Anthropic message with deduplicated grounding metadata across stream frames', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });
    const groundingMetadata = {
      groundingChunks: [{ web: { title: 'Gemini Docs', uri: 'https://example.com/docs' } }],
      webSearchQueries: ['gemini api'],
    };

    for (const candidate of [
      { content: { parts: [{ text: 'grounded answer' }] }, groundingMetadata },
      { groundingMetadata },
    ]) {
      stream.emit('data', Buffer.from(`data: ${JSON.stringify({ candidates: [candidate] })}\n\n`));
    }
    stream.emit('end');
    await completed;

    const output = chunks.join('');
    expect(output).toContain('grounded answer');
    expect(output.match(/Searched for you/g)).toHaveLength(1);
    expect(output.match(/https:\/\/example\.com\/docs/g)).toHaveLength(1);
    expect(output.match(/"type":"message_start"/g)).toHaveLength(1);
    expect(output.match(/"type":"message_stop"/g)).toHaveLength(1);
  });

  it('accepts repeated grounding-only Anthropic frames without duplicate lifecycle events', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    const frame = Buffer.from(
      `data: ${JSON.stringify({
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [{ web: { title: 'Source', uri: 'https://example.com/source' } }],
              webSearchQueries: ['source lookup'],
            },
          },
        ],
      })}\n\n`,
    );
    for (let index = 0; index < 4; index++) {
      stream.emit('data', frame);
    }
    stream.emit('end');
    await completed;

    const output = chunks.join('');
    expect(output).toContain('Searched for you');
    expect(output).toContain('https://example.com/source');
    expect(output.match(/Searched for you/g)).toHaveLength(1);
    expect(output.match(/https:\/\/example\.com\/source/g)).toHaveLength(1);
    expect(output.match(/"type":"message_start"/g)).toHaveLength(1);
    expect(output.match(/"type":"message_stop"/g)).toHaveLength(1);
  });

  it('emits a zero-parameter function call from an Anthropic stream', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.emit(
      'data',
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_empty","name":"no_args"}}]}}]}\n\n',
      ),
    );
    stream.emit('end');
    await completed;

    expect(chunks.join('')).toContain('"input_json_delta"');
    expect(chunks.join('')).toContain('"partial_json":"{}"');
  });

  it('emits every ordered Anthropic block from a multipart upstream SSE frame', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];

    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    const payload = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'reasoning first',
                thought: true,
                thoughtSignature: Buffer.from('multipart-signature').toString('base64'),
              },
              {
                functionCall: {
                  args: { city: 'Samara' },
                  id: 'call_weather',
                  name: 'get_weather',
                },
              },
              { text: 'final text' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
    stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
    stream.emit('end');
    await completed;

    const events = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .filter((eventPayload) => eventPayload !== '[DONE]')
      .map((eventPayload) => JSON.parse(eventPayload));

    expect(events.filter((event) => event.type === 'message_start')).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events.map((event) => event.delta?.thinking).filter(Boolean)).toEqual([
      'reasoning first',
    ]);
    expect(events.map((event) => event.delta?.signature).filter(Boolean)).toEqual([
      'multipart-signature',
    ]);
    expect(events.find((event) => event.content_block?.type === 'tool_use')).toMatchObject({
      content_block: { id: 'call_weather', name: 'get_weather' },
    });
    expect(events.map((event) => event.delta?.text).filter(Boolean)).toEqual(['final text']);
    expect(events.find((event) => event.type === 'message_delta')).toMatchObject({
      delta: { stop_reason: 'tool_use' },
    });
    expect(events.filter((event) => event.type === 'message_stop')).toHaveLength(1);
  });

  it('suppresses an exact same-frame tool replay on the assembled Anthropic wire', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    const payload = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { args: { city: 'Samara' }, id: 'call_weather', name: 'weather' } },
              { functionCall: { args: { city: 'Samara' }, id: 'call_weather', name: 'weather' } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
    stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
    stream.emit('end');
    await completed;

    const events = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    expect(events.filter((event) => event.content_block?.type === 'tool_use')).toEqual([
      expect.objectContaining({
        content_block: expect.objectContaining({ id: 'call_weather', name: 'weather' }),
      }),
    ]);
    expect(events.filter((event) => event.type === 'message_delta')).toEqual([
      expect.objectContaining({ delta: expect.objectContaining({ stop_reason: 'tool_use' }) }),
    ]);
    expect(events.filter((event) => event.type === 'message_stop')).toHaveLength(1);
  });

  it('emits one Anthropic wire error for a same-frame conflicting tool id without success terminators', () => {
    const service = new TestableProxyService();
    const controller = new ProxyController({} as any);
    const stream = new EventEmitter();
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };

    (controller as any).writeSseResponse(
      { hijack: vi.fn(), raw },
      service.testProcessStream(stream),
      'anthropic',
    );
    stream.emit(
      'data',
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"args":{"city":"Samara"},"id":"call_weather","name":"weather"}},{"functionCall":{"args":{"city":"Tolyatti"},"id":"call_weather","name":"weather"}}]}}]}\n\n',
      ),
    );

    const output = raw.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output.match(/event: error/g)).toHaveLength(1);
    expect(output).not.toContain('message_delta');
    expect(output).not.toContain('message_stop');
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('emits one OpenAI wire error and no DONE for a same-frame conflicting tool id', () => {
    const service = new TestableProxyService();
    const controller = new ProxyController({} as any);
    const stream = new EventEmitter();
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };

    (controller as any).writeSseResponse(
      { hijack: vi.fn(), raw },
      service.testOpenAIStream(stream),
    );
    stream.emit(
      'data',
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"args":{"city":"Samara"},"id":"call_weather","name":"weather"}},{"functionCall":{"args":{"city":"Tolyatti"},"id":"call_weather","name":"weather"}}]}}]}\n\n',
      ),
    );

    const output = raw.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output.match(/"error":\{/g)).toHaveLength(1);
    expect(output).not.toContain('[DONE]');
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it.each([
    ['chat', 400, 'invalid_request_error'],
    ['chat', 401, 'authentication_error'],
    ['chat', 403, 'permission_error'],
    ['chat', 429, 'rate_limit_error'],
    ['chat', 500, 'server_error'],
    ['chat', 503, 'server_error'],
    ['text', 400, 'invalid_request_error'],
    ['text', 401, 'authentication_error'],
    ['text', 403, 'permission_error'],
    ['text', 429, 'rate_limit_error'],
    ['text', 500, 'server_error'],
    ['text', 503, 'server_error'],
  ] as const)(
    'preserves an in-band %s stream error with status %i on the OpenAI wire',
    (variant, status, expectedType) => {
      const service = new TestableProxyService();
      const controller = new ProxyController({} as any);
      const stream = new EventEmitter();
      const raw = {
        end: vi.fn(),
        on: vi.fn(),
        writableEnded: false,
        write: vi.fn(),
        writeHead: vi.fn(),
      };

      (controller as any).writeSseResponse(
        { hijack: vi.fn(), raw },
        service.testOpenAIStream(stream, 'gpt-4o-mini', { variant, includeUsage: false }),
      );
      stream.emit(
        'data',
        Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"partial output"}]}}]}\n\n'),
      );
      stream.emit(
        'data',
        Buffer.from(
          `data: ${JSON.stringify({ error: { code: status, message: `upstream ${status} failure` } })}\n\n`,
        ),
      );
      stream.emit('end');

      const output = raw.write.mock.calls.map(([chunk]) => String(chunk)).join('');
      const terminalFrame = `data: {"error":{"message":"upstream ${status} failure","type":"${expectedType}","param":null,"code":null}}\n\n`;
      expect(output).toContain('partial output');
      expect(output).toContain(terminalFrame);
      expect(output.match(/"error":\{/g)).toHaveLength(1);
      expect(output).not.toContain('[DONE]');
      expect(raw.end).toHaveBeenCalledOnce();
    },
  );

  it('ends the assembled Responses wire with error then failed for a same-frame conflicting tool id', () => {
    const service = new TestableProxyService();
    const controller = new ProxyController({} as any);
    const stream = new EventEmitter();
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };

    (controller as any).writeSseResponse(
      { hijack: vi.fn(), raw },
      service.testResponsesStream(stream),
      'responses',
    );
    stream.emit(
      'data',
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"args":{"city":"Samara"},"id":"call_weather","name":"weather"}},{"functionCall":{"args":{"city":"Tolyatti"},"id":"call_weather","name":"weather"}}]}}]}\n\n',
      ),
    );

    const events = raw.write.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((chunk) => chunk.startsWith('event: '))
      .map((chunk) => JSON.parse(chunk.split('\n')[1].slice('data: '.length)));
    expect(events.map((event) => event.type).slice(-2)).toEqual(['error', 'response.failed']);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.some((event) => event.type === 'response.completed')).toBe(false);
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('emits one Anthropic wire error when only a done marker arrives', () => {
    const service = new TestableProxyService();
    const controller = new ProxyController({} as any);
    const stream = new EventEmitter();
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };
    const reply = { hijack: vi.fn(), raw };

    (controller as any).writeSseResponse(reply, service.testProcessStream(stream), 'anthropic');
    stream.emit('data', Buffer.from('data: [DONE]\n\n'));
    stream.emit('end');

    const output = raw.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toBe(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Internal Server Error"}}\n\n',
    );
    expect(output).not.toContain('message_delta');
    expect(output).not.toContain('message_stop');
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('keeps one Anthropic text block open across empty SSE keepalives', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];

    const completed = new Promise<void>((resolve, reject) => {
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    const initialPayload = JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: 'hello' }] },
        },
      ],
    });
    const finalPayload = JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: ' world' }] },
          finishReason: 'STOP',
        },
      ],
    });
    stream.emit(
      'data',
      Buffer.from(
        `data: ${initialPayload}\n\ndata:\n\ndata: \n\ndata:\n\ndata: \n\ndata: ${finalPayload}\n\n`,
      ),
    );
    stream.emit('end');
    await completed;

    const events = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .filter((eventPayload) => eventPayload !== '[DONE]')
      .map((eventPayload) => JSON.parse(eventPayload));

    const contentBlockStarts = events.filter((event) => event.type === 'content_block_start');
    const contentBlockStops = events.filter((event) => event.type === 'content_block_stop');
    const textDeltas = events.filter((event) => event.type === 'content_block_delta');

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(contentBlockStarts).toHaveLength(1);
    expect(contentBlockStops).toHaveLength(1);
    expect(contentBlockStarts[0]).toMatchObject({ index: 0 });
    expect(contentBlockStops[0]).toMatchObject({ index: 0 });
    expect(textDeltas.map((event) => event.delta.text).join('')).toBe('hello world');
  });

  it('injects Claude beta headers when handling Gemini-compatible Claude models', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });

    await service.handleGeminiGenerateContent('models/claude-sonnet-4-5', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const headers = mockGeminiClient.generateInternal.mock.calls[0][3];
    expect(headers['anthropic-beta']).toContain('claude-code-20250219');
  });

  it('tolerates malformed partial chunks and still completes Anthropic stream', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const resultObservable = service.testProcessStream(stream);

    let completed = false;
    let errored = false;

    const done = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: () => {},
        error: () => {
          errored = true;
          resolve();
        },
        complete: () => {
          completed = true;
          resolve();
        },
      });
    });

    setTimeout(() => {
      stream.emit('data', Buffer.from('data: {"invalid_json":\n\n'));
      const validPayload = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
      stream.emit('data', Buffer.from(`data: ${validPayload}\n\n`));
      stream.emit('end');
    }, 10);

    await done;

    expect(errored).toBe(false);
    expect(completed).toBe(true);
  });

  it('raises error for empty Gemini passthrough stream', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

    const observable = service.testPassthroughStream(stream);
    let errorMessage = '';

    const done = new Promise<void>((resolve) => {
      observable.subscribe({
        next: () => {},
        error: (error: Error) => {
          errorMessage = error.message;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    setTimeout(() => stream.emit('end'), 10);
    await done;

    expect(errorMessage).toBe('Empty response stream');
  });

  it('propagates Anthropic stream interruption errors', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const observable = service.testProcessStream(stream);
    let errorMessage = '';

    const done = new Promise<void>((resolve) => {
      observable.subscribe({
        next: () => {},
        error: (error: Error) => {
          errorMessage = error.message;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    setTimeout(() => stream.emit('error', new Error('upstream interrupted')), 10);
    await done;

    expect(errorMessage).toBe('upstream interrupted');
  });

  it('fails an idle Anthropic stream without emitting a success stop or OpenAI terminator', () => {
    vi.useFakeTimers();
    const service = new TestableProxyService();
    (service as any).streamIdleTimeoutMs = 1;
    const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const chunks: string[] = [];
    let errorMessage = '';

    service.testProcessStream(stream).subscribe({
      next: (chunk) => chunks.push(chunk),
      error: (error: Error) => {
        errorMessage = error.message;
      },
    });

    vi.advanceTimersByTime(1);

    expect(errorMessage).toBe('Upstream stream idle timeout after 300s');
    expect(chunks.join('')).not.toContain('message_stop');
    expect(chunks.join('')).not.toContain('[DONE]');
    expect(vi.getTimerCount()).toBe(0);
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('fails an in-band upstream error frame before emitting Anthropic success events', () => {
    const service = new TestableProxyService();
    const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const chunks: string[] = [];
    let errorMessage = '';

    service.testProcessStream(stream).subscribe({
      next: (chunk) => chunks.push(chunk),
      error: (error: Error) => {
        errorMessage = error.message;
      },
    });

    stream.emit(
      'data',
      Buffer.from('data: {"error":{"code":429,"message":"quota exhausted"}}\n\n'),
    );
    stream.emit('end');

    expect(errorMessage).toBe('quota exhausted');
    expect(chunks).toEqual([]);
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.destroy).toHaveBeenCalledOnce();

    stream.emit(
      'data',
      Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"late"}]}}]}\n\n'),
    );
    stream.emit('end');
    expect(chunks).toEqual([]);
  });

  it.each([
    ['string', 'quota exhausted', 'quota exhausted'],
    ['primitive', 429, 'Upstream stream error: 429'],
  ])('fails an Anthropic stream for an in-band %s error frame', (_kind, error, message) => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    let errorMessage = '';

    service.testProcessStream(stream).subscribe({
      next: (chunk) => chunks.push(chunk),
      error: (streamError: Error) => {
        errorMessage = streamError.message;
      },
    });

    stream.emit('data', Buffer.from(`data: ${JSON.stringify({ error })}\n\n`));
    stream.emit('end');

    expect(errorMessage).toBe(message);
    expect(chunks).toEqual([]);
  });

  it('rejects candidate-free, usage-only, and no-op Anthropic frames without success terminators', () => {
    const service = new TestableProxyService();

    for (const payload of [
      { candidates: [] },
      { usageMetadata: { totalTokenCount: 3 }, candidates: [{ finishReason: 'STOP' }] },
      { candidates: [{ content: { parts: [{}] } }] },
      { candidates: [{ content: { parts: [{ text: '' }] } }] },
    ]) {
      const stream = new EventEmitter();
      const chunks: string[] = [];
      let errorMessage = '';
      service.testProcessStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: (error: Error) => {
          errorMessage = error.message;
        },
      });

      stream.emit('data', Buffer.from(`data: ${JSON.stringify(payload)}\n\n`));
      stream.emit('end');

      expect(errorMessage).toBe('Empty response stream');
      expect(chunks.join('')).not.toContain('message_stop');
      expect(chunks.join('')).not.toContain('[DONE]');
    }
  });

  it('accepts valid Anthropic text, function-call, and thought-signature parts', () => {
    const service = new TestableProxyService();

    for (const part of [
      { text: 'text' },
      { functionCall: { name: 'weather', args: {} } },
      { thoughtSignature: 'c2ln' },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ]) {
      const stream = new EventEmitter();
      let completed = false;
      let errorMessage = '';

      service.testProcessStream(stream).subscribe({
        error: (error: Error) => {
          errorMessage = error.message;
        },
        complete: () => {
          completed = true;
        },
      });

      stream.emit(
        'data',
        Buffer.from(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [part] } }] })}\n\n`,
        ),
      );
      stream.emit('end');

      expect(errorMessage).toBe('');
      expect(completed).toBe(true);
      expect(stream.listenerCount('data')).toBe(0);
      expect(stream.listenerCount('end')).toBe(0);
      expect(stream.listenerCount('error')).toBe(0);
    }
  });

  it('removes Anthropic listeners after upstream error and unsubscribe', () => {
    const service = new TestableProxyService();
    const errored = new EventEmitter();
    const subscription = service.testProcessStream(errored).subscribe({ error: () => {} });

    errored.emit('error', new Error('connection reset'));
    expect(errored.listenerCount('data')).toBe(0);
    expect(errored.listenerCount('end')).toBe(0);
    expect(errored.listenerCount('error')).toBe(0);
    subscription.unsubscribe();

    const unsubscribed = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const activeSubscription = service
      .testProcessStream(unsubscribed)
      .subscribe({ error: () => {} });
    activeSubscription.unsubscribe();

    expect(unsubscribed.listenerCount('data')).toBe(0);
    expect(unsubscribed.listenerCount('end')).toBe(0);
    expect(unsubscribed.listenerCount('error')).toBe(0);
    expect(unsubscribed.destroy).toHaveBeenCalledOnce();
  });

  it('does not emit Anthropic success terminators after an in-band failure', () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    let errorMessage = '';

    service.testProcessStream(stream).subscribe({
      next: (chunk) => chunks.push(chunk),
      error: (error: Error) => {
        errorMessage = error.message;
      },
    });

    stream.emit(
      'data',
      Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'),
    );
    stream.emit('data', Buffer.from('data: {"error":"quota exhausted"}\n\n'));
    stream.emit('end');

    expect(errorMessage).toBe('quota exhausted');
    expect(chunks.join('')).not.toContain('message_stop');
    expect(chunks.join('')).not.toContain('[DONE]');
  });

  it('emits one Anthropic wire error for an in-band upstream error frame without success events', () => {
    const service = new TestableProxyService();
    const controller = new ProxyController({} as any);
    const stream = new EventEmitter();
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };

    (controller as any).writeSseResponse(
      { hijack: vi.fn(), raw },
      service.testProcessStream(stream),
      'anthropic',
    );
    stream.emit(
      'data',
      Buffer.from('data: {"error":{"code":429,"message":"quota exhausted"}}\n\n'),
    );
    stream.emit('end');

    const output = raw.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toBe(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"quota exhausted"}}\n\n',
    );
    expect(output).not.toContain('message_start');
    expect(output).not.toContain('message_delta');
    expect(output).not.toContain('message_stop');
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('emits one Anthropic wire error after four malformed upstream frames without success terminators', () => {
    const service = new TestableProxyService();
    const controller = new ProxyController({} as any);
    const stream = new EventEmitter();
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };
    const reply = { hijack: vi.fn(), raw };

    (controller as any).writeSseResponse(reply, service.testProcessStream(stream), 'anthropic');
    stream.emit(
      'data',
      Buffer.from('data: {oops\n\ndata: {oops\n\ndata: {oops\n\ndata: {oops\n\n'),
    );
    stream.emit('end');

    const output = raw.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(output).toContain(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Internal Server Error"}}\n\n',
    );
    expect(output).not.toContain('network_error');
    expect(output).not.toContain('message_delta');
    expect(output).not.toContain('message_stop');
    expect(output).not.toContain('[DONE]');
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('fails an idle Gemini passthrough stream instead of completing successfully', () => {
    vi.useFakeTimers();
    const service = new TestableProxyService();
    (service as any).streamIdleTimeoutMs = 1;
    const stream = new EventEmitter();
    let completed = false;
    let errorMessage = '';

    service.testPassthroughStream(stream).subscribe({
      complete: () => {
        completed = true;
      },
      error: (error: Error) => {
        errorMessage = error.message;
      },
    });

    vi.advanceTimersByTime(1);
    vi.useRealTimers();

    expect(completed).toBe(false);
    expect(errorMessage).toBe('Upstream stream idle timeout after 300s');
  });

  it('propagates Gemini passthrough interruption errors', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const observable = service.testPassthroughStream(stream);
    let errorMessage = '';

    const done = new Promise<void>((resolve) => {
      observable.subscribe({
        next: () => {},
        error: (error: Error) => {
          errorMessage = error.message;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    setTimeout(() => stream.emit('error', new Error('connection reset by peer')), 10);
    await done;

    expect(errorMessage).toBe('connection reset by peer');
  });

  it('retries OpenAI flow with the same error classification matrix', async () => {
    const service = new TestableProxyService();
    const token1 = createToken('acc-1');
    const token2 = createToken('acc-2');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(token1)
      .mockResolvedValueOnce(token2);
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(new Error('429 quota exceeded'))
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    const result = await service.handleChatCompletions({
      model: 'gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    } as any);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(2);
    expect(mockAccountLeaseService.markAsRateLimited).toHaveBeenCalledWith('acc-1');
    expect((result as any).choices?.[0]?.message?.content).toBeDefined();
  });

  it('retries Anthropic flow with the same error classification matrix', async () => {
    const service = new TestableProxyService();
    const token1 = createToken('acc-1');
    const token2 = createToken('acc-2');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(token1)
      .mockResolvedValueOnce(token2);
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(new Error('429 rate limit exceeded'))
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    const result = await service.handleAnthropicMessages({
      model: 'claude-sonnet-4-5',
      stream: false,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    } as any);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(2);
    expect(mockAccountLeaseService.markAsRateLimited).toHaveBeenCalledWith('acc-1');
    expect((result as any).type).toBe('message');
  });

  it('retries Gemini flow with the same error classification matrix', async () => {
    const service = new TestableProxyService();
    const token1 = createToken('acc-1');
    const token2 = createToken('acc-2');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(token1)
      .mockResolvedValueOnce(token2);
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(new Error('429 quota exceeded'))
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    const result = await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(2);
    expect(mockAccountLeaseService.markAsRateLimited).toHaveBeenCalledWith('acc-1');
    expect((result as any).candidates?.[0]?.content?.parts?.[0]?.text).toBe('ok');
  });

  it('does not include sessionId in Gemini internal generate payload', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalPayload).not.toHaveProperty('sessionId');
  });

  it('normalizes Gemini 3.1 preview alias to Gemini 3.1 Pro High for upstream', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleGeminiGenerateContent('models/gemini-3.1-pro-preview', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalPayload.model).toBe('gemini-3.1-pro-high');
  });

  it('strips non-parity Gemini usage metadata fields', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        totalTokenCount: 3,
        thoughtsTokenCount: 4,
      },
      responseId: 'resp_123',
      createTime: '2026-02-10T00:00:00.000Z',
    });

    const result = await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    expect((result as any).usageMetadata).toEqual({
      promptTokenCount: 1,
      candidatesTokenCount: 2,
      totalTokenCount: 3,
    });
    expect((result as any).usageMetadata.thoughtsTokenCount).toBeUndefined();
  });

  it('throws the project-context fallback failure after Anthropic retries are exhausted', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(
        new Error(
          'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
        ),
      )
      .mockRejectedValueOnce(new Error('project fallback failed'))
      .mockRejectedValueOnce(
        new Error(
          'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
        ),
      )
      .mockRejectedValueOnce(new Error('project fallback failed'))
      .mockRejectedValueOnce(
        new Error(
          'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
        ),
      )
      .mockRejectedValueOnce(new Error('project fallback failed'));

    await expect(
      service.handleAnthropicMessages({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      } as any),
    ).rejects.toThrow('project fallback failed');
  });

  it('throws the quota-downgrade failure after Anthropic retries are exhausted', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(new Error('429 quota exhausted'))
      .mockRejectedValueOnce(new Error('quota downgrade failed'))
      .mockRejectedValueOnce(new Error('429 quota exhausted'))
      .mockRejectedValueOnce(new Error('quota downgrade failed'))
      .mockRejectedValueOnce(new Error('429 quota exhausted'))
      .mockRejectedValueOnce(new Error('quota downgrade failed'));

    await expect(
      service.handleAnthropicMessages({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      } as any),
    ).rejects.toThrow('quota downgrade failed');
  });

  it('retries Gemini generate-content without project when project context is invalid', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(
        new Error(
          'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
        ),
      )
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    const result = await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(1);
    expect(mockGeminiClient.generateInternal).toHaveBeenCalledTimes(2);
    expect(mockGeminiClient.generateInternal.mock.calls[0][0].project).toBe('project-1');
    expect(mockGeminiClient.generateInternal.mock.calls[1][0].project).toBeUndefined();
    expect(mockGeminiClient.generateInternal.mock.calls[1][0]).not.toHaveProperty('project');
    expect((result as any).candidates?.[0]?.content?.parts?.[0]?.text).toBe('ok');
  });

  it('omits empty project id in Gemini internal payload', async () => {
    const service = new TestableProxyService();
    const token = createToken('acc-1');
    token.token.project_id = '';
    mockAccountLeaseService.getNextToken.mockResolvedValue(token);
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalPayload.project).toBeUndefined();
    expect(internalPayload).not.toHaveProperty('project');
  });

  it('uses generate-content requestType for Gemini stream internal payload', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(new EventEmitter());

    await service.handleGeminiStreamGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.streamGenerateInternal.mock.calls[0][0];
    expect(internalPayload.requestType).toBe('generate-content');
  });
});

describe('GeminiClient internal request parity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses fixed-length JSON body for non-stream internal requests', async () => {
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      },
    });
    const client = new GeminiClient();

    await client.generateInternal({ project: 'project-1', request: {} } as any, 'access-token');

    expect(postSpy).toHaveBeenCalledOnce();
    expect(postSpy.mock.calls[0][1]).toBe(JSON.stringify({ project: 'project-1', request: {} }));
    expect(postSpy.mock.calls[0][1]).not.toBeInstanceOf(Readable);
  });

  it('uses stream body only for streamGenerateContent internal requests', async () => {
    const responseStream = new EventEmitter();
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: responseStream,
    });
    const client = new GeminiClient();

    await client.streamGenerateInternal(
      { project: 'project-1', request: {} } as any,
      'access-token',
    );

    expect(postSpy).toHaveBeenCalledOnce();
    expect(postSpy.mock.calls[0][1]).toBeInstanceOf(Readable);
  });

  it('retries from the first endpoint without x-goog-user-project after project-header 403', async () => {
    const forbidden = new AxiosError(
      'Request failed with status code 403',
      undefined,
      undefined,
      undefined,
      {
        data: { error: { message: 'SERVICE_DISABLED' } },
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        config: {} as any,
      },
    );
    const postSpy = vi
      .spyOn(axios, 'post')
      .mockRejectedValueOnce(forbidden)
      .mockResolvedValueOnce({
        data: {
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        },
      });
    const client = new GeminiClient();

    await client.generateInternal({ project: 'project-1', request: {} } as any, 'access-token');

    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls[1][0]).toBe(postSpy.mock.calls[0][0]);
    expect(postSpy.mock.calls[0][2]?.headers?.['x-goog-user-project']).toBe('project-1');
    expect(postSpy.mock.calls[1][2]?.headers).not.toHaveProperty('x-goog-user-project');
  });
});

describe('ProxyService Protocol Parity Fixtures', () => {
  it('maps OpenAI request to Anthropic request with tools and tool result', () => {
    const service = new TestableProxyService();

    const openaiRequest = {
      model: 'claude-sonnet-4-5',
      stream: false,
      temperature: 0.2,
      max_tokens: 512,
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_docs',
            description: 'Search docs',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
            },
          },
        },
      ],
      messages: [
        { role: 'system', content: 'You are a precise assistant.' },
        { role: 'user', content: [{ type: 'text', text: 'Find API key docs' }] },
        {
          role: 'assistant',
          content: 'Calling search tool',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'search_docs',
                arguments: '{"query":"api key"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'search_docs',
          content: 'Found 3 results',
        },
      ],
    };

    const anthropicRequest = (service as any).convertOpenAIToClaude(openaiRequest);

    expect(anthropicRequest.system).toContain('You are a precise assistant.');
    expect(anthropicRequest.tools?.[0]?.name).toBe('search_docs');
    expect(anthropicRequest.messages.length).toBe(3);

    const assistantMessage = anthropicRequest.messages[1];
    expect(Array.isArray(assistantMessage.content)).toBe(true);
    expect(assistantMessage.content.some((block: any) => block.type === 'tool_use')).toBe(true);

    const toolResultMessage = anthropicRequest.messages[2];
    expect(toolResultMessage.role).toBe('user');
    expect(Array.isArray(toolResultMessage.content)).toBe(true);
    expect(toolResultMessage.content[0].type).toBe('tool_result');
  });

  it('maps Anthropic response to OpenAI response with reasoning and tool_calls', () => {
    const service = new TestableProxyService();

    const anthropicResponse = {
      content: [
        { type: 'thinking', thinking: 'Need to call tool first.' },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'search_docs',
          input: { query: 'api key' },
        },
        { type: 'text', text: 'Here are the docs.' },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 20,
        output_tokens: 30,
      },
    };

    const openaiResponse = (service as any).convertClaudeToOpenAIResponse(
      anthropicResponse,
      'gpt-4o-mini',
    );

    expect(openaiResponse.model).toBe('gpt-4o-mini');
    expect(openaiResponse.choices[0].message.role).toBe('assistant');
    expect(openaiResponse.choices[0].message.reasoning_content).toContain('Need to call tool');
    expect(openaiResponse.choices[0].message.tool_calls?.length).toBe(1);
    expect(openaiResponse.choices[0].finish_reason).toBe('tool_calls');
  });

  it('converts internal SSE stream into OpenAI SSE chunks', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const observable = (service as any).processStreamResponse(stream, 'gpt-4o-mini');

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: reject,
        complete: resolve,
      });

      const payload = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'reasoning text' },
                { functionCall: { id: 'fc1', name: 'search_docs', args: { query: 'api key' } } },
                { text: 'final answer' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      });

      stream.emit('data', Buffer.from(`data: ${payload}\n`));
      stream.emit('end');
    });

    const output = chunks.join('');
    expect(output).not.toContain('__cloudCodeMeta');
    expect(output).toContain('"reasoning_content":"reasoning text"');
    expect(output).toContain('"tool_calls"');
    expect(output).toContain('"content":"final answer"');
    expect(output).toContain('data: [DONE]');
  });

  it.each([
    ['Chat Completions', undefined],
    ['legacy Completions', { variant: 'text', includeUsage: false }],
  ])(
    'fails a %s stream on malformed function arguments without emitting later text or [DONE]',
    async (_variant, streamOptions) => {
      const service = new TestableProxyService();
      const stream = new EventEmitter();
      const observable = (service as any).processStreamResponse(
        stream,
        'gpt-4o-mini',
        undefined,
        streamOptions,
      );
      const chunks: string[] = [];
      const outcome = await new Promise<{ completed: boolean; error?: Error }>((resolve) => {
        observable.subscribe({
          next: (chunk: string) => chunks.push(chunk),
          error: (error: unknown) =>
            resolve({
              completed: false,
              error: error instanceof Error ? error : new Error(String(error)),
            }),
          complete: () => resolve({ completed: true }),
        });
        stream.emit(
          'data',
          Buffer.from(
            'data: {"candidates":[{"content":{"parts":[{"functionCall":{"args":[],"name":"invalid"},"text":"partial"}]}}]}\n',
          ),
        );
        stream.emit(
          'data',
          Buffer.from(
            'data: {"candidates":[{"content":{"parts":[{"text":"later text"}]},"finishReason":"STOP"}]}\n',
          ),
        );
        stream.emit('end');
      });

      expect(outcome.completed).toBe(false);
      expect(outcome.error?.message).toContain('functionCall.args');
      expect(chunks.join('')).not.toContain('partial');
      expect(chunks.join('')).not.toContain('later text');
      expect(chunks.join('')).not.toContain('[DONE]');
    },
  );

  it('prepends legacy Cloud Code metadata only when explicitly enabled', async () => {
    setServerConfig(
      createProxyConfig({
        experimental: {
          enable_cloud_code_meta: true,
        },
      }),
    );

    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const observable = (service as any).processStreamResponse(stream, 'gpt-4o-mini');

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: reject,
        complete: resolve,
      });

      const payload = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'final answer' }],
            },
            finishReason: 'STOP',
          },
        ],
      });

      stream.emit('data', Buffer.from(`data: ${payload}\n`));
      stream.emit('end');
    });

    const metaPayload = JSON.parse(chunks[0].trim().slice('data: '.length));
    expect(metaPayload.__cloudCodeMeta.traceId).toMatch(/^req_[a-f0-9]{12}$/);
    expect(chunks.join('')).toContain('"content":"final answer"');
  });

  it('propagates OpenAI-compatible upstream stream errors instead of completing with [DONE]', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const observable = (service as any).processStreamResponse(stream, 'gpt-4o-mini');
    const chunks: string[] = [];

    const streamResult = await new Promise<{ error?: Error; completed: boolean }>((resolve) => {
      observable.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: (error: unknown) =>
          resolve({
            completed: false,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        complete: () => resolve({ completed: true }),
      });

      const payload = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'partial output' }],
            },
          },
        ],
      });

      stream.emit('data', Buffer.from(`data: ${payload}\n`));
      stream.emit('error', new Error('socket hang up'));
    });

    expect(streamResult.completed).not.toBe(true);
    expect(streamResult.error?.message).toContain('socket hang up');
    expect(chunks.join('')).toContain('"content":"partial output"');
    expect(chunks.join('')).not.toContain('data: [DONE]');
  });
});
