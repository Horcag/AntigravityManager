import {
  describeWebSearchQuery,
  resolveWebSearchCitations,
  type WebSearchResultSet,
} from './web-search-results';

/**
 * OpenAI's citation shape, used by both `/v1/chat/completions` and
 * `/v1/responses`.
 *
 * The indices are the trap. OpenAI documents `start_index` / `end_index` as
 * offsets into the returned text, and every OpenAI client slices the string
 * with them directly — so they are UTF-16 code units, while the upstream
 * grounding reports UTF-8 bytes. Handing the byte numbers straight through
 * looks right for English and points at the wrong words for anything else.
 * {@link resolveWebSearchCitations} owns that conversion.
 */
export interface OpenAIUrlCitationAnnotation {
  type: 'url_citation';
  url_citation: {
    url: string;
    title: string;
    start_index: number;
    end_index: number;
  };
}

export function buildOpenAIUrlCitationAnnotations(
  text: string,
  resultSet: WebSearchResultSet | null,
): OpenAIUrlCitationAnnotation[] {
  return resolveWebSearchCitations(text, resultSet).flatMap((citation) =>
    citation.sources.map((source) => ({
      type: 'url_citation' as const,
      url_citation: {
        url: source.url,
        title: source.title,
        start_index: citation.startIndex,
        end_index: citation.endIndex,
      },
    })),
  );
}

/**
 * The Responses `web_search_call` output item.
 *
 * Reported as `completed` because the upstream only ever hands back grounding
 * for a search it already finished — there is no intermediate state to observe,
 * so no other status could be honestly claimed.
 */
export interface OpenAIWebSearchCallItem {
  type: 'web_search_call';
  id: string;
  status: 'completed';
  action: { type: 'search'; query: string };
}

export function buildOpenAIWebSearchCallItem(
  resultSet: WebSearchResultSet,
  itemId: string,
): OpenAIWebSearchCallItem {
  return {
    type: 'web_search_call',
    id: itemId,
    status: 'completed',
    action: { type: 'search', query: describeWebSearchQuery(resultSet) },
  };
}

const OPENAI_WEB_SEARCH_RESULTS = Symbol('proxy-openai-web-search-results');

type WebSearchResultCarrier = object & {
  [OPENAI_WEB_SEARCH_RESULTS]?: WebSearchResultSet;
};

/**
 * Carries the grounding alongside a Chat Completions response without putting
 * it on the wire.
 *
 * `/v1/responses` is served by translating a Chat Completions response, and it
 * needs facts — the queries that ran — that the Chat Completions shape has no
 * field for. A non-enumerable symbol keeps them out of `JSON.stringify`, which
 * is the same trick the model-route metadata already uses on this path.
 */
export function attachWebSearchResults<T extends object>(
  value: T,
  resultSet: WebSearchResultSet,
): T {
  Object.defineProperty(value, OPENAI_WEB_SEARCH_RESULTS, {
    configurable: true,
    value: resultSet,
  });
  return value;
}

export function getWebSearchResults(value: unknown): WebSearchResultSet | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as WebSearchResultCarrier)[OPENAI_WEB_SEARCH_RESULTS];
}
