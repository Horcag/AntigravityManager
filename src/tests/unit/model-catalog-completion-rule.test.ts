import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';

/**
 * The completion-model rule, exercised end to end: the wire payload
 * `v1internal:fetchAvailableModels` returns -> GoogleAPIService parse ->
 * AccountLeaseModelPolicy index -> the published catalog. No hand-built
 * intermediate, so a field the parse drops fails the test.
 *
 * The fixture reproduces the shapes measured live on 2026-08-08
 * (0.19.17-local1, kanban-40): the two completion ids carry every editor-family
 * marker, the chat models carry none while sitting in tool roles, and
 * `gemini-3.1-flash-image` carries no scalar flag at all.
 */
const MEASURED_DISCOVERY_PAYLOAD = {
  models: {
    chat_20706: {
      quotaInfo: { remainingFraction: 1, resetTime: '2026-08-08T00:00:00Z' },
      isInternal: true,
      supportsCumulativeContext: true,
      supportsEstimateTokenCounter: true,
      requiresLeadInGeneration: true,
      maxTokens: 16384,
    },
    tab_flash_lite_preview: {
      quotaInfo: { remainingFraction: 1, resetTime: '2026-08-08T00:00:00Z' },
      supportsCumulativeContext: true,
      supportsEstimateTokenCounter: true,
      requiresLeadInGeneration: true,
      maxTokens: 16384,
    },
    'gemini-3-flash': {
      quotaInfo: { remainingFraction: 0.8, resetTime: '2026-08-08T00:00:00Z' },
      supportsImages: true,
      supportsThinking: true,
      supportsVideo: true,
      recommended: true,
      maxTokens: 1048576,
    },
    'gemini-3.1-flash-lite': {
      quotaInfo: { remainingFraction: 0.8, resetTime: '2026-08-08T00:00:00Z' },
      maxTokens: 1048576,
      maxOutputTokens: 65535,
    },
    'gemini-3.1-flash-image': {
      quotaInfo: { remainingFraction: 0.8, resetTime: '2026-08-08T00:00:00Z' },
    },
    'gemini-3-pro': {
      quotaInfo: { remainingFraction: 0.8, resetTime: '2026-08-08T00:00:00Z' },
      supportsImages: true,
      supportsThinking: true,
      maxTokens: 1048576,
    },
  },
  agentModelSorts: [{ groups: [{ modelIds: ['gemini-3-pro'] }] }],
  tabModelIds: ['chat_20706'],
  commandModelIds: ['gemini-3-flash'],
  imageGenerationModelIds: ['gemini-3.1-flash-image'],
  mqueryModelIds: ['gemini-3.1-flash-lite'],
  webSearchModelIds: ['gemini-3.1-flash-lite'],
  commitMessageModelIds: ['gemini-3.1-flash-lite'],
};

/** The same ids with `quotaInfo` only, as older provider versions answer. */
const PAYLOAD_WITHOUT_MODEL_DETAILS = {
  models: Object.fromEntries(
    Object.keys(MEASURED_DISCOVERY_PAYLOAD.models).map((modelId) => [
      modelId,
      { quotaInfo: { remainingFraction: 1, resetTime: '2026-08-08T00:00:00Z' } },
    ]),
  ),
};

async function fetchQuotaFromPayload(payload: unknown) {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(payload),
    })
    .mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('INVALID_ARGUMENT'),
    });
  vi.stubGlobal('fetch', fetchMock);

  const { ConfigManager } = await import('@/modules/config/ipc/manager');
  vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue({
    proxy: { upstream_proxy: { enabled: false } },
  } as never);

  const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
  vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({
    projectId: 'project-1',
    subscriptionTier: 'free',
  });

  return GoogleAPIService.fetchQuota('access-token');
}

