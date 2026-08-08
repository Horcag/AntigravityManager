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
 * `ModelDetails` scalars that only an editor completion loop needs. Measured
 * live on 2026-08-08 (0.19.17-local1, kanban-40) by probing each advertised id:
 *
 *  | id                     | these flags | behaviour                        |
 *  | ---------------------- | ----------- | -------------------------------- |
 *  | chat_20706             | all three   | 400 on every chat call           |
 *  | tab_flash_lite_preview | all three   | 200, but it is tab completion    |
 *  | gemini-3-flash         | none        | real chat model                  |
 *  | gemini-3.6-flash-tiered| none        | real chat model                  |
 *  | gemini-3.1-flash-lite  | none        | real chat model                  |
 *  | gemini-3.1-flash-image | none        | real image model, no flags at all|
 *
 * None of them describes anything a `/v1/chat/completions` call can use: a
 * lead-in prefix, a buffer the editor keeps re-sending, and a local token
 * estimator are all inner-loop editor concerns. So any single marker withholds,
 * and {@link resolveCatalogWithholdReason} names the ones that matched, which
 * makes a future false positive a one-line correction rather than a mystery.
 *
 * `maxTokens: 16384` separates the same two ids just as cleanly on this data,
 * but it is deliberately NOT part of the rule: a small future chat model would
 * break it. Role membership is not part of the rule either — see
 * {@link resolveCatalogWithholdReason}.
 */
export const COMPLETION_MODEL_FLAGS = [
  'requiresLeadInGeneration',
  'supportsCumulativeContext',
  'supportsEstimateTokenCounter',
] as const;

export type CompletionModelFlag = (typeof COMPLETION_MODEL_FLAGS)[number];

/** The parsed `ModelDetails` scalars {@link COMPLETION_MODEL_FLAGS} names. */
export interface CompletionModelDetails {
  requires_lead_in_generation?: boolean;
  supports_cumulative_context?: boolean;
  supports_estimate_token_counter?: boolean;
}

/** Parsed detail key backing each marker, in {@link COMPLETION_MODEL_FLAGS} order. */
const COMPLETION_MODEL_DETAIL_KEYS: Readonly<
  Record<CompletionModelFlag, keyof CompletionModelDetails>
> = {
  requiresLeadInGeneration: 'requires_lead_in_generation',
  supportsCumulativeContext: 'supports_cumulative_context',
  supportsEstimateTokenCounter: 'supports_estimate_token_counter',
};

/**
 * The editor-family markers one advertised id carries, in
 * {@link COMPLETION_MODEL_FLAGS} order. Absent and `false` both count as "not
 * set": the provider omits these scalars on chat models and only ever sends
 * them as `true`.
 */
export function resolveCompletionModelFlags(
  details: CompletionModelDetails | undefined,
): CompletionModelFlag[] {
  if (!details) {
    return [];
  }

  return COMPLETION_MODEL_FLAGS.filter(
    (flag) => details[COMPLETION_MODEL_DETAIL_KEYS[flag]] === true,
  );
}

/**
 * Ids withheld without provider evidence, as a last resort.
 *
 * 2026-08-08 (live, 0.19.17-local1, kanban-37): the provider's discovery
 * response lists these next to real chat models, but chat_20706/chat_23310
 * answer 400 "Request contains an invalid argument." to every /v1/messages and
 * /v1/chat/completions call, and the tab_* ids answer 200 while being the IDE's
 * internal tab-completion functions.
 *
 * chat_20706 and tab_flash_lite_preview were removed from this table in
 * kanban-40 r4: both were probed individually and both carry every
 * {@link COMPLETION_MODEL_FLAGS} marker, so the rule now withholds them with a
 * stated reason. The two that remain were never probed individually, so there
 * is no measurement saying the rule reaches them:
 *  - chat_23310 -> shares the 400 behaviour of chat_20706, flags unmeasured.
 *  - tab_jump_flash_lite_preview -> shares the tab-completion behaviour of
 *    tab_flash_lite_preview, flags unmeasured.
 * When a probe shows either one carries the markers, delete it here; the rule
 * already covers it and the entry is then dead weight.
 *
 * DO NOT replace this table with a rule over the provider's role arrays. That
 * was tried in kanban-40 and reverted: see {@link resolveCatalogWithholdReason}
 * for the live measurement that refutes it.
 *
 * Withheld ids stay visible, unfiltered, in GET /v1/model-routes so it stays
 * evident the provider advertised them.
 */
