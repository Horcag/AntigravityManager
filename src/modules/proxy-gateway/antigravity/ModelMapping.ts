import { isEmpty, isString } from 'lodash-es';
import { logger } from '@/shared/logging/logger';

const PUBLIC_MODEL_PRESET_DISPLAY_NAMES = {
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
  'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
  'claude-sonnet-4-6-thinking': 'Claude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
} as const;

const PUBLIC_MODEL_BY_DISPLAY_NAME = new Map(
  Object.entries(PUBLIC_MODEL_PRESET_DISPLAY_NAMES).map(([modelId, displayName]) => [
    displayName.toLowerCase(),
    modelId,
  ]),
);

const PUBLIC_SUPPORTED_MODELS = [
  ...Object.keys(PUBLIC_MODEL_PRESET_DISPLAY_NAMES),
  'gemini-3-flash',
] as const;

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

export function getPublicModelIdForDisplayName(displayName: unknown): string | undefined {
  if (!isString(displayName) || isEmpty(displayName.trim())) {
    return undefined;
  }
  return PUBLIC_MODEL_BY_DISPLAY_NAME.get(displayName.trim().toLowerCase());
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
