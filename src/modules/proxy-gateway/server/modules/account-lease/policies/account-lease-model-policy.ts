import { isNumber } from 'lodash-es';
import type { CloudModelRoleId } from '@/modules/cloud-account/types';
import {
  COMPLETION_MODEL_FLAGS,
  type CatalogModelRoleIndex,
  type CompletionModelFlag,
  getPublicModelIdForDisplayName,
  resolveCompletionModelFlags,
} from '../../../../antigravity/ModelMapping';
import {
  type AccountLeaseTokenData,
  normalizeModelId,
} from '../interfaces/account-lease-token-types';

/**
 * `agent` is the provider's chat surface; every other role in
 * `FetchAvailableModelsResponse` drives a non-chat IDE function.
 */
const CHAT_MODEL_ROLE: CloudModelRoleId = 'agent';

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
      const catalogIdByProviderId = this.buildCatalogIdIndex(tokenData);
      for (const catalogId of catalogIdByProviderId.values()) {
        allModels.add(catalogId);
      }

      for (const modelId of Object.keys(tokenData.model_quotas ?? {})) {
        const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
        if (normalizedModelId && !catalogIdByProviderId.has(normalizedModelId)) {
          allModels.add(normalizedModelId);
        }
      }
    }
    return allModels;
  }

  /**
   * Projects the provider's own statements about each advertised id onto the
   * catalog ids that {@link getAllCollectedModels} publishes, so the catalog
   * filter can decide with provider facts instead of an id table.
   *
   * 1. Provider ids arrive raw, catalog ids may have been rewritten to a public
   *    preset id, so every id is translated the same way.
   * 2. Facts are unioned across accounts: a model any account offers for chat
   *    stays publishable even if another account only lists it for a tool role,
   *    and an editor-family marker any account reports counts for the id.
   * 3. `hasChatRoleData` stays false when no account reported an `agent` role,
   *    which is the signal that non-chat membership alone cannot be trusted.
   */
  getCatalogModelRoleIndex(): CatalogModelRoleIndex {
    const nonChatRoles = new Map<string, string[]>();
    const chatModelIds = new Set<string>();
    const completionFlags = new Map<string, CompletionModelFlag[]>();
    let hasChatRoleData = false;

    for (const tokenData of this.options.getTokenCache().values()) {
      const catalogIdByProviderId = this.buildCatalogIdIndex(tokenData);

      for (const [modelId, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
        const flags = resolveCompletionModelFlags(modelInfo);
        if (flags.length === 0) {
          continue;
        }

        const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
        if (!normalizedModelId) {
          continue;
        }

        const catalogId = catalogIdByProviderId.get(normalizedModelId) ?? normalizedModelId;
        const knownFlags = completionFlags.get(catalogId);
        if (!knownFlags) {
          completionFlags.set(catalogId, flags);
          continue;
        }
        completionFlags.set(
          catalogId,
          COMPLETION_MODEL_FLAGS.filter(
            (flag) => knownFlags.includes(flag) || flags.includes(flag),
          ),
        );
      }

      const modelRoles = tokenData.quota?.model_roles;
      if (!modelRoles) {
        continue;
      }

      for (const [role, modelIds] of Object.entries(modelRoles) as [
        CloudModelRoleId,
        string[] | undefined,
      ][]) {
        if (!Array.isArray(modelIds) || modelIds.length === 0) {
          continue;
        }

        if (role === CHAT_MODEL_ROLE) {
          hasChatRoleData = true;
        }

        for (const modelId of modelIds) {
          const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
          if (!normalizedModelId) {
            continue;
          }

          const catalogId = catalogIdByProviderId.get(normalizedModelId) ?? normalizedModelId;
          if (role === CHAT_MODEL_ROLE) {
            chatModelIds.add(catalogId);
            continue;
          }

          const roles = nonChatRoles.get(catalogId);
          if (!roles) {
            nonChatRoles.set(catalogId, [role]);
            continue;
          }
          if (!roles.includes(role)) {
            roles.push(role);
            roles.sort();
          }
        }
      }
    }

    return { nonChatRoles, chatModelIds, hasChatRoleData, completionFlags };
  }

  /** Maps a token's raw provider model ids to the ids the catalog publishes. */
  private buildCatalogIdIndex(tokenData: AccountLeaseTokenData): Map<string, string> {
    const catalogIdByProviderId = new Map<string, string>();
    for (const [modelId, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
      const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
      if (!normalizedModelId) {
        continue;
      }
      catalogIdByProviderId.set(
        normalizedModelId,
        getPublicModelIdForDisplayName(modelInfo.display_name) ?? normalizedModelId,
      );
    }
    return catalogIdByProviderId;
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
