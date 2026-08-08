import {
  describeWebSearchQuery,
  resolveWebSearchCitations,
  type WebSearchResultSet,
} from './web-search-results';

/**
 * Anthropic's server-tool wire shape for web search.
 *
 * Clients parse this: the Anthropic SDKs surface `server_tool_use` /
 * `web_search_tool_result` blocks as first-class objects and render
 * `web_search_result_location` citations as footnotes. Returning the grounding
 * as prose instead — which is all this proxy could do before — means the caller
 * gets an answer it cannot tell apart from an ungrounded one.
 *
 * Two fields Anthropic defines are deliberately absent rather than invented:
 * `encrypted_content` / `encrypted_index`, which only Anthropic's own index can
 * produce, and `page_age`, which Google does not report.
 */

export const ANTHROPIC_WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';

/** The name Anthropic's own client gives the tool when it does not say otherwise. */
export const ANTHROPIC_WEB_SEARCH_TOOL_NAME = 'web_search';

export interface AnthropicWebSearchResult {
  type: 'web_search_result';
  url: string;
  title: string;
  page_age?: string;
}

export interface AnthropicServerToolUseBlock {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: { query: string };
}

export interface AnthropicWebSearchToolResultBlock {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: AnthropicWebSearchResult[];
}

export interface AnthropicWebSearchCitation {
  type: 'web_search_result_location';
  url: string;
  title: string;
  cited_text: string;
}

export interface AnthropicWebSearchBlocks {
  serverToolUse: AnthropicServerToolUseBlock;
  toolResult: AnthropicWebSearchToolResultBlock;
}

/**
 * Builds the pair of blocks that precede the grounded answer.
 *
 * One pair, not one per query: Google reports the queries it ran and the pages
 * it read as two flat lists with no mapping between them, so splitting them
 * into several searches would have to invent which page came from which query.
 * The true search count is reported through `usage.server_tool_use` instead.
 */
export function buildAnthropicWebSearchBlocks(
  resultSet: WebSearchResultSet,
  toolUseId: string,
  toolName: string = ANTHROPIC_WEB_SEARCH_TOOL_NAME,
): AnthropicWebSearchBlocks {
  return {
    serverToolUse: {
      type: 'server_tool_use',
      id: toolUseId,
      name: toolName,
      input: { query: describeWebSearchQuery(resultSet) },
    },
    toolResult: {
      type: 'web_search_tool_result',
      tool_use_id: toolUseId,
      content: resultSet.sources.map((source) => ({
        type: 'web_search_result' as const,
        url: source.url,
        title: source.title,
        ...(source.pageAge ? { page_age: source.pageAge } : {}),
      })),
    },
  };
}

/**
 * The `citations` array for the assistant text block.
 *
 * A span the provider attributed to several pages becomes several citations
 * over the same `cited_text`, which is how Anthropic represents it too.
 */
export function buildAnthropicWebSearchCitations(
  text: string,
  resultSet: WebSearchResultSet | null,
): AnthropicWebSearchCitation[] {
  return resolveWebSearchCitations(text, resultSet).flatMap((citation) =>
    citation.sources.map((source) => ({
      type: 'web_search_result_location' as const,
      url: source.url,
      title: source.title,
      cited_text: citation.citedText,
    })),
  );
}