/** Runs the parsed quota through the policy that feeds the catalog endpoints. */
async function buildCatalog(payload: unknown) {
  const quota = await fetchQuotaFromPayload(payload);

  const { AccountLeaseModelPolicy } =
    await import('@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-model-policy');
  const tokenData = {
    account_id: 'acc-1',
    email: 'lease@example.com',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: 0,
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    quota,
  } as unknown as AccountLeaseTokenData;

  const policy = new AccountLeaseModelPolicy({
    getTokenCache: () => new Map([['acc-1', tokenData]]),
    logger: { log: vi.fn() },
  });

  const { getPublishedCatalogModelIds, getUnpublishedCatalogModelIds } =
    await import('@/modules/proxy-gateway/antigravity/ModelMapping');
  const modelIds = [...policy.getAllCollectedModels()];
  const index = policy.getCatalogModelRoleIndex();

  return {
    index,
    published: getPublishedCatalogModelIds({}, modelIds, index),
    unpublished: getUnpublishedCatalogModelIds(modelIds, index),
  };
}

/**
 * Runs the parsed quota through the cache the proxy actually reads: the model
 * policy never sees `fetchQuota`'s return value, it sees whatever
 * `AccountLeaseTokenCache` copied out of the account store.
 */
async function createLeaseService(quota: CloudQuotaData) {
  const account = {
    id: 'acc-1',
    provider: 'google',
    email: 'lease@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    },
    quota,
    created_at: 1,
    last_used: 1,
  } as CloudAccount;

  const accountStore = {
    getAccounts: vi.fn().mockResolvedValue([account]),
    getAccount: vi.fn().mockResolvedValue(account),
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
  };

  const { AccountLeaseService } =
    await import('@/modules/proxy-gateway/server/modules/account-lease/account-lease.service');
  const { RateLimitTrackerService } =
    await import('@/modules/proxy-gateway/server/modules/shared/services/rate-limit-tracker.service');

  const service = new AccountLeaseService(new RateLimitTrackerService(), accountStore);
  await service.onModuleInit();
  return { service, accountStore };
}

/**
 * The shape a build that predates the `ModelDetails` parse persisted: quota
 * numbers and the role arrays it already knew about, no per-model scalars.
 */
function asPreMarkerSnapshot(quota: CloudQuotaData): CloudQuotaData {
  return {
    ...quota,
    models: Object.fromEntries(
      Object.entries(quota.models).map(([modelId, modelInfo]) => [
        modelId,
        { percentage: modelInfo.percentage, resetTime: modelInfo.resetTime },
      ]),
    ),
  };
}

describe('completion-model catalog rule', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('withholds the editor-family ids and publishes every real model', async () => {
    const { published } = await buildCatalog(MEASURED_DISCOVERY_PAYLOAD);

    expect(published).toEqual([
      'gemini-3-flash',
      'gemini-3-pro',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite',
    ]);
  });

  it('names the markers that matched, with role membership as corroboration', async () => {
    const { unpublished } = await buildCatalog(MEASURED_DISCOVERY_PAYLOAD);

    expect(unpublished).toEqual([
      {
        id: 'chat_20706',
        reason: 'completion_model',
        flags: [
          'requiresLeadInGeneration',
          'supportsCumulativeContext',
          'supportsEstimateTokenCounter',
        ],
        roles: ['tab'],
      },
      {
        id: 'tab_flash_lite_preview',
        reason: 'completion_model',
        flags: [
          'requiresLeadInGeneration',
          'supportsCumulativeContext',
          'supportsEstimateTokenCounter',
        ],
        // The provider puts this one in no role at all; the flags decided.
        roles: [],
      },
    ]);
  });

  it('keeps chat models the provider assigned only to tool roles', async () => {
    const { index, published } = await buildCatalog(MEASURED_DISCOVERY_PAYLOAD);

    expect(index.nonChatRoles.get('gemini-3-flash')).toEqual(['command']);
    expect(index.nonChatRoles.get('gemini-3.1-flash-lite')).toEqual([
      'commit_message',
      'mquery',
      'web_search',
    ]);
    expect(index.chatModelIds.has('gemini-3-flash')).toBe(false);
    expect(published).toContain('gemini-3-flash');
    expect(published).toContain('gemini-3.1-flash-lite');
  });

  it('keeps a model that carries no scalar flag at all', async () => {
    const { index, published } = await buildCatalog(MEASURED_DISCOVERY_PAYLOAD);

    expect(index.completionFlags.has('gemini-3.1-flash-image')).toBe(false);
    expect(published).toContain('gemini-3.1-flash-image');
  });

  it('reaches the rule through the account-lease cache, not only through the parse', async () => {
    const quota = await fetchQuotaFromPayload(MEASURED_DISCOVERY_PAYLOAD);
    const { service } = await createLeaseService(quota);

    try {
      const index = service.getCatalogModelRoleIndex();
      expect(index.completionFlags.get('chat_20706')).toEqual([
        'requiresLeadInGeneration',
        'supportsCumulativeContext',
        'supportsEstimateTokenCounter',
      ]);
    } finally {
      service.onModuleDestroy();
    }
  });

  it('withholds nothing new when the payload carries no ModelDetails scalars', async () => {
    const { index, published, unpublished } = await buildCatalog(PAYLOAD_WITHOUT_MODEL_DETAILS);

    expect(index.completionFlags.size).toBe(0);
    expect(index.hasChatRoleData).toBe(false);
    expect(published).toEqual([
      'chat_20706',
      'gemini-3-flash',
      'gemini-3-pro',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite',
      'tab_flash_lite_preview',
    ]);
    expect(unpublished).toEqual([]);
  });
});

