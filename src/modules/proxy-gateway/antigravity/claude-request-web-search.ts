import { isString } from 'lodash-es';
import { mapClaudeModelToGemini } from './ModelMapping';
import { buildInternalRequestBody } from './claude-request-envelope';
import { isGeminiImageModel } from './claude-request-model-traits';
import { detectsNetworkingTool, isGoogleSearchTool } from './claude-request-tools';
import type { ClaudeRequest, GeminiInternalRequest } from './types';

/**
 * Whether the caller asked for web search at all.
 *
 * The response surfaces need this to decide between rendering grounding as the
 * protocol's search blocks and rendering it as the trailing markdown that a
 * caller who never asked for search still gets.
 */
export function requestsWebSearch(claudeReq: ClaudeRequest): boolean {
  return detectsNetworkingTool(claudeReq.tools);
}

/**
 * Whether the model the request will actually run on can ground an answer.
 *
 * Measured against the live account: `googleSearch` returns real
 * `groundingMetadata` on Gemini-family models and none at all on the
 * Claude-family and gpt-oss models the same catalog publishes. A request for
 * search on one of those must not be answered ungrounded, so callers route it
 * through the separate search call instead.
 */
export function modelSupportsSearchGrounding(model: string): boolean {
  return mapClaudeModelToGemini(model).toLowerCase().startsWith('gemini');
}

/**
 * Whether this request's web search has to be served by a separate call.
 *
 * `v1internal` rejects a `generateContent` that carries both
 * `functionDeclarations` and `googleSearch`, so a request that asks for both
 * cannot be served by one call. Dropping the search silently — which is what
 * this code used to do — answers a request for a capability by pretending it
 * was never asked for. The upstream Antigravity/gemini-cli answer is to never
 * mix them: search runs as its own one-shot unary `generateContent` against a
 * cheap model whose only tool is `googleSearch`, and the text it returns is fed
 * back as context. {@link buildWebSearchSubRequest} builds that call.
 */
export function requiresSeparateWebSearchCall(claudeReq: ClaudeRequest): boolean {
  const tools = claudeReq.tools;
  if (!tools || tools.length === 0) {
    return false;
  }
  if (!detectsNetworkingTool(tools)) {
    return false;
  }
  // Image generation strips tools entirely, so nothing is being dropped there.
  if (isGeminiImageModel(mapClaudeModelToGemini(claudeReq.model))) {
    return false;
  }
  return tools.some((tool) => !isGoogleSearchTool(tool) && Boolean(tool.name));
}

/**
 * The query the separate search call runs.
 *
 * gemini-cli takes it from the model's `google_web_search` tool call. A proxy
 * has no agent loop to produce one, so the latest user turn is used: it is the
 * text the caller wanted grounded. Returns null when there is nothing to search
 * for, which callers must treat as "no search to run" rather than searching for
 * an empty string.
 */
export function extractWebSearchQuery(claudeReq: ClaudeRequest): string | null {
  for (let i = claudeReq.messages.length - 1; i >= 0; i--) {
    const message = claudeReq.messages[i];
    if (message.role !== 'user') {
      continue;
    }

    const text = isString(message.content)
      ? message.content
      : message.content
          .filter(
            (block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text',
          )
          .map((block) => block.text)
          .join('\n');

    const trimmed = text.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

export interface WebSearchSubRequestParams {
  /** Text handed to the search model. */
  query: string;
  /** Model id resolved from the provider's `web_search` role. */
  model: string;
  projectId?: string;
  userAgent?: string;
}

/**
 * The one-shot unary search call.
 *
 * The wire shape is an ordinary `generateContent` whose only tool is
 * `{ googleSearch: {} }` — the same bare tool entry the mixed path would have
 * carried, and the shape `converter.ts` copies verbatim out of the resolved
 * `web-search` model alias. `temperature: 0` / `topP: 1` match that alias:
 * this call summarises search results, it does not need sampling diversity.
 */
export function buildWebSearchSubRequest(params: WebSearchSubRequestParams): GeminiInternalRequest {
  return buildInternalRequestBody({
    requestConfig: {
      requestType: 'web_search',
      injectGoogleSearch: true,
      finalModel: params.model,
      imageConfig: null,
    },
    innerRequest: {
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0, topP: 1 },
      contents: [{ role: 'user', parts: [{ text: params.query }] }],
    },
    projectId: params.projectId,
    userAgent: params.userAgent,
  });
}
