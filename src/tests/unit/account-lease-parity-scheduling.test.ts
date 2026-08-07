import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG, ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '../../server/server-config';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '../../modules/proxy-gateway/server/modules/shared/services/rate-limit-tracker.service';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { ModelAvailabilityService } from '../../modules/proxy-gateway/server/modules/shared/services/model-availability.service';

function createProxyConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    ...overrides,
    upstream_proxy: {
      ...DEFAULT_APP_CONFIG.proxy.upstream_proxy,
      ...(overrides.upstream_proxy ?? {}),
    },
  };
}

function seedTokens(service: AccountLeaseService): void {
  const nowSec = Math.floor(Date.now() / 1000);
  (service as any).tokens = new Map([
    [
      'acc-1',
      {
        account_id: 'acc-1',
        email: 'acc-1@test.dev',
        access_token: 'token-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: nowSec + 3600,
        project_id: 'project-1',
        session_id: 'session-1',
        model_quotas: {
          'gemini-2.5-flash': 100,
          'gemini-2.5-pro': 100,
        },
        model_limits: {},
        model_reset_times: {},
        model_forwarding_rules: {},
      },
    ],
    [
      'acc-2',
      {
        account_id: 'acc-2',
        email: 'acc-2@test.dev',
        access_token: 'token-2',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: nowSec + 3600,
        project_id: 'project-2',
        session_id: 'session-2',
        model_quotas: {
          'gemini-2.5-flash': 100,
          'gemini-2.5-pro': 100,
        },
        model_limits: {},
        model_reset_times: {},
        model_forwarding_rules: {},
      },
    ],
  ]);
}

