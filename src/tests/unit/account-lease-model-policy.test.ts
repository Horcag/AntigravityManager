import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseModelPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-model-policy';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';

function createToken(overrides: Partial<AccountLeaseTokenData> = {}): AccountLeaseTokenData {
  return {
    account_id: 'acc-1',
    email: 'lease@example.com',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    ...overrides,
  };
}

function createPolicy(tokenCache: Map<string, AccountLeaseTokenData>) {
  const logger = { log: vi.fn() };
  return {
    logger,
    policy: new AccountLeaseModelPolicy({
      getTokenCache: () => tokenCache,
      logger,
    }),
  };
}

describe('AccountLeaseModelPolicy', () => {
  it('distinguishes exact availability without inferring family compatibility', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: { 'gemini-3.1-pro-low': 80 },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getExactModelAvailabilityForAccount('acc-1', 'gemini-3.1-pro-low')).toBe(
      'available',
    );
    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-3-pro')).toBe('unavailable');
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro')).toBe('gemini-3-pro');
  });

  it('does not substitute image model versions', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.1-pro-image': 80,
            'gemini-3.1-flash-image': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro-image')).toBe(
      'gemini-3-pro-image',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-flash-image')).toBe(
      'gemini-3-flash-image',
    );
  });

  it('uses a forwarding rule only from the selected account', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: { 'gemini-3.5-flash-extra-low': 80 },
          model_forwarding_rules: {
            'gemini-3.5-flash-high': 'gemini-3.5-flash-extra-low',
          },
        }),
      ],
      [
        'acc-2',
        createToken({
          account_id: 'acc-2',
          model_quotas: { 'gemini-3.5-flash-extra-low': 80 },
        }),
      ],
    ]);
    const { logger, policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.5-flash-high')).toBe(
      'gemini-3.5-flash-extra-low',
    );
    expect(policy.resolveDynamicModelForAccount('acc-2', 'gemini-3.5-flash-high')).toBe(
      'gemini-3.5-flash-high',
    );
    expect(logger.log).toHaveBeenCalledWith(
      '[Provider-Model-Rewrite] account=acc-1 gemini-3.5-flash-high -> gemini-3.5-flash-extra-low',
    );
  });

  it('ignores forwarding targets the selected account does not advertise', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: { 'gemini-3.5-flash-high': 80 },
          model_forwarding_rules: {
            'gemini-3.5-flash-high': 'gemini-future-unavailable',
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.5-flash-high')).toBe(
      'gemini-3.5-flash-high',
    );
  });

  it('routes provider-advertised display presets to their physical upstream IDs', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3-flash-agent': 80,
            'claude-sonnet-4-6': 80,
          },
          quota: {
            models: {
              'gemini-3-flash-agent': {
                percentage: 80,
                resetTime: '',
                display_name: 'Gemini 3.5 Flash (High)',
              },
              'claude-sonnet-4-6': {
                percentage: 80,
                resetTime: '',
                display_name: 'Claude Sonnet 4.6 (Thinking)',
              },
            },
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.5-flash-high')).toBe(
      'gemini-3-flash-agent',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'claude-sonnet-4-6-thinking')).toBe(
      'claude-sonnet-4-6',
    );
    expect(policy.getAllCollectedModels()).toEqual(
      new Set(['gemini-3.5-flash-high', 'claude-sonnet-4-6-thinking']),
    );
  });

  it('reports unknown when an account has no capability metadata', () => {
    const tokenCache = new Map([['acc-1', createToken()]]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-3-flash')).toBe('unknown');
    expect(policy.getModelAvailabilityForAccount('missing', 'gemini-3-flash')).toBe('unknown');
  });

  it('reads output limits and thinking budgets from account quota state', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_limits: { 'MODELS/GEMINI-3-PRO': 8192 },
          quota: {
            models: {
              'MODELS/GEMINI-3-PRO': {
                percentage: 100,
                resetTime: '2026-06-20T00:00:00.000Z',
                thinking_budget: 32768.8,
              },
            },
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getModelOutputLimitForAccount('acc-1', 'models/gemini-3-pro')).toBe(8192);
    expect(policy.getModelThinkingBudgetForAccount('acc-1', 'gemini-3-pro')).toBe(32768);
  });
});
