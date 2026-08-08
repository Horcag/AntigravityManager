import axios, { AxiosError } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';

const PRIMARY_BASE_URL = 'https://primary.example/v1internal';
const SECONDARY_BASE_URL = 'https://secondary.example/v1internal';

function createUpstreamError(status: number): AxiosError {
  return new AxiosError('upstream rejected', 'ERR_BAD_RESPONSE', undefined, undefined, {
    config: {} as never,
    data: { error: { message: 'upstream rejected' } },
    headers: {},
    status,
    statusText: 'Error',
  });
}

describe('GeminiClient endpoint failover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([408, 429, 499, 500, 503])('fails over to the next endpoint on %i', async (status) => {
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `${PRIMARY_BASE_URL},${SECONDARY_BASE_URL}`);
    const post = vi.spyOn(axios, 'post');
    post
      .mockRejectedValueOnce(createUpstreamError(status))
      .mockResolvedValueOnce({ data: { totalTokens: 7 } } as never);

    const client = new GeminiClient();
    const response = await client.countTokensInternal(
      { request: { model: 'gemini-3-flash', contents: [] } },
      'access-token',
    );

    expect(response).toEqual({ totalTokens: 7 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toBe(`${PRIMARY_BASE_URL}:countTokens`);
    expect(post.mock.calls[1]?.[0]).toBe(`${SECONDARY_BASE_URL}:countTokens`);
  });

  it.each([400, 401, 403, 404])(
    'fails fast on %i without trying the next endpoint',
    async (status) => {
      vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `${PRIMARY_BASE_URL},${SECONDARY_BASE_URL}`);
      const post = vi.spyOn(axios, 'post');
      post.mockRejectedValue(createUpstreamError(status));

      const client = new GeminiClient();
      await expect(
        client.countTokensInternal(
          { request: { model: 'gemini-3-flash', contents: [] } },
          'access-token',
        ),
      ).rejects.toMatchObject({ status });
      expect(post).toHaveBeenCalledTimes(1);
    },
  );
});
