import { describe, expect, it } from 'vitest';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { toOpenAIResponsesResponse } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesResponseMapper';
import { OpenAIResponsesStreamingMapper } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import {
  attachWebSearchResults,
  buildOpenAIUrlCitationAnnotations,
} from '@/modules/proxy-gateway/antigravity/openai-web-search';
import {
  resolveWebSearchCitations,
  toWebSearchResultSet,
} from '@/modules/proxy-gateway/antigravity/web-search-results';
import type { GeminiResponse, GroundingMetadata } from '@/modules/proxy-gateway/antigravity/types';
import { normalizeOpenAIChatRequest } from '@/modules/proxy-gateway/server/modules/openai/chat/openai-request-contract';
import { normalizeOpenAIResponsesRequest } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-request-contract';
import type { OpenAIChatResponse } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;

/**
 * A Cyrillic answer is the whole point of these fixtures: every offset the
 * provider reports is a UTF-8 byte count, and on this text one character is two
 * bytes, so any implementation that treats the numbers as string indices lands
 * in the wrong place and the test says so.
 */
const ANSWER = 'Москва — столица России. Погода сегодня ясная.';
const FIRST_SENTENCE = 'Москва — столица России.';

function grounding(): GroundingMetadata {
  return {
    webSearchQueries: ['столица России'],
    groundingChunks: [
      { web: { uri: 'https://example.com/moscow', title: 'Москва' } },
      { web: { uri: 'https://example.com/weather', title: 'Погода' } },
    ],
    groundingSupports: [
      {
        segment: { startIndex: 0, endIndex: byteLength(FIRST_SENTENCE) },
        groundingChunkIndices: [0],
      },
      {
        segment: {
          startIndex: byteLength(`${FIRST_SENTENCE} `),
          endIndex: byteLength(ANSWER),
        },
        groundingChunkIndices: [1],
      },
    ],
  };
}

function geminiResponse(text = ANSWER): GeminiResponse {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        groundingMetadata: grounding(),
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 11 },
  } as unknown as GeminiResponse;
}

describe('grounding spans resolved against the answer', () => {
  it('converts UTF-8 byte offsets into UTF-16 code-unit offsets', () => {
    const resultSet = toWebSearchResultSet(grounding());
    const citations = resolveWebSearchCitations(ANSWER, resultSet);

    expect(citations).toHaveLength(2);
    // The byte offsets are nearly double the code-unit offsets on this text,
    // which is exactly what a naive pass-through would get wrong.
    expect(byteLength(FIRST_SENTENCE)).toBeGreaterThan(FIRST_SENTENCE.length);
    expect(citations[0]).toMatchObject({
      startIndex: 0,
      endIndex: FIRST_SENTENCE.length,
      citedText: FIRST_SENTENCE,
    });
    expect(ANSWER.slice(citations[1].startIndex, citations[1].endIndex)).toBe(
      'Погода сегодня ясная.',
    );
    expect(citations[1].citedText).not.toContain('�');
  });

  it('compacts sources so span indexes never address a non-web chunk', () => {
    const resultSet = toWebSearchResultSet({
      webSearchQueries: ['q'],
      groundingChunks: [{}, { web: { uri: 'https://example.com/a', title: 'A' } }],
      groundingSupports: [
        { segment: { startIndex: 0, endIndex: byteLength(ANSWER) }, groundingChunkIndices: [1] },
      ],
    });

    expect(resultSet?.sources).toEqual([{ url: 'https://example.com/a', title: 'A' }]);
    expect(resolveWebSearchCitations(ANSWER, resultSet)[0].sources).toEqual([
      { url: 'https://example.com/a', title: 'A' },
    ]);
  });

  it('reports no result set when the model never searched', () => {
    expect(toWebSearchResultSet(undefined)).toBeNull();
    expect(toWebSearchResultSet({})).toBeNull();
  });
});

