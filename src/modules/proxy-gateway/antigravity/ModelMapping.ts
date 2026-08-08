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

/**
 * 2026-08-08 (live, 0.19.17-local1, kanban-37): the provider's discovery
 * response (`v1internal:fetchAvailableModels`) lists these ids next to real
 * chat models, but they are not chat models:
 *  - chat_20706, chat_23310 -> every /v1/messages and /v1/chat/completions
 *    call against them returns 400 "Request contains an invalid argument."
 *  - tab_flash_lite_preview, tab_jump_flash_lite_preview -> answer 200, but
 *    they are Antigravity IDE's internal tab-completion functions, not
 *    models a user would deliberately select in a client.
 * The response's typed shape (ModelInfoRaw in GoogleAPIService.ts,
 * QuotaApiResponse in antigravity/types.ts: quotaInfo/displayName/
 * supportsImages/supportsThinking/thinkingBudget/recommended/maxTokens/
 * maxOutputTokens/supportedMimeTypes) carries no type, capability, or
 * generation-method field distinguishing them from chat models, and this
 * task could not make a live discovery call to check the untyped payload
 * directly. So, per the task instructions, this is an explicit id table in
 * the shape of MODEL_FAMILY_SAFETY_OVERRIDES (ClaudeRequestMapper.ts)
 * rather than a property-based filter. These ids stay visible, unfiltered,
 * in GET /v1/model-routes so it stays evident the provider advertised them.
 */
export const NON_CHAT_CATALOG_MODEL_IDS: ReadonlySet<string> = new Set([
  'chat_20706',
  'chat_23310',
  'tab_flash_lite_preview',
  'tab_jump_flash_lite_preview',
]);

export function isNonChatCatalogModelId(modelId: string): boolean {
  return NON_CHAT_CATALOG_MODEL_IDS.has(modelId.trim().toLowerCase());
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

/**
 * The catalog actually published to clients: every discovered/configured
 * model id, minus the ones in NON_CHAT_CATALOG_MODEL_IDS. Shared by both the
 * OpenAI-compatible (/v1/models) and Gemini-native (/v1beta/models) listing
 * endpoints so they stay in sync.
 */
export function getPublishedCatalogModelIds(
  customMapping: Record<string, string> = {},
  dynamicModelIds?: Iterable<string>,
): string[] {
  return getAllDynamicModels(customMapping, dynamicModelIds).filter(
    (modelId) => !isNonChatCatalogModelId(modelId),
  );
}

export function getOpenAICompatibleModels(
  customMapping: Record<string, string> = {},
  dynamicModelIds?: Iterable<string>,
): string[] {
  return getPublishedCatalogModelIds(customMapping, dynamicModelIds);
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
