import { isEmpty, isString } from 'lodash-es';
import { logger } from '@/shared/logging/logger';
import { PUBLIC_SUPPORTED_MODELS } from './model-display-presets';

export { getPublicModelIdForDisplayName } from './model-display-presets';

export const MODEL_LIST_CREATED_AT = 1770652800;

export const MODEL_LIST_OWNER = 'antigravity';

function collectDynamicModelIds(dynamicModelIds?: Iterable<string>): Set<string> {
  const modelIds = new Set<string>();
  if (!dynamicModelIds) {
    return modelIds;
  }

  for (const dynamicModelId of dynamicModelIds) {
    const normalizedModelId = normalizeCatalogModelId(dynamicModelId);
    if (normalizedModelId) {
      modelIds.add(normalizedModelId);
    }
  }

  return modelIds;
}

function normalizeCatalogModelId(modelId: unknown): string | undefined {
  if (!isString(modelId)) {
    return undefined;
  }

  const normalized = modelId.trim().replace(/^models\//i, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

export function getSupportedModels(): string[] {
  return [...PUBLIC_SUPPORTED_MODELS];
}

export function getAllDynamicModels(
  customMapping: Record<string, string> = {},
  dynamicModelIds?: Iterable<string>,
): string[] {
  const modelIds = collectDynamicModelIds(dynamicModelIds);

  for (const [customModelId, targetModelId] of Object.entries(customMapping)) {
    if (!isString(targetModelId) || isEmpty(targetModelId.trim())) {
      continue;
    }
    const normalizedModelId = normalizeCatalogModelId(customModelId);
    if (normalizedModelId) {
      modelIds.add(normalizedModelId);
    }
  }

  return [...modelIds].sort();
}

export function getOpenAICompatibleModels(
  customMapping: Record<string, string> = {},
  dynamicModelIds?: Iterable<string>,
): string[] {
  return getAllDynamicModels(customMapping, dynamicModelIds);
}

export function mapClaudeModelToGemini(input: string): string {
  if (!isString(input) || isEmpty(input)) {
    return '';
  }
  return input.trim().replace(/^models\//i, '');
}

/**
 * Core model routing engine. Provider/model-family substitutions are never
 * implicit: only an exact user-configured mapping may change model identity.
 */
export function resolveModelRoute(
  originalModel: string,
  customMapping: Record<string, string>,
): string {
  const exactEntry = Object.entries(customMapping).find(
    ([alias]) => alias.trim().toLowerCase() === originalModel.trim().toLowerCase(),
  );
  if (exactEntry?.[1]?.trim()) {
    logger.info(`[Router] Using custom exact mapping: ${originalModel} -> ${exactEntry[1]}`);
    return exactEntry[1].trim();
  }
  return originalModel;
}
