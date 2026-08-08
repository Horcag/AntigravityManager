import { HttpStatus } from '@nestjs/common';
import type { CloudModelRoleId } from '@/modules/cloud-account/types';
import {
  applyGroundingCitations,
  formatGroundingSourceList,
} from '@/modules/proxy-gateway/antigravity/grounding-citations';
import type {
  ClaudeRequest,
  GeminiInternalRequest,
  GeminiResponse,
} from '@/modules/proxy-gateway/antigravity/types';
import {
  buildWebSearchSubRequest,
  extractWebSearchQuery,
  modelSupportsSearchGrounding,
  requestsWebSearch,
  requiresSeparateWebSearchCall,
} from '@/modules/proxy-gateway/antigravity/claude-request-web-search';
import { ModelRouteError } from '../../common/exceptions/model-route-exception';

/**
 * The separate web-search call.
 *
 * `v1internal` refuses a `generateContent` that carries both
 * `functionDeclarations` and `googleSearch`. The mapper therefore cannot serve
 * a request that asks for both, and used to resolve that by discarding the
 * search. This module supplies the alternative the upstream client uses: one
 * extra unary `generateContent` whose only tool is `googleSearch`, run against
 * a model the provider itself nominated for the `web_search` surface, with its
 * grounded answer handed back to the main call as context.
 */

export const WEB_SEARCH_ROLE: CloudModelRoleId = 'web_search';

/**
 * The system block the grounded answer is delivered in.
 *
 * A tool result would be the exact analogue of what gemini-cli returns, but a
 * proxy has no agent loop to attach one to: the search runs before the main
 * call, not in response to a tool call the model made. A system block is the
 * one channel that reaches the model on the very next turn regardless of what
 * the conversation looks like.
 */
export function formatWebSearchContext(query: string, result: string): string {
  return `Web search results for "${query}":\n\n${result}`;
}

/**
 * Model id for the search sub-call, or a fail-closed error.
 *
 * Guessing an id here would be the same defect in a new place: an id that is
 * not search-capable answers without grounding and the caller again cannot tell
 * that its search never happened. When the provider reported no `web_search`
 * role, the request fails and says so.
 */
export function resolveWebSearchModel(roleModelIds: readonly string[]): string {
  const model = roleModelIds.find((modelId) => modelId.trim().length > 0)?.trim();
  if (!model) {
    throw new ModelRouteError({
      message:
        'Web search was requested alongside client tools, which the upstream cannot serve in one call, and no account reported a model for the provider web_search role to run it separately',
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'model_catalog_unavailable',
    });
  }
  return model;
}

function collectResponseText(response: GeminiResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Renders the sub-call's answer the way gemini-cli renders it: inline `[n]`
 * markers spliced into the prose at the spans the provider grounded, then the
 * numbered source list.
 */
export function formatWebSearchResult(response: GeminiResponse): string | null {
  const responseText = collectResponseText(response);
  if (!responseText.trim()) {
    return null;
  }

  const grounding = response.candidates?.[0]?.groundingMetadata;
  const sources = grounding?.groundingChunks ?? [];
  if (sources.length === 0) {
    return responseText;
  }

  const cited = applyGroundingCitations(responseText, grounding?.groundingSupports, sources.length);
  const sourceList = formatGroundingSourceList(sources);
  return sourceList.length > 0 ? `${cited}\n\nSources:\n${sourceList.join('\n')}` : cited;
}

/**
 * Whether this request cannot be grounded by the call it would otherwise make.
 *
 * Two independent reasons, and both end in the same place — a separate one-shot
 * search — so they are decided together:
 *
 * 1. The request mixes search with client tools, which `v1internal` refuses in
 *    one `generateContent`.
 * 2. The model the request resolved to returns no grounding at all. Claude-family
 *    and gpt-oss models accept `googleSearch` with a 200 and answer as if it were
 *    never there, which is exactly the silent degradation this proxy exists to
 *    prevent.
 */
export function needsSeparateWebSearch(claudeRequest: ClaudeRequest, servedModel: string): boolean {
  if (!requestsWebSearch(claudeRequest)) {
    return false;
  }
  return requiresSeparateWebSearchCall(claudeRequest) || !modelSupportsSearchGrounding(servedModel);
}

export interface WebSearchSubCallParams {
  claudeRequest: ClaudeRequest;
  /** Model the main call will run on, used to decide whether it can ground. */
  servedModel: string;
  /**
   * Read only once a request is known to need the sub-call, so the ordinary
   * request path never depends on the role catalog being available.
   */
  getRoleModelIds: () => readonly string[];
  projectId?: string;
  userAgent?: string;
  /** Performs the unary `generateContent`, normally `GeminiClient.generateInternal`. */
  generate: (body: GeminiInternalRequest) => Promise<GeminiResponse>;
}

export interface WebSearchSubCallOutcome {
  model: string;
  query: string;
  /** Grounded text to hand to the main call, or null when the search found nothing. */
  context: string | null;
}

/**
 * Runs the search sub-call for a request that asks for both search and tools.
 *
 * Returns null when this request does not need one. Throws — it never returns
 * null as a way of giving up — when search is needed and cannot be run.
 */
export async function runWebSearchSubCall(
  params: WebSearchSubCallParams,
): Promise<WebSearchSubCallOutcome | null> {
  if (!needsSeparateWebSearch(params.claudeRequest, params.servedModel)) {
    return null;
  }

  const query = extractWebSearchQuery(params.claudeRequest);
  if (!query) {
    return null;
  }

  const model = resolveWebSearchModel(params.getRoleModelIds());
  const response = await params.generate(
    buildWebSearchSubRequest({
      query,
      model,
      projectId: params.projectId,
      userAgent: params.userAgent,
    }),
  );

  const result = formatWebSearchResult(response);
  return {
    model,
    query,
    context: result ? formatWebSearchContext(query, result) : null,
  };
}

/**
 * Returns a copy of `claudeRequest` carrying the search results.
 *
 * Appended rather than prepended so it sits closest to the turn it grounds, and
 * copied rather than mutated because the caller retries the same request object
 * across accounts.
 */
export function withWebSearchContext(claudeRequest: ClaudeRequest, context: string): ClaudeRequest {
  const system = claudeRequest.system;
  if (typeof system === 'string') {
    return { ...claudeRequest, system: `${system}\n\n${context}` };
  }
  if (Array.isArray(system)) {
    return { ...claudeRequest, system: [...system, { type: 'text', text: context }] };
  }
  return { ...claudeRequest, system: context };
}
