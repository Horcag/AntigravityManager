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
 * The only reason an advertised id is kept out of the published catalog.
 *
 * 2026-08-08 (live, 0.19.17-local1, kanban-37): the provider's discovery
 * response lists these ids next to real chat models, but they are not chat
 * models:
 *  - chat_20706, chat_23310 -> every /v1/messages and /v1/chat/completions
 *    call against them returns 400 "Request contains an invalid argument."
 *  - tab_flash_lite_preview, tab_jump_flash_lite_preview -> answer 200, but
 *    they are Antigravity IDE's internal tab-completion functions, not
 *    models a user would deliberately select in a client.
 * These ids stay visible, unfiltered, in GET /v1/model-routes so it stays
 * evident the provider advertised them.
 *
 * DO NOT replace this table with a rule over the provider's role arrays. That
 * was tried in kanban-40 and reverted: see {@link resolveCatalogWithholdReason}
 * for the live measurement that refutes it.
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
 *
 * Reporting only: this index annotates diagnostics and answers "which model
 * does this account use for role X". It must not decide what the catalog
 * publishes — see {@link resolveCatalogWithholdReason}.
 */
export interface CatalogModelRoleIndex {
  /** Catalog id -> the non-chat roles (`tab`, `command`, ...) it belongs to. */
  nonChatRoles: ReadonlyMap<string, readonly string[]>;
  /** Catalog ids the provider offers on the chat (`agent`) surface. */
  chatModelIds: ReadonlySet<string>;
  /** Whether any account reported the chat (`agent`) role at all. */
  hasChatRoleData: boolean;
}

export interface UnpublishedCatalogModelId {
  id: string;
  /** Always `override`: {@link NON_CHAT_CATALOG_MODEL_IDS} is the only rule. */
  reason: 'override';
  /**
   * Provider roles the id belongs to, when the role data mentions it. Reported
   * for diagnostics; it never contributes to the withholding decision.
   */
  roles: string[];
}

/**
 * Why an advertised id is kept out of the published catalog, or undefined when
 * it is publishable. {@link NON_CHAT_CATALOG_MODEL_IDS} decides alone; the role
 * index only annotates the answer.
 *
 * Role membership MUST NOT withhold. kanban-40 shipped a rule that withheld any
 * id in a non-chat role and absent from the agent list, and it broke published
 * models on the live account (19 -> 16). The measured discovery response:
 * 24 models, 11 in `agent_model_sorts`, role counts
 * `{command:1, tab:2, image_generation:1, mquery:1, web_search:1,
 * commit_message:1, audio_transcription:1}`. Under that rule `gemini-3-flash`
 * (role `command`) and `gemini-3.1-flash-lite` (roles `commit_message`,
 * `mquery`, `web_search`) disappeared even though both answer chat requests
 * normally. `agent_model_sorts` is the model picker's grouping, not the set of
 * chat-capable models, and role membership is not exclusive, so "in a tool role
 * and absent from the agent list" does not mean "not a chat model". Names are no
 * guide either: `chat_20706`/`chat_23310` measured as the `tab` models, while
 * `tab_flash_lite_preview`/`tab_jump_flash_lite_preview` sit in no role at all.
 */
export function resolveCatalogWithholdReason(
  modelId: string,
  roleIndex?: CatalogModelRoleIndex,
): UnpublishedCatalogModelId | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (!isNonChatCatalogModelId(normalizedModelId)) {
    return undefined;
  }

  const roles = roleIndex?.nonChatRoles.get(normalizedModelId) ?? [];
  return { id: modelId, reason: 'override', roles: [...roles] };
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
