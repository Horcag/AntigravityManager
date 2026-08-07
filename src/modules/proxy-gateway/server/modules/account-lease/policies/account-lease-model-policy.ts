import { isNumber } from 'lodash-es';
import { getPublicModelIdForDisplayName } from '../../../../antigravity/ModelMapping';
import {
  type AccountLeaseTokenData,
  normalizeModelId,
} from '../interfaces/account-lease-token-types';

interface AccountLeaseModelLogger {
  log(message: string): void;
}

interface AccountLeaseModelPolicyOptions {
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  logger: AccountLeaseModelLogger;
}

export type AccountModelAvailability = 'unknown' | 'available' | 'unavailable';

/**
 * Resolves only account-scoped provider facts. It deliberately does not infer
 * compatibility from model families, versions, tiers, or similar names.
 */
export class AccountLeaseModelPolicy {
  constructor(private readonly options: AccountLeaseModelPolicyOptions) {}

  getAllCollectedModels(): Set<string> {
    const allModels = new Set<string>();
    for (const tokenData of this.options.getTokenCache().values()) {
      const describedModels = new Set<string>();
      for (const [modelId, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
        const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
        if (!normalizedModelId) {
          continue;
        }
        describedModels.add(normalizedModelId);
        allModels.add(getPublicModelIdForDisplayName(modelInfo.display_name) ?? normalizedModelId);
      }

      for (const modelId of Object.keys(tokenData.model_quotas ?? {})) {
        const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
        if (normalizedModelId && !describedModels.has(normalizedModelId)) {
          allModels.add(normalizedModelId);
        }
      }
    }
    return allModels;
  }

  getAvailableModelsFromToken(tokenData: AccountLeaseTokenData): Set<string> {
    const availableModels = new Set<string>();

    for (const modelId of Object.keys(tokenData.model_quotas ?? {})) {
      const normalized = normalizeModelId(modelId)?.toLowerCase();
      if (normalized) {
        availableModels.add(normalized);
      }
    }

    for (const modelId of Object.keys(tokenData.quota?.models ?? {})) {
      const normalized = normalizeModelId(modelId)?.toLowerCase();
      if (normalized) {
        availableModels.add(normalized);
      }
    }

    return availableModels;
  }

  resolveDynamicModelForAccount(accountId: string, mappedModel: string): string {
    const tokenData = this.options.getTokenCache().get(accountId);
    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase();
    if (!tokenData || !normalizedMappedModel) {
      return mappedModel;
    }

    const availableModels = this.getAvailableModelsFromToken(tokenData);
    if (availableModels.size === 0) {
      return mappedModel;
    }

    const resolvedModel = this.resolveAvailableModel(
      tokenData,
      normalizedMappedModel,
      availableModels,
    );
    if (!resolvedModel) {
      return mappedModel;
    }

    if (resolvedModel !== normalizedMappedModel) {
      this.options.logger.log(
        `[Provider-Model-Rewrite] account=${accountId} ${mappedModel} -> ${resolvedModel}`,
      );
    }
    return resolvedModel;
  }

  getModelAvailabilityForAccount(accountId: string, mappedModel: string): AccountModelAvailability {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return 'unknown';
    }

    const availableModels = this.getAvailableModelsFromToken(tokenData);
    if (availableModels.size === 0) {
      return 'unknown';
    }

    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase();
    if (!normalizedMappedModel) {
      return 'unavailable';
    }

    return this.resolveAvailableModel(tokenData, normalizedMappedModel, availableModels)
      ? 'available'
      : 'unavailable';
  }

  getExactModelAvailabilityForAccount(
    accountId: string,
    mappedModel: string,
  ): AccountModelAvailability {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return 'unknown';
    }

    const availableModels = this.getAvailableModelsFromToken(tokenData);
    if (availableModels.size === 0) {
      return 'unknown';
    }

    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase();
    if (!normalizedMappedModel) {
      return 'unavailable';
    }

    return availableModels.has(normalizedMappedModel) ? 'available' : 'unavailable';
  }

  private resolveAvailableModel(
    tokenData: AccountLeaseTokenData,
    normalizedMappedModel: string,
    availableModels: Set<string>,
  ): string | null {
    const forwardedModel = this.resolveForwardedModelForAccount(
      tokenData,
      normalizedMappedModel,
      availableModels,
    );
    if (forwardedModel) {
      return forwardedModel;
    }

    const displayPresetModel = this.resolveDisplayPresetForAccount(
      tokenData,
      normalizedMappedModel,
      availableModels,
    );
    if (displayPresetModel) {
      return displayPresetModel;
    }

    return availableModels.has(normalizedMappedModel) ? normalizedMappedModel : null;
  }

  private resolveDisplayPresetForAccount(
    tokenData: AccountLeaseTokenData,
    normalizedMappedModel: string,
    availableModels: Set<string>,
  ): string | null {
    for (const [modelId, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
      if (getPublicModelIdForDisplayName(modelInfo.display_name) !== normalizedMappedModel) {
        continue;
      }
      const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
      if (normalizedModelId && availableModels.has(normalizedModelId)) {
        return normalizedModelId;
      }
    }
    return null;
  }

  private resolveForwardedModelForAccount(
    tokenData: AccountLeaseTokenData,
    normalizedMappedModel: string,
    availableModels: Set<string>,
  ): string | null {
    for (const [oldModel, newModel] of Object.entries(tokenData.model_forwarding_rules ?? {})) {
      const normalizedOld = normalizeModelId(oldModel)?.toLowerCase();
      const normalizedNew = normalizeModelId(newModel)?.toLowerCase();
      if (
        normalizedOld === normalizedMappedModel &&
        normalizedNew &&
        availableModels.has(normalizedNew)
      ) {
        return normalizedNew;
      }
    }
    return null;
  }

  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.options.getTokenCache().get(accountId);
    const normalizedModel = normalizeModelId(modelName)?.toLowerCase();
    if (!tokenData || !normalizedModel) {
      return undefined;
    }

    const entry = Object.entries(tokenData.model_limits ?? {}).find(
      ([candidate]) => normalizeModelId(candidate)?.toLowerCase() === normalizedModel,
    );
    return entry?.[1];
  }

  getModelQuotaPercentageForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.options.getTokenCache().get(accountId);
    const normalizedModel = normalizeModelId(modelName)?.toLowerCase();
    if (!tokenData || !normalizedModel) {
      return undefined;
    }

    const entry = Object.entries(tokenData.model_quotas ?? {}).find(
      ([candidate]) => normalizeModelId(candidate)?.toLowerCase() === normalizedModel,
    );
    return entry?.[1];
  }

  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.options.getTokenCache().get(accountId);
    const normalizedModel = normalizeModelId(modelName)?.toLowerCase();
    if (!tokenData || !normalizedModel) {
      return undefined;
    }

    for (const [quotaModelName, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
      if (normalizeModelId(quotaModelName)?.toLowerCase() !== normalizedModel) {
        continue;
      }
      const budget = modelInfo?.thinking_budget;
      if (isNumber(budget) && Number.isFinite(budget) && budget >= 0) {
        return Math.floor(budget);
      }
    }
    return undefined;
  }
}
