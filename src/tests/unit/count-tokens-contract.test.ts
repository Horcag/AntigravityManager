import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { ModelRouteError } from '@/modules/proxy-gateway/server/common/exceptions/model-route-exception';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request-exception';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import {
  CountTokensService,
  resolveCountTokensContents,
} from '@/modules/proxy-gateway/server/modules/shared/services/count-tokens.service';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/modules/shared/services/generation-constraints.service';
import { ModelAvailabilityService } from '@/modules/proxy-gateway/server/modules/shared/services/model-availability.service';
import { ModelRouteMissJournalService } from '@/modules/proxy-gateway/server/modules/shared/services/model-route-miss-journal.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/modules/shared/services/model-routing.service';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/modules/shared/services/proxy-retry.service';
import { setServerConfig } from '@/server/server-config';

const COUNT_TOKENS_URL = 'https://cloudcode-pa.googleapis.com/v1internal:countTokens';

const mockAccountLeaseService = {
  getNextToken: vi.fn(),
  getModelCatalogStatus: vi.fn(() => 'known'),
  getModelOutputLimitForAccount: vi.fn(),
  getModelThinkingBudgetForAccount: vi.fn(),
  getRemainingRateLimitWait: vi.fn(() => 0),
  markAsForbidden: vi.fn(),
  markAsRateLimited: vi.fn(),
  markFromUpstreamError: vi.fn(),
  markModelSuccess: vi.fn(),
  recordParityError: vi.fn(),
  resolveDynamicModelForAccount: vi.fn((_accountId: string, model: string) => model),
};

function createProxyConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    ...overrides,
  };
}

function createToken(id = 'acc-1') {
  return {
    id,
    email: `${id}@test.com`,
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: 'project-1',
      upstream_proxy_url: undefined,
    },
  };
}

function createService(): {
  service: CountTokensService;
  missJournal: ModelRouteMissJournalService;
} {
  const missJournal = new ModelRouteMissJournalService();
  const service = new CountTokensService(
    mockAccountLeaseService as never,
    new GeminiClient(),
    new GenerationConstraintsService(mockAccountLeaseService as never),
    new ProxyRetryService(mockAccountLeaseService as never, new ModelAvailabilityService()),
    new ModelRoutingService(),
    missJournal,
    new SignatureStore(),
  );
  return { service, missJournal };
}

function lastPostedBody(post: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(String(post.mock.calls.at(-1)?.[1])) as Record<string, unknown>;
}

function lastPostedHeaders(post: ReturnType<typeof vi.spyOn>): Record<string, string> {
  const config = post.mock.calls.at(-1)?.[2] as { headers?: Record<string, string> } | undefined;
  return config?.headers ?? {};
}