export const NON_CHAT_CATALOG_MODEL_IDS: ReadonlySet<string> = new Set([
  'chat_23310',
  'tab_jump_flash_lite_preview',
]);

export function isNonChatCatalogModelId(modelId: string): boolean {
  return NON_CHAT_CATALOG_MODEL_IDS.has(modelId.trim().toLowerCase());
}

/**
 * Provider facts about the advertised ids, projected onto published catalog
 * ids. Built by AccountLeaseModelPolicy from `FetchAvailableModelsResponse`.
 *
 * Only `completionFlags` decides anything: it carries the `ModelDetails`
 * markers {@link COMPLETION_MODEL_FLAGS} lists. The role fields are reporting
 * only — they annotate diagnostics and answer "which model does this account
 * use for role X", and must not decide what the catalog publishes. See
 * {@link resolveCatalogWithholdReason}.
 */
export interface CatalogModelRoleIndex {
  /** Catalog id -> the non-chat roles (`tab`, `command`, ...) it belongs to. */
  nonChatRoles: ReadonlyMap<string, readonly string[]>;
  /** Catalog ids the provider offers on the chat (`agent`) surface. */
  chatModelIds: ReadonlySet<string>;
  /** Whether any account reported the chat (`agent`) role at all. */
  hasChatRoleData: boolean;
  /**
   * Catalog id -> the editor-family `ModelDetails` markers the provider set on
   * it, in {@link COMPLETION_MODEL_FLAGS} order. Ids with no marker are absent.
   */
  completionFlags: ReadonlyMap<string, readonly CompletionModelFlag[]>;
}

export interface UnpublishedCatalogModelId {
  id: string;
  /**
   * `completion_model`: the provider's own `ModelDetails` marks the id as part
   * of the editor completion loop ({@link COMPLETION_MODEL_FLAGS}).
   * `override`: no provider evidence, withheld by the dated
   * {@link NON_CHAT_CATALOG_MODEL_IDS} table.
   */
  reason: 'completion_model' | 'override';
  /**
   * The editor-family markers that matched, so a `completion_model` decision
   * explains itself in GET /v1/model-routes. Empty for `override`.
   */
  flags: CompletionModelFlag[];
  /**
   * Provider roles the id belongs to, when the role data mentions it. Reported
   * for diagnostics; it never contributes to the withholding decision.
   */
  roles: string[];
}

/**
 * Why an advertised id is kept out of the published catalog, or undefined when
 * it is publishable. Two reasons, in order: the id's own `ModelDetails` carries
 * an editor-family marker ({@link COMPLETION_MODEL_FLAGS}), or the dated
 * {@link NON_CHAT_CATALOG_MODEL_IDS} table still lists it. An id with no marker
 * and no table entry is published even when it carries no scalar flags at all —
 * `gemini-3.1-flash-image` is exactly that, and it is a real model.
 *
 * Role membership MUST NOT withhold; it is reported as corroboration only.
 * kanban-40 shipped a rule that withheld any id in a non-chat role and absent
 * from the agent list, and it broke published models on the live account
 * (19 -> 16). The measured discovery response:
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
  const roles = [...(roleIndex?.nonChatRoles.get(normalizedModelId) ?? [])];

  const flags = roleIndex?.completionFlags.get(normalizedModelId) ?? [];
  if (flags.length > 0) {
    return { id: modelId, reason: 'completion_model', flags: [...flags], roles };
  }

  if (!isNonChatCatalogModelId(normalizedModelId)) {
    return undefined;
  }

  return { id: modelId, reason: 'override', flags: [], roles };
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
