import { describe, expect, it } from 'vitest';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';

describe('ClaudeResponseMapper termination reasons', () => {
  it.each([
    ['STOP', 'end_turn'],
    ['MAX_TOKENS', 'max_tokens'],
    ['SAFETY', 'refusal'],
    ['RECITATION', 'refusal'],
  ])('maps Gemini %s to the valid Anthropic stop reason %s', (finishReason, stopReason) => {
    const response = transformResponse({
      candidates: [{ content: { role: 'model', parts: [{ text: 'result' }] }, finishReason }],
    });

    expect(response.stop_reason).toBe(stopReason);
  });

  it('keeps tool_use precedence over a safety finish reason', () => {
    const response = transformResponse({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: { query: 'status' } } }],
          },
          finishReason: 'SAFETY',
        },
      ],
    });

    expect(response.stop_reason).toBe('tool_use');
  });
});