describe('countTokens wire contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccountLeaseService.getModelCatalogStatus.mockReturnValue('known');
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockAccountLeaseService.resolveDynamicModelForAccount.mockImplementation(
      (_accountId: string, model: string) => model,
    );
    setServerConfig(createProxyConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts the documented envelope: models/-prefixed id, contents, and no project anywhere', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { totalTokens: 42 } } as never);
    const { service } = createService();

    const result = await service.countGeminiTokens('models/gemini-3-flash', [
      { role: 'user', parts: [{ text: 'count me' }] },
    ]);

    expect(result).toEqual({ totalTokens: 42 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(COUNT_TOKENS_URL);
    expect(lastPostedBody(post)).toEqual({
      request: {
        model: 'models/gemini-3-flash',
        contents: [{ role: 'user', parts: [{ text: 'count me' }] }],
      },
    });
    expect(lastPostedHeaders(post)).not.toHaveProperty('x-goog-user-project');
  });

  it('routes through the model alias table like every other request', async () => {
    setServerConfig(
      createProxyConfig({
        model_aliases: [{ alias: 'my-counter', target: 'gemini-3-flash', enabled: true }],
      }),
    );
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { totalTokens: 7 } } as never);
    const { service } = createService();

    await service.countGeminiTokens('my-counter', [{ role: 'user', parts: [{ text: 'hi' }] }]);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-3-flash' }),
    );
    expect(lastPostedBody(post)).toMatchObject({ request: { model: 'models/gemini-3-flash' } });
  });

  it('reports a missing totalTokens as an upstream failure instead of counting zero', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: {} } as never);
    const { service } = createService();

    await expect(
      service.countGeminiTokens('gemini-3-flash', [{ role: 'user', parts: [{ text: 'hi' }] }]),
    ).rejects.toMatchObject({
      status: 502,
      message: 'Upstream countTokens response did not include a usable totalTokens value',
    });
  });

  it('fails closed on an unknown model and records the route miss', async () => {
    mockAccountLeaseService.getNextToken.mockResolvedValue(null);
    mockAccountLeaseService.getModelCatalogStatus.mockReturnValue('unknown_model');
    const post = vi.spyOn(axios, 'post');
    const { service, missJournal } = createService();

    const error = await service
      .countGeminiTokens('not-a-model', [{ role: 'user', parts: [{ text: 'hi' }] }])
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ModelRouteError);
    expect(error).toMatchObject({ status: 404, code: 'model_not_found' });
    expect(post).not.toHaveBeenCalled();
    expect(missJournal.getSnapshot()).toEqual([
      expect.objectContaining({ model: 'not-a-model', count: 1 }),
    ]);
  });

  it('maps Anthropic messages through the shared request mapper and answers input_tokens', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { totalTokens: 128 } } as never);
    const { service } = createService();

    const result = await service.countAnthropicTokens({
      model: 'gemini-3-flash',
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'How many tokens is this?' }],
    });

    expect(result).toEqual({ input_tokens: 128 });
    expect(post.mock.calls[0]?.[0]).toBe(COUNT_TOKENS_URL);
    const body = lastPostedBody(post) as {
      request: { model: string; contents: unknown };
    };
    expect(Object.keys(body)).toEqual(['request']);
    expect(Object.keys(body.request).sort()).toEqual(['contents', 'model']);
    expect(body.request.model).toBe('models/gemini-3-flash');
    expect(body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'How many tokens is this?' }] },
    ]);
  });

  it('fails closed on an unknown Anthropic model', async () => {
    mockAccountLeaseService.getNextToken.mockResolvedValue(null);
    mockAccountLeaseService.getModelCatalogStatus.mockReturnValue('unknown_model');
    const { service } = createService();

    await expect(
      service.countAnthropicTokens({
        model: 'not-a-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ status: 404, code: 'model_not_found' });
  });

  it('surfaces an upstream error rather than a fabricated count', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(
      new axios.AxiosError('boom', 'ERR_BAD_REQUEST', undefined, undefined, {
        config: {} as never,
        data: { error: { code: 400, message: 'contents is required', status: 'INVALID_ARGUMENT' } },
        headers: {},
        status: 400,
        statusText: 'Bad Request',
      }),
    );
    const { service } = createService();

    const error = await service
      .countGeminiTokens('gemini-3-flash', [{ role: 'user', parts: [{ text: 'hi' }] }])
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UpstreamRequestError);
    expect(error).toMatchObject({ status: 400, message: 'contents is required' });
  });
});

describe('resolveCountTokensContents', () => {
  it.each([
    [
      { contents: [{ role: 'user', parts: [{ text: 'a' }] }] },
      [{ role: 'user', parts: [{ text: 'a' }] }],
    ],
    [
      { generateContentRequest: { contents: [{ role: 'user', parts: [{ text: 'b' }] }] } },
      [{ role: 'user', parts: [{ text: 'b' }] }],
    ],
    [{}, null],
    [{ contents: 'not-an-array' }, null],
    [undefined, null],
  ])('reads %j as %j', (body, expected) => {
    expect(resolveCountTokensContents(body)).toEqual(expected);
  });
});
