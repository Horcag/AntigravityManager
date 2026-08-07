import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '../interfaces/account-lease-adapters';
import {
  buildAccountLeaseQuotaSnapshot,
  findEarliestQuotaResetTime,
  type AccountLeaseQuotaSnapshot,
} from './account-lease-quota-policy';
import {
  type AccountLeaseTokenData,
  normalizeModelId,
} from '../interfaces/account-lease-token-types';
import { RateLimitReason } from '../../shared/services/rate-limit-tracker.service';

interface AccountLeaseQuotaRefreshLogger {
  warn(message: string, error?: unknown): void;
}

interface AccountLeaseQuotaRefreshPolicyOptions {
  accountStore: AccountLeaseAccountStore;
  upstream: AccountLeaseUpstream;
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  setLockoutUntilIso: (
    accountId: string,
    resetTime: string,
    reason: RateLimitReason,
    model?: string,
  ) => boolean;
  clearRecoveredQuotaLocks: (
    accountId: string,
    recoveredModels: readonly string[],
    isAccountRecovered: boolean,
  ) => void;
  logger: AccountLeaseQuotaRefreshLogger;
}

interface ModelQuotaState {
  percentage: number;
  resetTimes: string[];
}

export type AccountLeaseQuotaRefreshOutcome = 'locked' | 'recovered' | 'unavailable';

function normalizeQuotaModelId(model: string): string {
  return (normalizeModelId(model) ?? model).toLowerCase();
}

function buildModelQuotaStates(snapshot: AccountLeaseQuotaSnapshot): Map<string, ModelQuotaState> {
  const states = new Map<string, ModelQuotaState>();

  for (const [model, percentage] of Object.entries(snapshot.modelQuotas)) {
    const normalizedModel = normalizeQuotaModelId(model);
    const current = states.get(normalizedModel);
    states.set(normalizedModel, {
      percentage: current ? Math.min(current.percentage, percentage) : percentage,
      resetTimes: current?.resetTimes ?? [],
    });
  }

  for (const [model, resetTime] of Object.entries(snapshot.modelResetTimes)) {
    if (resetTime.trim() === '') {
      continue;
    }

    const normalizedModel = normalizeQuotaModelId(model);
    const state = states.get(normalizedModel);
    if (state) {
      state.resetTimes.push(resetTime);
      continue;
    }

    // Older cached snapshots may have reset metadata without percentages.
    // Preserve their fail-closed lock behavior until a complete live snapshot replaces them.
    states.set(normalizedModel, {
      percentage: 0,
      resetTimes: [resetTime],
    });
  }

  return states;
}

function resolveQuotaModel(
  model: string,
  snapshot: AccountLeaseQuotaSnapshot,
  modelStates: ReadonlyMap<string, ModelQuotaState>,
): string {
  let candidate = normalizeQuotaModelId(model);
  const visited = new Set<string>();

  while (!visited.has(candidate)) {
    visited.add(candidate);
    if (modelStates.has(candidate)) {
      return candidate;
    }

    const forwardedEntry = Object.entries(snapshot.modelForwardingRules).find(
      ([oldModel]) => oldModel.toLowerCase() === candidate.toLowerCase(),
    );
    if (!forwardedEntry) {
      return candidate;
    }
    candidate = normalizeQuotaModelId(forwardedEntry[1]);
  }

  return candidate;
}

function findEarliestModelResetTime(state: ModelQuotaState): string | null {
  if (state.resetTimes.length === 0) {
    return null;
  }
  return [...state.resetTimes].sort()[0];
}

export class AccountLeaseQuotaRefreshPolicy {
  constructor(private readonly options: AccountLeaseQuotaRefreshPolicyOptions) {}

  setPreciseLockoutFromCachedQuota(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): boolean {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return false;
    }

