import { beforeEach, describe, it, expect, vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import { EventEmitter } from 'events';
import { Readable } from 'node:stream';
import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';
import { Observable } from 'rxjs';
import { GeminiClient } from '../../modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { GenerationConstraintsService } from '../../modules/proxy-gateway/server/modules/shared/services/generation-constraints.service';
import { ProxyRetryService } from '../../modules/proxy-gateway/server/modules/shared/services/proxy-retry.service';
import { ModelAvailabilityService } from '../../modules/proxy-gateway/server/modules/shared/services/model-availability.service';
import { ModelRoutingService } from '../../modules/proxy-gateway/server/modules/shared/services/model-routing.service';
import { setServerConfig } from '../../server/server-config';
import { DEFAULT_APP_CONFIG, ProxyConfig } from '@/modules/config/types';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

// Mock dependencies
const mockAccountLeaseService = {
  getNextToken: vi.fn(),
  markAsRateLimited: vi.fn(),
  markModelSuccess: vi.fn(),
  markAsForbidden: vi.fn(),
  markFromUpstreamError: vi.fn(),
  getRemainingRateLimitWait: vi.fn().mockReturnValue(30),
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
    super(
      mockAccountLeaseService as any,
      mockGeminiClient as any,
      new GenerationConstraintsService(mockAccountLeaseService as any),
      new ProxyRetryService(mockAccountLeaseService as any, new ModelAvailabilityService()),
      new ModelRoutingService(),
      new SignatureStore(),
    );
  }

  public testProcessStream(stream: any, model: string = 'model'): Observable<string> {
    // Access private method using type assertion
    return (this as any).processAnthropicInternalStream(stream, {
      accountId: 'test-account',
      model,
      store: this.signatureStore,
    });
  }

  public testPassthroughStream(stream: any): Observable<string> {
    return (this as any).passthroughSseStream(stream);
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

  it('preserves every part from a multi-part Anthropic stream event', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = (await service.handleAnthropicMessages({
      model: 'gemini-3.5-flash',
      stream: true,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    } as any)) as Observable<string>;
    const receivedChunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      result.subscribe({
        next: (chunk) => receivedChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    const payload = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'reasoning', thought: true }, { text: 'final answer' }],
          },
          finishReason: 'STOP',
        },
      ],
    });
    stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
    stream.emit('end');
    await done;

    const response = receivedChunks.join('');
    expect(response).toContain('"type":"thinking_delta"');
    expect(response).toContain('"text":"final answer"');
  });

  it('preserves text from wrapped Anthropic stream events', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = (await service.handleAnthropicMessages({
      model: 'gemini-3.5-flash',
      stream: true,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    } as any)) as Observable<string>;
    const receivedChunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      result.subscribe({
        next: (chunk) => receivedChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    const payload = JSON.stringify({
      response: {
        candidates: [
          {
            content: { parts: [{ text: 'wrapped answer' }] },
            finishReason: 'STOP',
          },
        ],
      },
    });
    stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
    stream.emit('end');
    await done;

    expect(receivedChunks.join('')).toContain('"text":"wrapped answer"');
  });

  it('aggregates a wrapped stream when the non-stream Gemini response is empty', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.generateInternal.mockResolvedValueOnce({ candidates: [] });
    mockGeminiClient.streamGenerateInternal.mockResolvedValueOnce(stream);

    const promise = service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });

    setTimeout(() => {
      const payload = JSON.stringify({
        response: {
          candidates: [
            {
              content: { parts: [{ text: 'fallback text' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { totalTokenCount: 5 },
        },
      });
      stream.emit('data', Buffer.from('data: not json\n\n'));
      stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
      stream.emit('end');
    }, 10);

    const result = await promise;
    const candidate = result.candidates?.[0];
    if (!candidate) {
      throw new Error('Expected the wrapped fallback stream to produce a candidate');
    }

    expect(mockGeminiClient.streamGenerateInternal).toHaveBeenCalledOnce();
    expect(candidate.content?.parts[0]?.text).toBe('fallback text');
    expect(candidate.finishReason).toBe('STOP');
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

  it('resets Anthropic parse-error recovery after a valid chunk', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const resultObservable = service.testProcessStream(stream);

    let completed = false;
    let errored = false;
    const receivedChunks: string[] = [];

    const done = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: (chunk) => receivedChunks.push(chunk),
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
      for (let index = 0; index < 3; index++) {
        stream.emit('data', Buffer.from('data: {"invalid_json":\n\n'));
      }
      const validPayload = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
      stream.emit('data', Buffer.from(`data: ${validPayload}\n\n`));
      for (let index = 0; index < 3; index++) {
        stream.emit('data', Buffer.from('data: {"invalid_json":\n\n'));
      }
      stream.emit('end');
    }, 10);

    await done;

    expect(errored).toBe(false);
    expect(completed).toBe(true);
    expect(receivedChunks.join('')).not.toContain('stream_decode_error');
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
    expect(mockAccountLeaseService.markFromUpstreamError).toHaveBeenCalledWith({
      accountIdOrEmail: 'acc-1',
      status: 429,
      body: '429 quota exceeded',
      model: 'gemini-3-flash',
    });
    expect((result as any).choices?.[0]?.message?.content).toBeDefined();
  });

  it('restores Markdown Base64 images on the public OpenAI chat path', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleChatCompletions({
      model: 'gemini-3-flash',
      stream: false,
      messages: [
        {
          role: 'user',
          content: 'Inspect ![screen](data:image/png;base64,AAAABBBB) carefully.',
        },
      ],
    });

    const internalRequest = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalRequest.request.contents[0].parts).toEqual([
      { text: 'Inspect ' },
      { inlineData: { mimeType: 'image/png', data: 'AAAABBBB' } },
      { text: ' carefully.' },
    ]);
  });

  it('replays captured signatures only for the same selected account and effective model', async () => {
    setServerConfig(
      createProxyConfig({ custom_mapping: { 'custom-tool-model': 'custom-tool-model' } }),
    );
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(createToken('acc-1'))
      .mockResolvedValueOnce(createToken('acc-1'))
      .mockResolvedValueOnce(createToken('acc-2'));
    mockGeminiClient.generateInternal
      .mockResolvedValueOnce({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { id: 'call-1', name: 'search_docs', args: { query: 'api' } },
                  thoughtSignature: Buffer.from('account-one-signature').toString('base64'),
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      })
      .mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });

    await service.handleChatCompletions({
      model: 'custom-tool-model',
      stream: false,
      messages: [{ role: 'user', content: 'Search the docs.' }],
    });

    const continuation = {
      model: 'custom-tool-model',
      stream: false,
      messages: [
        {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function' as const,
              function: { name: 'search_docs', arguments: '{"query":"api"}' },
            },
          ],
        },
        { role: 'tool' as const, tool_call_id: 'call-1', content: 'Found it.' },
      ],
    };
    await service.handleChatCompletions(continuation);
    await service.handleChatCompletions(continuation);

    const sameAccountBody = mockGeminiClient.generateInternal.mock.calls[1][0];
    const otherAccountBody = mockGeminiClient.generateInternal.mock.calls[2][0];
    const findToolCall = (body: any) =>
      body.request.contents
        .flatMap((content: any) => content.parts)
        .find((part: any) => part.functionCall?.id === 'call-1');

    expect(findToolCall(sameAccountBody)).toMatchObject({
      thoughtSignature: 'account-one-signature',
      thought_signature: 'account-one-signature',
    });
    expect(findToolCall(otherAccountBody)?.thoughtSignature).toBeUndefined();
    expect(findToolCall(otherAccountBody)?.thought_signature).toBeUndefined();
  });

  it('returns every Gemini candidate with stable indexes and mapped Chat logprobs', async () => {
    setServerConfig(
      createProxyConfig({ custom_mapping: { 'custom-multi-model': 'custom-multi-model' } }),
    );
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [
        {
          index: 0,
          content: { parts: [{ text: 'first' }] },
          finishReason: 'STOP',
          logprobsResult: {
            chosenCandidates: [{ token: 'first', logProbability: -0.1 }],
            topCandidates: [
              {
                candidates: [
                  { token: 'first', logProbability: -0.1 },
                  { token: 'second', logProbability: -1.2 },
                ],
              },
            ],
          },
        },
        {
          index: 1,
          content: { parts: [{ text: 'second' }] },
          finishReason: 'MAX_TOKENS',
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 4,
        totalTokenCount: 7,
      },
    });

    const result = await service.handleChatCompletions({
      model: 'custom-multi-model',
      messages: [{ role: 'user', content: 'give two' }],
      n: 2,
      logprobs: true,
      top_logprobs: 2,
      service_tier: 'auto',
      user: 'stable-user',
    });

    expect(result).not.toBeInstanceOf(Observable);
    if (result instanceof Observable) {
      throw new Error('Expected a non-stream response');
    }
    expect(result.choices).toMatchObject([
      {
        index: 0,
        message: { content: 'first' },
        finish_reason: 'stop',
        logprobs: {
          content: [
            {
              token: 'first',
              logprob: -0.1,
              bytes: [102, 105, 114, 115, 116],
              top_logprobs: [
                { token: 'first', logprob: -0.1 },
                { token: 'second', logprob: -1.2 },
              ],
            },
          ],
        },
      },
      {
        index: 1,
        message: { content: 'second' },
        finish_reason: 'length',
        logprobs: null,
      },
    ]);
    expect(result.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
    expect(result.service_tier).toBe('default');
    expect(
      mockGeminiClient.generateInternal.mock.calls[0][0].request.generationConfig,
    ).toMatchObject({
      candidateCount: 2,
      responseLogprobs: true,
      logprobs: 2,
    });
    expect(mockGeminiClient.generateInternal.mock.calls[0][0].sessionId).toBe('stable-user');
  });

  it('maps Gemini policy finishes to the standard content_filter reason', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [
        {
          index: 0,
          content: { parts: [{ text: '' }] },
          finishReason: 'SAFETY',
        },
      ],
    });

    const result = await service.handleChatCompletions({
      model: 'custom-safety-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    if (result instanceof Observable) {
      throw new Error('Expected a non-stream response');
    }

    expect(result.choices[0]).toMatchObject({
      finish_reason: 'content_filter',
      message: {
        refusal: expect.stringContaining('finishReason: SAFETY'),
      },
    });
  });

  it('terminates public Anthropic streams on conflicting tool-call id reuse', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(
      Readable.from([
        Buffer.from(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      { functionCall: { id: 'call-1', name: 'search', args: { query: 'a' } } },
                      { functionCall: { id: 'call-1', name: 'search', args: { query: 'b' } } },
                    ],
                  },
                },
              ],
            },
          })}\n\n`,
        ),
      ]),
    );

    const result = await service.handleAnthropicMessages({
      model: 'gemini-3-flash',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Search.' }],
    });
    expect(result).toBeInstanceOf(Observable);
    const error = await new Promise<unknown>((resolve, reject) => {
      (result as Observable<string>).subscribe({
        error: resolve,
        complete: () => reject(new Error('Expected stream failure')),
      });
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ToolCallIdConflictError');
  });

  it('terminates public Responses streams on malformed present function arguments', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(
      Readable.from([
        Buffer.from(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ functionCall: { id: 'call-bad', name: 'search', args: null } }],
                  },
                },
              ],
            },
          })}\n\n`,
        ),
      ]),
    );

    const result = await service.handleChatCompletions(
      {
        model: 'gemini-3-flash',
        stream: true,
        messages: [{ role: 'user', content: 'Search.' }],
      },
      'responses',
    );
    expect(result).toBeInstanceOf(Observable);
    const error = await new Promise<unknown>((resolve, reject) => {
      (result as Observable<string>).subscribe({
        error: resolve,
        complete: () => reject(new Error('Expected stream failure')),
      });
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('InvalidFunctionCallArgumentsError');
  });

  it('keeps the web-search fallback selected by the request mapper', async () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: {
          'custom-search-model': 'custom-search-model',
        },
      }),
    );
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleChatCompletions({
      model: 'custom-search-model',
      stream: false,
      messages: [{ role: 'user', content: 'Search the documentation.' }],
      tools: [{ type: 'web_search_20250305' }],
    });

    const internalRequest = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalRequest.model).toBe('gemini-3-flash');
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
    expect(mockAccountLeaseService.markFromUpstreamError).toHaveBeenCalledWith({
      accountIdOrEmail: 'acc-1',
      status: 429,
      body: '429 rate limit exceeded',
      model: 'claude-sonnet-4-6-thinking',
    });
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
    expect(mockAccountLeaseService.markFromUpstreamError).toHaveBeenCalledWith({
      accountIdOrEmail: 'acc-1',
      status: 429,
      body: '429 quota exceeded',
      model: 'gemini-3-flash',
    });
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

  it('preserves provider Gemini usage and response metadata', async () => {
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
      thoughtsTokenCount: 4,
    });
    expect((result as any).responseId).toBe('resp_123');
    expect((result as any).createTime).toBe('2026-02-10T00:00:00.000Z');
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
  beforeEach(() => {
    vi.clearAllMocks();
    setServerConfig(createProxyConfig());
  });

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

  it('unwraps internal SSE responses and keeps reasoning separate from content', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleChatCompletions({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'Find the API key docs' }],
    });
    if (!(result instanceof Observable)) {
      throw new Error('Expected an OpenAI-compatible SSE stream');
    }

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      result.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: reject,
        complete: resolve,
      });

      const payload = JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: '<think>\nreasoning text\n</think>' },
                  { text: 'final answer' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      });

      stream.emit('data', Buffer.from('data: not json\n'));
      stream.emit('data', Buffer.from(`data: ${payload}\n`));
      stream.emit('end');
    });

    const payloads = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const deltas = payloads.flatMap((payload) =>
      payload.choices.map((choice: { delta: Record<string, unknown> }) => choice.delta),
    );

    expect(payloads.some((payload) => '__cloudCodeMeta' in payload)).toBe(false);
    expect(deltas).toContainEqual({ role: 'assistant', content: '' });
    expect(deltas).toContainEqual({ content: null, reasoning_content: 'reasoning text' });
    expect(deltas).toContainEqual({ content: 'final answer' });
    expect(
      deltas.some(
        (delta) => 'content' in delta && delta.content !== null && 'reasoning_content' in delta,
      ),
    ).toBe(false);
    expect(chunks.filter((chunk) => chunk.includes('data: [DONE]'))).toHaveLength(1);
  });

  it('streams every requested choice and emits usage only in the final usage chunk', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleChatCompletions({
      model: 'custom-multi-model',
      stream: true,
      stream_options: { include_usage: true },
      n: 2,
      service_tier: 'auto',
      messages: [{ role: 'user', content: 'give two answers' }],
    });
    if (!(result instanceof Observable)) {
      throw new Error('Expected an OpenAI-compatible SSE stream');
    }

    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      result.subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.emit(
      'data',
      Buffer.from(
        `data: ${JSON.stringify({
          response: {
            candidates: [
              {
                index: 0,
                content: { parts: [{ text: 'first' }] },
                finishReason: 'STOP',
              },
              {
                index: 1,
                content: { parts: [{ text: 'second' }] },
                finishReason: 'MAX_TOKENS',
              },
            ],
            usageMetadata: {
              promptTokenCount: 3,
              candidatesTokenCount: 4,
              totalTokenCount: 7,
            },
          },
        })}\n`,
      ),
    );
    stream.emit('end');
    await completed;

    const payloads = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const normalChunks = payloads.filter((payload) => payload.choices.length > 0);
    const finishChoices = normalChunks
      .flatMap((payload) => payload.choices)
      .filter((choice) => choice.finish_reason !== null);
    const usageChunk = payloads.at(-1);

    expect(finishChoices).toMatchObject([
      { index: 0, finish_reason: 'stop' },
      { index: 1, finish_reason: 'length' },
    ]);
    expect(normalChunks.every((payload) => payload.usage === null)).toBe(true);
    expect(payloads.every((payload) => payload.service_tier === 'default')).toBe(true);
    expect(usageChunk).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    expect(chunks.filter((chunk) => chunk.includes('data: [DONE]'))).toHaveLength(1);
    expect(
      mockGeminiClient.streamGenerateInternal.mock.calls.at(-1)?.[0].request.generationConfig,
    ).toMatchObject({ candidateCount: 2 });
  });

  it('preserves choices, reasoning, and tools in the synthetic stream fallback', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockRejectedValue(new Error('stream unavailable'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [
        {
          index: 0,
          content: {
            parts: [{ thought: true, text: 'reasoning' }, { text: 'first answer' }],
          },
          finishReason: 'STOP',
        },
        {
          index: 1,
          content: {
            parts: [
              {
                functionCall: { id: 'call_lookup', name: 'lookup', args: { key: 'value' } },
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 },
    });

    const result = await service.handleChatCompletions({
      model: 'custom-multi-model',
      stream: true,
      stream_options: { include_usage: true },
      n: 2,
      messages: [{ role: 'user', content: 'answer or call a tool' }],
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        },
      ],
    });
    if (!(result instanceof Observable)) {
      throw new Error('Expected an OpenAI-compatible SSE stream');
    }

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      result.subscribe({ next: (chunk) => chunks.push(chunk), error: reject, complete: resolve });
    });
    const payloads = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const choices = payloads.flatMap((payload) => payload.choices);
    const deltas = choices.map((choice) => choice.delta);

    expect(deltas).toContainEqual({ content: null, reasoning_content: 'reasoning' });
    expect(deltas).toContainEqual({ content: 'first answer' });
    expect(
      deltas.some(
        (delta) =>
          delta.tool_calls?.[0]?.id === 'call_lookup' &&
          delta.tool_calls[0].function.name === 'lookup',
      ),
    ).toBe(true);
    expect(choices.filter((choice) => choice.finish_reason !== null)).toMatchObject([
      { index: 0, finish_reason: 'stop' },
      { index: 1, finish_reason: 'tool_calls' },
    ]);
    expect(payloads.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    });
  });

  it('matches stable tool-call ordering, deduplication, signatures, and finish semantics', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const signatureState = {
      accountId: 'account-a',
      model: 'gemini-3-pro',
      store: service.signatureStore,
    };
    const observable = (service as any).processStreamResponse(
      stream,
      'gpt-4o-mini',
      undefined,
      signatureState,
    );

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: reject,
        complete: resolve,
      });

      const firstToolCall = {
        id: 'fc1',
        name: 'search_docs',
        args: { query: 'api key' },
      };
      const payload = JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    thought: true,
                    text: 'reasoning text',
                    thoughtSignature: Buffer.from('stable signature').toString('base64'),
                  },
                  { functionCall: firstToolCall },
                  { functionCall: firstToolCall },
                  {
                    functionCall: {
                      id: 'fc2',
                      name: 'open_document',
                      args: { path: '/docs/api.md' },
                    },
                  },
                  { text: 'final answer' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            totalTokenCount: 14,
          },
        },
      });

      stream.emit('data', Buffer.from(`data: ${payload}\n`));
      stream.emit('end');
    });

    const payloads = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const choices = payloads.flatMap((payload) => payload.choices);
    const deltas = choices.map((choice: { delta: Record<string, unknown> }) => choice.delta);
    const toolDeltas = deltas.filter((delta) => 'tool_calls' in delta);
    const toolCalls = toolDeltas.flatMap(
      (delta) =>
        delta.tool_calls as Array<{
          index: number;
          id: string;
          function: { name: string };
        }>,
    );

    expect(toolCalls.map((toolCall) => toolCall.id)).toEqual(['fc1', 'fc2']);
    expect(toolCalls.map((toolCall) => toolCall.index)).toEqual([0, 1]);
    expect(deltas).toContainEqual({ role: 'assistant', content: '' });
    expect(toolDeltas.every((delta) => delta.role === undefined)).toBe(true);
    expect(deltas.findIndex((delta) => 'tool_calls' in delta)).toBeLessThan(
      deltas.findIndex((delta) => 'reasoning_content' in delta),
    );
    expect(deltas.findIndex((delta) => 'reasoning_content' in delta)).toBeLessThan(
      deltas.findIndex((delta) => delta.content === 'final answer'),
    );
    expect(choices.at(-1)?.finish_reason).toBe('tool_calls');
    expect(payloads.every((payload) => payload.usage === undefined)).toBe(true);
    expect(
      service.signatureStore.get({
        accountId: signatureState.accountId,
        model: signatureState.model,
        toolCallId: 'fc1',
      }),
    ).toBe('stable signature');
    expect(
      service.signatureStore.get({
        accountId: signatureState.accountId,
        model: signatureState.model,
        toolCallId: 'fc2',
      }),
    ).toBe('stable signature');
    expect(chunks.filter((chunk) => chunk.includes('data: [DONE]'))).toHaveLength(1);
  });

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

  it('reports an interrupted OpenAI stream when upstream ends without a finish reason', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const observable = (service as any).processStreamResponse(stream, 'gpt-4o-mini');
    const chunks: string[] = [];

    const streamResult = new Promise<Error | null>((resolve) => {
      observable.subscribe({
        next: (chunk: string) => chunks.push(chunk),
        error: (error: unknown) =>
          resolve(error instanceof Error ? error : new Error(String(error))),
        complete: () => resolve(null),
      });
    });

    stream.emit(
      'data',
      Buffer.from(
        `data: ${JSON.stringify({
          candidates: [{ index: 0, content: { parts: [{ text: 'partial' }] } }],
        })}\n`,
      ),
    );
    stream.emit('end');

    await expect(streamResult).resolves.toMatchObject({
      message: expect.stringContaining('ended before 1 choice(s) finished'),
    });
    expect(chunks.join('')).toContain('partial');
    expect(chunks.join('')).not.toContain('data: [DONE]');
  });

  it('destroys the upstream OpenAI stream when the client unsubscribes', async () => {
    const service = new TestableProxyService();
    const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleChatCompletions({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    if (!(result instanceof Observable)) {
      throw new Error('Expected an OpenAI-compatible SSE stream');
    }

    const subscription = result.subscribe();
    subscription.unsubscribe();

    expect(stream.destroy).toHaveBeenCalledOnce();
  });

  it('keeps an idle OpenAI SSE connection alive with standard comment frames', async () => {
    vi.useFakeTimers();
    try {
      const service = new TestableProxyService();
      const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
      mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

      const result = await service.handleChatCompletions({
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      });
      if (!(result instanceof Observable)) {
        throw new Error('Expected an OpenAI-compatible SSE stream');
      }

      const chunks: string[] = [];
      const subscription = result.subscribe((chunk) => chunks.push(chunk));
      await vi.advanceTimersByTimeAsync(15_000);

      expect(chunks).toContain(': ping\n\n');
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
