import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

function createThinkingRequest(model: string): ClaudeRequest {
  return {
    model,
    max_tokens: 1024,
    thinking: {
      type: 'enabled',
      budget_tokens: 256,
    },
    messages: [
      {
        role: 'user',
        content: 'Explain the fix.',
      },
    ],
  };
}

describe('ClaudeRequestMapper thinking support', () => {
  it.each([
    ['gemini-3-flash', true],
    ['gemini-3.1-flash', true],
    ['gemini-3.6-flash-high', true],
    ['models/gemini-3.6-flash-high', true],
    ['gemini-3.6-flash-image', false],
    ['other-gemini-3.6-flash-high', false],
  ])('configures thinking for Gemini 3 Flash family model %s: %s', (model, supportsThinking) => {
    const body = transformClaudeRequestIn(createThinkingRequest(model));

    expect(Boolean(body.request.generationConfig?.thinkingConfig)).toBe(supportsThinking);
  });

  it.each(['gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'gemini-3-pro-high', 'gemini-3-pro-low'])(
    'omits thinkingConfig for tiered Gemini Pro variant %s',
    (model) => {
      const body = transformClaudeRequestIn(createThinkingRequest(model));

      expect(body.model).toBe(model);
      expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
    },
  );

  it('keeps caller stop sequences first, deduplicates them, and reserves only remaining capacity for guards', () => {
    const body = transformClaudeRequestIn({
      ...createThinkingRequest('gemini-3-flash'),
      stop_sequences: ['custom', '<|user|>', 'custom', '[DONE]', 'another'],
    });

    expect(body.request.generationConfig?.stopSequences).toEqual([
      'custom',
      '<|user|>',
      '[DONE]',
      'another',
      '<|endoftext|>',
    ]);
  });

  it('does not truncate five distinct caller stop sequences to add internal guards', () => {
    const body = transformClaudeRequestIn({
      ...createThinkingRequest('gemini-3-flash'),
      stop_sequences: ['one', 'two', 'three', 'four', 'five'],
    });

    expect(body.request.generationConfig?.stopSequences).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
  });
});