describe('AccountLeaseService parity scheduling replay', () => {
  let service: AccountLeaseService;

  beforeEach(() => {
    service = new AccountLeaseService(new RateLimitTrackerService());
    seedTokens(service);
  });

  it('does not infer a compatible Gemini Pro version from a similar advertised id', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-1',
          session_id: 'session-1',
          model_quotas: {
            'gemini-3.1-pro-low': 80,
          },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);

    const resolved = service.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro');
    expect(resolved).toBe('gemini-3-pro');
  });

  it('keeps original model when dynamic rewrite is not applicable', () => {
    const resolved = service.resolveDynamicModelForAccount('acc-1', 'gemini-3-flash');
    expect(resolved).toBe('gemini-3-flash');
  });

  it('selects an account that advertises the requested dynamic model', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-1',
          model_quotas: { 'gemini-3-flash': 80 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
      [
        'acc-2',
        {
          account_id: 'acc-2',
          email: 'acc-2@test.dev',
          access_token: 'token-2',
          refresh_token: 'refresh-2',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-2',
          model_quotas: { 'gpt-oss-120b-medium': 80 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);

    const selected = await service.getNextToken({ model: 'gpt-oss-120b-medium' });

    expect(selected?.id).toBe('acc-2');
  });

  it('uses a provider-backed route when an exact-id account is rate limited', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-exact',
        {
          account_id: 'acc-exact',
          email: 'exact@test.dev',
          access_token: 'token-exact',
          refresh_token: 'refresh-exact',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-exact',
          model_quotas: { 'gemini-3.5-flash-high': 80 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
      [
        'acc-provider',
        {
          account_id: 'acc-provider',
          email: 'provider@test.dev',
          access_token: 'token-provider',
          refresh_token: 'refresh-provider',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-provider',
          model_quotas: { 'gemini-3-flash-agent': 80 },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
          quota: {
            models: {
              'gemini-3-flash-agent': {
                percentage: 80,
                resetTime: '',
                display_name: 'Gemini 3.5 Flash (High)',
              },
            },
          },
        },
      ],
    ]);
    service
      .getRateLimitTracker()
      .setLockoutUntilIso(
        'acc-exact',
        new Date(Date.now() + 60_000).toISOString(),
        RateLimitReason.RateLimitExceeded,
        'gemini-3.5-flash-high',
      );

    const selected = await service.getNextToken({ model: 'gemini-3.5-flash-high' });

    expect(selected?.id).toBe('acc-provider');
    expect(service.resolveDynamicModelForAccount('acc-provider', 'gemini-3.5-flash-high')).toBe(
      'gemini-3-flash-agent',
    );
  });

  it('skips an account with an active model-specific failure', async () => {
    const availability = new ModelAvailabilityService();
    const isolatedService = new AccountLeaseService(
      new RateLimitTrackerService(),
      undefined,
      undefined,
      availability,
    );
    seedTokens(isolatedService);
    availability.mark('acc-1', 'gemini-2.5-flash', 'rate_limited', Date.now() + 60_000);

    const selected = await isolatedService.getNextToken({ model: 'gemini-2.5-flash' });

    expect(selected?.id).toBe('acc-2');
  });

  it('skips an account whose provider quota is already zero', async () => {
    (service as any).tokens.get('acc-1').model_quotas['gemini-2.5-flash'] = 0;

    const selected = await service.getNextToken({ model: 'gemini-2.5-flash' });

    expect(selected?.id).toBe('acc-2');
    expect(service.getModelCatalogStatus('gemini-2.5-flash')).toBe('known');
    expect(service.getModelRouteAvailability('gemini-2.5-flash')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: 'acc-1', status: 'unavailable' }),
        expect.objectContaining({ accountId: 'acc-2', status: 'available' }),
      ]),
    );
  });

  it('passes oauth_client_key when refreshing token and persists refreshed key', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = {
      account_id: 'acc-1',
      email: 'acc-1@test.dev',
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      oauth_client_key: 'custom-client',
      upstream_proxy_url: 'http://127.0.0.1:8080',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec - 1,
      project_id: 'project-1',
      session_id: 'session-1',
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };

    (service as any).tokens = new Map([['acc-1', tokenData]]);

    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'token-new',
      refresh_token: 'refresh-new',
      id_token: 'id-new',
      expires_in: 7200,
      token_type: 'Bearer',
      oauth_client_key: 'custom-fallback',
    });
    const persistSpy = vi.spyOn(service as any, 'persistTokenState').mockResolvedValue(undefined);

    const selected = await (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);

    expect(refreshSpy).toHaveBeenCalledWith('refresh-1', 'http://127.0.0.1:8080', 'custom-client');
    expect(persistSpy).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        refresh_token: 'refresh-new',
        id_token: 'id-new',
      }),
    );
    expect(selected?.token.refresh_token).toBe('refresh-new');
    expect(selected?.token.id_token).toBe('id-new');
    expect(selected?.token.oauth_client_key).toBe('custom-fallback');
    expect((service as any).tokens.get('acc-1')?.oauth_client_key).toBe('custom-fallback');

    refreshSpy.mockRestore();
    persistSpy.mockRestore();
  });

  it('refreshes selected token when expiry is inside the request timeout buffer', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = {
      account_id: 'acc-1',
      email: 'acc-1@test.dev',
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec + 100,
      project_id: 'project-1',
      session_id: 'session-1',
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };

    (service as any).tokens = new Map([['acc-1', tokenData]]);

    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'token-new',
      expires_in: 7200,
      token_type: 'Bearer',
    });
    const persistSpy = vi.spyOn(service as any, 'persistTokenState').mockResolvedValue(undefined);

    const selected = await (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);

    expect(refreshSpy).toHaveBeenCalledWith('refresh-1', undefined, undefined);
    expect(selected?.token.access_token).toBe('token-new');

    refreshSpy.mockRestore();
    persistSpy.mockRestore();
  });

  it('coalesces concurrent token refreshes for the same account', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = {
      account_id: 'acc-1',
      email: 'acc-1@test.dev',
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      oauth_client_key: 'custom-client',
      upstream_proxy_url: 'http://127.0.0.1:8080',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec - 1,
      project_id: 'project-1',
      session_id: 'session-1',
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };

    (service as any).tokens = new Map([['acc-1', tokenData]]);

    let resolveRefresh: (() => void) | undefined;
    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => {
            resolve({
              access_token: 'token-new',
              expires_in: 7200,
              token_type: 'Bearer',
              oauth_client_key: 'custom-client',
            });
          };
        }),
    );
    const persistSpy = vi.spyOn(service as any, 'persistTokenState').mockResolvedValue(undefined);

    const first = (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);
    const second = (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);
    await Promise.resolve();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    resolveRefresh?.();

    const selected = await Promise.all([first, second]);
    expect(selected[0]?.token.access_token).toBe('token-new');
    expect(selected[1]?.token.access_token).toBe('token-new');

    refreshSpy.mockRestore();
    persistSpy.mockRestore();
  });

  it('keeps oauth_client_key unset for legacy account refreshed by enterprise client', () => {
    const normalized = (service as any).normalizeRefreshedOauthClientKey(
      {
        oauth_client_key: undefined,
        project_id: undefined,
      },
      'antigravity_enterprise',
    );

    expect(normalized).toBeUndefined();
  });

  it('prioritizes preferred account in parity mode', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: 'acc-2',
      }),
    );

    const token = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(token?.id).toBe('acc-2');
  });

  it('rotates sticky account when limited in balance mode', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: '',
      }),
    );

    const first = await service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    expect(first?.id).toBe('acc-1');

    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'gemini-2.5-flash',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
        },
      }),
    });

    const second = await service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    expect(second?.id).toBe('acc-2');
  });

  it('applies model-level lock for quota exhausted only on the same model', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'performance-first',
      }),
    );

    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'gemini-2.5-flash',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '30s' } }],
        },
      }),
    });

    const sameModel = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(sameModel?.id).toBe('acc-2');

    const otherModel = await service.getNextToken({
      model: 'gemini-2.5-pro',
      excludeAccountIds: ['acc-2'],
    });
    expect(otherModel?.id).toBe('acc-1');
  });

  it('stops when retry exclusions empty the candidate pool', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: false,
        parity_kill_switch: false,
      }),
    );

    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-1',
          session_id: 'session-1',
        },
      ],
    ]);

    const token = await service.getNextToken({ excludeAccountIds: ['acc-1'] });
    expect(token).toBeNull();
  });
});
