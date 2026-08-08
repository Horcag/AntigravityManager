import { describe, expect, it } from 'vitest';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import { StreamingState } from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import type { GeminiResponse, TextBlock } from '@/modules/proxy-gateway/antigravity/types';

const ANSWER = 'Москва — столица России. Погода сегодня ясная.';
const FIRST_SENTENCE = 'Москва — столица России.';

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function groundedResponse(): GeminiResponse {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: ANSWER }] },
        groundingMetadata: {
          webSearchQueries: ['погода в Москве'],
          groundingChunks: [
            { web: { title: 'Источник A', uri: 'https://example.com/a' } },
            { web: { title: 'Источник B', uri: 'https://example.com/b' } },
          ],
          groundingSupports: [
            {
              segment: { startIndex: 0, endIndex: byteLength(FIRST_SENTENCE) },
              groundingChunkIndices: [0],
            },
            {
              segment: { startIndex: byteLength(FIRST_SENTENCE), endIndex: byteLength(ANSWER) },
              groundingChunkIndices: [1, 0],
            },
          ],
        },
      },
    ],
  } as unknown as GeminiResponse;
}

describe('non-streaming grounding', () => {
  it('splices inline citation markers into a Cyrillic answer without corrupting it', () => {
    const response = transformResponse(groundedResponse());
    const text = response.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    expect(text).toContain('Москва — столица России.[1] Погода сегодня ясная.[2][1]');
    expect(text).not.toContain('�');
  });

  it('keeps the trailing source list alongside the inline markers', () => {
    const response = transformResponse(groundedResponse());
    const text = response.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    expect(text).toContain('**🔍 Searched for you:** погода в Москве');
    expect(text).toContain('[1] [Источник A](https://example.com/a)');
    expect(text).toContain('[2] [Источник B](https://example.com/b)');
  });

  it('emits only the trailing list when the provider reported no supports', () => {
    const response = transformResponse({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: ANSWER }] },
          groundingMetadata: {
            groundingChunks: [{ web: { title: 'Источник A', uri: 'https://example.com/a' } }],
          },
        },
      ],
    } as unknown as GeminiResponse);

    const text = response.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    expect(text).toContain(ANSWER);
    expect(text).not.toContain(`${FIRST_SENTENCE}[1]`);
    expect(text).toContain('[1] [Источник A](https://example.com/a)');
  });
});

describe('streamed grounding capture', () => {
  it('collects grounding from the SSE frames that carry it', () => {
    const state = new StreamingState(undefined, 'gemini-3-pro');
    state.captureGrounding({ webSearchQueries: ['погода в Москве'] });
    state.captureGrounding({
      webSearchQueries: ['погода в Москве'],
      groundingChunks: [{ web: { title: 'Источник A', uri: 'https://example.com/a' } }],
    });

    const output = state.emitFinish('STOP').join('');

    expect(state.webSearchQuery).toBe('погода в Москве');
    expect(output).toContain('Searched for you');
    expect(output).toContain('https://example.com/a');
  });

  it('is inert when a response carried no grounding', () => {
    const state = new StreamingState(undefined, 'gemini-3-pro');
    state.captureGrounding(undefined);

    expect(state.webSearchQuery).toBeNull();
    expect(state.groundingChunks).toBeNull();
    expect(state.emitFinish('STOP').join('')).not.toContain('Searched for you');
  });
});
