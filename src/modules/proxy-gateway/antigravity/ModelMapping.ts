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
 * LAST-RESORT OVERRIDE, not the primary rule.
 *
 * The primary rule is {@link resolveCatalogWithholdReason}, which reads the
 * surface partitioning the provider actually sends
 * (`FetchAvailableModelsResponse.tab_model_ids` and siblings, see
 * {@link CatalogModelRoleIndex}). This table only covers ids the role data does
 * not classify — an account or provider version that omits the role arrays, or
 * an id the arrays never mention. Prefer deleting entries here over adding
 * them: an entry is a standing claim that provider data will never explain the
 * id.
 *
 * 2026-08-08 (live, 0.19.17-local1, kanban-37): the provider's discovery
 * response lists these ids next to real chat models, but they are not chat
 * models:
 *  - chat_20706, chat_23310 -> every /v1/messages and /v1/chat/completions
 *    call against them returns 400 "Request contains an invalid argument."
 *  - tab_flash_lite_preview, tab_jump_flash_lite_preview -> answer 200, but
 *    they are Antigravity IDE's internal tab-completion functions, not
 *    models a user would deliberately select in a client.
 * kanban-40 confirmed from the vendor descriptor that the response carries the
 * role arrays, and now parses them, but could not make a live discovery call to
 * observe which role each of these four ids actually sits in. They therefore
 * stay listed until a live payload classifies them. These ids stay visible,
 * unfiltered, in GET /v1/model-routes so it stays evident the provider
 * advertised them.
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

/**
 * The provider's surface partitioning, projected onto published catalog ids.
 * Built by AccountLeaseModelPolicy from `FetchAvailableModelsResponse`.
 */
export interface CatalogModelRoleIndex {
  /** Catalog id -> the non-chat roles (`tab`, `command`, ...) it belongs to. */
  nonChatRoles: ReadonlyMap<string, readonly string[]>;
  /** Catalog ids the provider offers on the chat (`agent`) surface. */
  chatModelIds: ReadonlySet<string>;
  /**
   * Whether any account reported the chat role at all. Without it, non-chat
   * membership cannot prove an id is *not* also a chat model, so the rule must
   * not fire.
   */
  hasChatRoleData: boolean;
}

export interface UnpublishedCatalogModelId {
  id: string;
  /** `role` when provider role data withheld it, `override` for the id table. */
  reason: 'role' | 'override';
  /** Provider roles that withheld the id; empty for the id table. */
  roles: string[];
}

/**
 * Why an advertised id is kept out of the published catalog, or undefined when
 * it is publishable.
 *
 * Provider evidence wins: an id the provider assigned to a non-chat surface and
 * never to the chat surface is withheld with that role as the reason. The id
 * table is consulted only when the role data cannot answer, so a payload
 * without role arrays behaves exactly as it did before roles were parsed.
 */
export function resolveCatalogWithholdReason(
  modelId: string,
  roleIndex?: CatalogModelRoleIndex,
): UnpublishedCatalogModelId | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();

  if (roleIndex?.hasChatRoleData && !roleIndex.chatModelIds.has(normalizedModelId)) {
    const roles = roleIndex.nonChatRoles.get(normalizedModelId);
    if (roles && roles.length > 0) {
      return { id: modelId, reason: 'role', roles: [...roles] };
    }
  }

  if (isNonChatCatalogModelId(normalizedModelId)) {
    return { id: modelId, reason: 'override', roles: [] };
  }

  return undefined;
}

export function getUnpublishedCatalogModelIds(
  modelIds: Iterable<string>,
  roleIndex?: CatalogModelRoleIndex,
): UnpublishedCatalogModelId[] {
  const unpublished: UnpublishedCatalogModelId[] = [];
  for (const modelId of modelIds) {
    const withheld = resolveCatalogWithholdReason(modelId, roleIndex);
    if (withheld) {
      unpublished.push(withheld);
    }
  }

  return unpublished.sort((left, right) => left.id.localeCompare(right.id));
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
 * The catalog actually published to clients: every discovered/configured model
 * id, minus the ones {@link resolveCatalogWithholdReason} withholds. Shared by
 * both the OpenAI-compatible (/v1/models) and Gemini-native (/v1beta/models)
 * listing endpoints so they stay in sync.
 */
export function getPublishedCatalogModelIds(
  customMapping: Record<string, string> = {},
  dynamicModelIds?: Iterable<string>,
  roleIndex?: CatalogModelRoleIndex,
): string[] {
  return getAllDynamicModels(customMapping, dynamicModelIds).filter(
    (modelId) => !resolveCatalogWithholdReason(modelId, roleIndex),
  );
}

export function getOpenAICompatibleModels(
  customMapping: Record<string, string> = {},
  dynamicModelIds?: Iterable<string>,
  roleIndex?: CatalogModelRoleIndex,
): string[] {
  return getPublishedCatalogModelIds(customMapping, dynamicModelIds, roleIndex);
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