describe('Anthropic /v1/messages web search response', () => {
  it('emits the server tool blocks, citations and the search count', () => {
    const response = transformResponse(geminiResponse(), undefined, { webSearch: true });

    const [serverToolUse, toolResult, text] = response.content;
    expect(serverToolUse).toMatchObject({
      type: 'server_tool_use',
      name: 'web_search',
      input: { query: 'столица России' },
    });
    expect(toolResult).toMatchObject({
      type: 'web_search_tool_result',
      tool_use_id: (serverToolUse as { id: string }).id,
      content: [
        { type: 'web_search_result', url: 'https://example.com/moscow', title: 'Москва' },
        { type: 'web_search_result', url: 'https://example.com/weather', title: 'Погода' },
      ],
    });
    // `encrypted_content` / `page_age` are omitted rather than fabricated.
    expect(Object.keys((toolResult as { content: object[] }).content[0])).toEqual([
      'type',
      'url',
      'title',
    ]);

    expect(text).toMatchObject({ type: 'text', text: ANSWER });
    expect((text as { citations: unknown[] }).citations).toEqual([
      {
        type: 'web_search_result_location',
        url: 'https://example.com/moscow',
        title: 'Москва',
        cited_text: FIRST_SENTENCE,
      },
      {
        type: 'web_search_result_location',
        url: 'https://example.com/weather',
        title: 'Погода',
        cited_text: 'Погода сегодня ясная.',
      },
    ]);
    expect(response.usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });

  it('keeps rendering grounding as markdown for a caller that never asked for search', () => {
    const response = transformResponse(geminiResponse(), undefined, { webSearch: false });

    expect(response.content.some((block) => block.type === 'server_tool_use')).toBe(false);
    const rendered = response.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('');
    expect(rendered).toContain('🌐 Citations:');
    expect(response.usage.server_tool_use).toBeUndefined();
  });
});

describe('Anthropic streaming web search events', () => {
  function streamEvents(): string {
    const state = new StreamingState(undefined, 'gemini-3-flash', { webSearch: true });
    const processor = new PartProcessor(state);
    const chunks = [state.emitMessageStart({ responseId: 'msg_1' })];
    chunks.push(...processor.process({ text: ANSWER }));
    state.captureGrounding(grounding());
    chunks.push(...state.emitFinish('STOP', { promptTokenCount: 3, candidatesTokenCount: 4 }));
    return chunks.join('');
  }

  it('emits the search blocks and citation deltas once the stream ends', () => {
    const events = streamEvents();

    expect(events).toContain('"type":"server_tool_use"');
    expect(events).toContain('"type":"web_search_tool_result"');
    expect(events).toContain('"type":"citations_delta"');
    expect(events).toContain('"type":"web_search_result_location"');
    expect(events).toContain('"cited_text":"Москва — столица России."');
    expect(events).toContain('"server_tool_use":{"web_search_requests":1}');
    // The markdown block the ungrounded path renders must not also appear.
    expect(events).not.toContain('🌐 Citations:');
  });

  it('leaves the markdown grounding block in place when search was not requested', () => {
    const state = new StreamingState(undefined, 'gemini-3-flash');
    const processor = new PartProcessor(state);
    const chunks = [state.emitMessageStart({ responseId: 'msg_1' })];
    chunks.push(...processor.process({ text: ANSWER }));
    state.captureGrounding(grounding());
    chunks.push(...state.emitFinish('STOP', undefined));

    const events = chunks.join('');
    expect(events).toContain('🌐 Citations:');
    expect(events).not.toContain('"type":"server_tool_use"');
  });
});

describe('OpenAI url_citation annotations', () => {
  it('reports UTF-16 offsets into the returned text, not upstream byte offsets', () => {
    const annotations = buildOpenAIUrlCitationAnnotations(
      ANSWER,
      toWebSearchResultSet(grounding()),
    );

    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toEqual({
      type: 'url_citation',
      url_citation: {
        url: 'https://example.com/moscow',
        title: 'Москва',
        start_index: 0,
        end_index: FIRST_SENTENCE.length,
      },
    });
    const second = annotations[1].url_citation;
    expect(ANSWER.slice(second.start_index, second.end_index)).toBe('Погода сегодня ясная.');
    // The upstream numbers would have overrun the string entirely.
    expect(second.end_index).toBeLessThan(byteLength(ANSWER));
  });
});

describe('OpenAI /v1/responses web search output', () => {
  function chatResponse(): OpenAIChatResponse {
    const response: OpenAIChatResponse = {
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      created: 1,
      model: 'gemini-3-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: ANSWER,
            annotations: buildOpenAIUrlCitationAnnotations(
              ANSWER,
              toWebSearchResultSet(grounding()),
            ),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    return attachWebSearchResults(response, toWebSearchResultSet(grounding())!);
  }

  it('emits a web_search_call item ahead of the cited output_text', () => {
    const responses = toOpenAIResponsesResponse(chatResponse());
    const output = responses.output as Array<Record<string, unknown>>;

    expect(output[0]).toMatchObject({
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: 'столица России' },
    });
    const message = output[1] as { content: Array<{ annotations: unknown[]; type: string }> };
    expect(message.content[0].type).toBe('output_text');
    expect(message.content[0].annotations).toHaveLength(2);
  });

  it('streams the citations on the output_text part and appends the search item', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-flash',
      responseId: 'resp_1',
      webSearch: true,
    });
    const events = [mapper.createResponseCreatedEvent(), ...mapper.processPart({ text: ANSWER })];
    mapper.captureWebSearchGrounding(grounding());
    events.push(...mapper.complete('STOP'));

    const serialized = events.join('');
    expect(serialized).toContain('"type":"url_citation"');
    expect(serialized).toContain('"response.output_text.done"');
    expect(serialized).toContain('"type":"web_search_call"');
    expect(serialized).not.toContain('🌐 Citations:');
  });
});

describe('web search request contracts', () => {
  it('accepts web_search_options on Chat Completions and rejects what cannot be applied', () => {
    const request = normalizeOpenAIChatRequest({
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'who won?' }],
      web_search_options: {},
    });
    expect(request.web_search_options).toEqual({});

    for (const options of [
      { search_context_size: 'high' },
      { user_location: { type: 'approximate' } },
    ]) {
      expect(() =>
        normalizeOpenAIChatRequest({
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'who won?' }],
          web_search_options: options,
        }),
      ).toThrowError(expect.objectContaining({ code: 'unsupported_parameter' }));
    }
  });

  it.each(['web_search', 'web_search_preview', 'web_search_preview_2025_03_11'])(
    'accepts the Responses %s tool spelling',
    (type) => {
      expect(() =>
        normalizeOpenAIResponsesRequest({
          model: 'gemini-3-flash',
          input: 'who won?',
          tools: [{ type }],
        }),
      ).not.toThrow();
    },
  );

  it('rejects a hosted Responses tool the transport cannot serve', () => {
    expect(() =>
      normalizeOpenAIResponsesRequest({
        model: 'gemini-3-flash',
        input: 'who won?',
        tools: [{ type: 'file_search' }],
      }),
    ).toThrowError(expect.objectContaining({ param: 'tools.0.type' }));
  });
});
