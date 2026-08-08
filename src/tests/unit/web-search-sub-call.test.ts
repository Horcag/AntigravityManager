import { describe, expect, it, vi } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import {
  buildWebSearchSubRequest,
  extractWebSearchQuery,
  requiresSeparateWebSearchCall,
} from '@/modules/proxy-gateway/antigravity/claude-request-web-search';
import { applyGroundingCitations } from '@/modules/proxy-gateway/antigravity/grounding-citations';
import {
  formatWebSearchResult,
  resolveWebSearchModel,
  runWebSearchSubCall,
  withWebSearchContext,
} from '@/modules/proxy-gateway/server/modules/gemini/web-search-sub-call';
import type {
  ClaudeRequest,
  GeminiInternalRequest,
  GeminiResponse,
} from '@/modules/proxy-gateway/antigravity/types';

const SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search' } as const;

const CLIENT_TOOL = {
  name: 'read_file',
  description: 'Reads a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
} as const;

function createRequest(overrides: Partial<ClaudeRequest> = {}): ClaudeRequest {
  return {
    model: 'gemini-3-pro',
    messages: [{ role: 'user', content: 'Какая сейчас погода в Москве?' }],
    tools: [SEARCH_TOOL, CLIENT_TOOL],
    ...overrides,
  };
}

function textResponse(text: string, grounding?: Record<string, unknown>): GeminiResponse {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        ...(grounding ? { groundingMetadata: grounding } : {}),
      },
    ],
  } as unknown as GeminiResponse;
}

describe('separate web-search call', () => {
  it('flags a request that asks for search alongside client tools', () => {
    expect(requiresSeparateWebSearchCall(createRequest())).toBe(true);
  });

  it('does not flag a search-only request, which the main call still grounds itself', () => {
    const request = createRequest({ tools: [SEARCH_TOOL] });

    expect(requiresSeparateWebSearchCall(request)).toBe(false);
    // The mixed case is the only one the main call cannot serve.
    expect(transformClaudeRequestIn(request).request.tools).toContainEqual({ googleSearch: {} });
  });

  it('does not flag a request with client tools but no search tool', () => {
    expect(requiresSeparateWebSearchCall(createRequest({ tools: [CLIENT_TOOL] }))).toBe(false);
  });

  it('builds the sub-call as an ordinary generateContent whose only tool is googleSearch', () => {
    const body = buildWebSearchSubRequest({
      query: 'погода в Москве',
      model: 'gemini-3.1-flash-lite',
      projectId: 'project-1',
    });

    expect(body.model).toBe('gemini-3.1-flash-lite');
    expect(body.project).toBe('project-1');
    expect(body.request.tools).toEqual([{ googleSearch: {} }]);
    expect(body.request.generationConfig).toMatchObject({ temperature: 0, topP: 1 });
    expect(body.request.contents).toEqual([{ role: 'user', parts: [{ text: 'погода в Москве' }] }]);
  });

  it('takes the query from the latest user turn', () => {
    const request = createRequest({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: [{ type: 'text', text: '  latest question  ' }] },
      ],
    });

    expect(extractWebSearchQuery(request)).toBe('latest question');
  });

  it('makes exactly one search call when client tools are present and feeds the result back', async () => {
    const generate = vi.fn(async (body: GeminiInternalRequest) => {
      expect(body.request.tools).toEqual([{ googleSearch: {} }]);
      expect(body.request.tools?.some((tool) => 'functionDeclarations' in tool)).toBe(false);
      return textResponse('В Москве сейчас +18 °C.');
    });

    const outcome = await runWebSearchSubCall({
      claudeRequest: createRequest(),
      servedModel: 'gemini-3-pro',
      getRoleModelIds: () => ['gemini-3.1-flash-lite'],
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(outcome?.model).toBe('gemini-3.1-flash-lite');
    expect(outcome?.context).toContain('Web search results for "Какая сейчас погода в Москве?"');
    expect(outcome?.context).toContain('В Москве сейчас +18 °C.');
  });

  it('makes no search call when the request does not mix search with client tools', async () => {
    const generate = vi.fn();

    const outcome = await runWebSearchSubCall({
      claudeRequest: createRequest({ tools: [SEARCH_TOOL] }),
      servedModel: 'gemini-3-pro',
      getRoleModelIds: () => ['gemini-3.1-flash-lite'],
      generate,
    });

    expect(outcome).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('fails with an explicit error instead of guessing when no web_search role model exists', () => {
    expect(() => resolveWebSearchModel([])).toThrowError(/web_search role/);
  });

  it('propagates that error rather than dropping the search', async () => {
    const generate = vi.fn();

    await expect(
      runWebSearchSubCall({
        claudeRequest: createRequest(),
        servedModel: 'gemini-3-pro',
        getRoleModelIds: () => [],
        generate,
      }),
    ).rejects.toThrowError(/web_search role/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('appends the grounded context to an existing system prompt without mutating the request', () => {
    const request = createRequest({ system: 'You are helpful.' });
    const augmented = withWebSearchContext(request, 'Web search results for "x":\n\nresult');

    expect(augmented.system).toBe('You are helpful.\n\nWeb search results for "x":\n\nresult');
    expect(request.system).toBe('You are helpful.');
  });
});

describe('grounding citation insertion', () => {
  it('inserts markers at UTF-8 byte offsets without corrupting a Cyrillic answer', () => {
    const text = 'Москва — столица России. Погода сегодня ясная.';
    const firstSentence = 'Москва — столица России.';
    const encoder = new TextEncoder();

    const cited = applyGroundingCitations(
      text,
      [
        {
          segment: { startIndex: 0, endIndex: encoder.encode(firstSentence).length },
          groundingChunkIndices: [0],
        },
        {
          segment: { startIndex: 0, endIndex: encoder.encode(text).length },
          groundingChunkIndices: [1, 0],
        },
      ],
      2,
    );

    expect(cited).toBe('Москва — столица России.[1] Погода сегодня ясная.[2][1]');
    expect(cited).not.toContain('�');
  });

  it('is a no-op when a UTF-16 index would have been used instead of a byte offset', () => {
    // 'Погода' is 6 code units but 12 bytes; slicing at 6 would land mid-character.
    const text = 'Погода';
    const cited = applyGroundingCitations(
      text,
      [{ segment: { endIndex: 12 }, groundingChunkIndices: [0] }],
      1,
    );

    expect(cited).toBe('Погода[1]');
  });

  it('clamps an end index that overruns the response', () => {
    const cited = applyGroundingCitations(
      'short',
      [{ segment: { endIndex: 9_000 }, groundingChunkIndices: [0] }],
      1,
    );

    expect(cited).toBe('short[1]');
  });

  it('renders the search result with inline markers and the trailing source list', () => {
    const text = 'Ответ основан на источнике.';
    const response = textResponse(text, {
      groundingChunks: [{ web: { title: 'Источник', uri: 'https://example.com/a' } }],
      groundingSupports: [
        {
          segment: { endIndex: new TextEncoder().encode(text).length },
          groundingChunkIndices: [0],
        },
      ],
    });

    expect(formatWebSearchResult(response)).toBe(
      'Ответ основан на источнике.[1]\n\nSources:\n[1] Источник (https://example.com/a)',
    );
  });

  it('returns null when the search produced no text', () => {
    expect(formatWebSearchResult(textResponse('   '))).toBeNull();
  });
});