/**
 * kanban-40 r5, the live failure: every parse hop handles the markers, but the
 * proxy reads a cache it fills once, when it starts. The snapshot the previous
 * build persisted carries the role arrays that build already parsed and none of
 * the `ModelDetails` scalars this one added, so the rule saw roles and no flags
 * across five poll cycles while the store was refreshed each time.
 */
describe('completion-model catalog rule over the account-lease cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('finds no markers while the cache holds the snapshot an older build persisted', async () => {
    const quota = await fetchQuotaFromPayload(MEASURED_DISCOVERY_PAYLOAD);
    const { service } = await createLeaseService(asPreMarkerSnapshot(quota));

    try {
      const index = service.getCatalogModelRoleIndex();

      // The symptom, exactly: roles present, flags absent.
      expect(index.nonChatRoles.get('chat_20706')).toEqual(['tab']);
      expect(index.completionFlags.size).toBe(0);
    } finally {
      service.onModuleDestroy();
    }
  });

  it('withholds the completion ids once a refreshed quota is announced', async () => {
    const quota = await fetchQuotaFromPayload(MEASURED_DISCOVERY_PAYLOAD);
    const { service } = await createLeaseService(asPreMarkerSnapshot(quota));
    const { notifyQuotaRefreshed } =
      await import('@/modules/cloud-account/services/quota-refresh-notifier');
    const { getUnpublishedCatalogModelIds } =
      await import('@/modules/proxy-gateway/antigravity/ModelMapping');

    try {
      notifyQuotaRefreshed('acc-1', quota);

      const index = service.getCatalogModelRoleIndex();
      expect(index.completionFlags.get('chat_20706')).toEqual([
        'requiresLeadInGeneration',
        'supportsCumulativeContext',
        'supportsEstimateTokenCounter',
      ]);
      expect(index.nonChatRoles.get('chat_20706')).toEqual(['tab']);
      expect(
        getUnpublishedCatalogModelIds([...service.getAllCollectedModels()], index).map(
          (entry) => `${entry.id}:${entry.reason}`,
        ),
      ).toEqual(['chat_20706:completion_model', 'tab_flash_lite_preview:completion_model']);
    } finally {
      service.onModuleDestroy();
    }
  });

  it('ignores a refresh announced for an account it does not hold', async () => {
    const quota = await fetchQuotaFromPayload(MEASURED_DISCOVERY_PAYLOAD);
    const { service } = await createLeaseService(asPreMarkerSnapshot(quota));
    const { notifyQuotaRefreshed } =
      await import('@/modules/cloud-account/services/quota-refresh-notifier');

    try {
      notifyQuotaRefreshed('acc-unknown', quota);

      expect(service.getCatalogModelRoleIndex().completionFlags.size).toBe(0);
    } finally {
      service.onModuleDestroy();
    }
  });
});