    let resetTime: string | null;
    if (model) {
      const snapshot: AccountLeaseQuotaSnapshot = {
        modelQuotas: tokenData.model_quotas,
        modelLimits: tokenData.model_limits,
        modelResetTimes: tokenData.model_reset_times,
        modelForwardingRules: tokenData.model_forwarding_rules,
      };
      const modelStates = buildModelQuotaStates(snapshot);
      const modelState = modelStates.get(resolveQuotaModel(model, snapshot, modelStates));
      if (!modelState || modelState.percentage > 0) {
        return false;
      }
      resetTime = findEarliestModelResetTime(modelState);
    } else {
      resetTime = findEarliestQuotaResetTime(tokenData.model_reset_times);
    }

    if (!resetTime) {
      return false;
    }

    return this.options.setLockoutUntilIso(accountId, resetTime, reason, model);
  }

  async refreshRealtimeQuotaAndReconcileLimit(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): Promise<AccountLeaseQuotaRefreshOutcome> {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return 'unavailable';
    }

    try {
      const latestQuota = await this.options.upstream.fetchQuota(
        tokenData.access_token,
        tokenData.upstream_proxy_url,
      );
      const extractedState = buildAccountLeaseQuotaSnapshot(latestQuota);

      await this.options.accountStore.updateQuota(accountId, latestQuota);

      const updatedTokenData: AccountLeaseTokenData = {
        ...tokenData,
        quota: latestQuota,
        model_quotas: extractedState.modelQuotas,
        model_limits: extractedState.modelLimits,
        model_reset_times: extractedState.modelResetTimes,
        model_forwarding_rules: extractedState.modelForwardingRules,
      };
      this.options.getTokenCache().set(accountId, updatedTokenData);

      const modelStates = buildModelQuotaStates(extractedState);
      const recoveredModels = new Set(
        Array.from(modelStates.entries())
          .filter(([, state]) => state.percentage > 0)
          .map(([modelId]) => modelId),
      );
      for (const oldModel of Object.keys(extractedState.modelForwardingRules)) {
        const forwardedModel = resolveQuotaModel(oldModel, extractedState, modelStates);
        if ((modelStates.get(forwardedModel)?.percentage ?? 0) > 0) {
          recoveredModels.add(normalizeQuotaModelId(oldModel));
        }
      }

      const normalizedModel = normalizeModelId(model);
      const requestedModel = normalizedModel
        ? resolveQuotaModel(normalizedModel, extractedState, modelStates)
        : undefined;
      const requestedState = requestedModel ? modelStates.get(requestedModel) : undefined;
      if (normalizedModel && requestedState && requestedState.percentage > 0) {
        recoveredModels.add(normalizedModel.toLowerCase());
      }

      const isAccountRecovered =
        modelStates.size > 0 &&
        Array.from(modelStates.values()).every((state) => state.percentage > 0);
      if (recoveredModels.size > 0 || isAccountRecovered) {
        this.options.clearRecoveredQuotaLocks(
          accountId,
          Array.from(recoveredModels),
          isAccountRecovered,
        );
      }

      if (requestedState) {
        if (requestedState.percentage > 0) {
          return 'recovered';
        }

        const resetTime = findEarliestModelResetTime(requestedState);
        if (!resetTime) {
          return 'unavailable';
        }
        return this.options.setLockoutUntilIso(accountId, resetTime, reason, normalizedModel)
          ? 'locked'
          : 'unavailable';
      }

      if (normalizedModel) {
        return 'unavailable';
      }

      if (isAccountRecovered) {
        return 'recovered';
      }

      const resetTime = findEarliestQuotaResetTime(extractedState.modelResetTimes);
      if (!resetTime) {
        return 'unavailable';
      }
      return this.options.setLockoutUntilIso(accountId, resetTime, reason)
        ? 'locked'
        : 'unavailable';
    } catch (error) {
      this.options.logger.warn(`Failed to refresh realtime quota for account ${accountId}`, error);
      return 'unavailable';
    }
  }
}
