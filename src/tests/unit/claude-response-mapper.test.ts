import { describe, expect, it } from 'vitest';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';

describe('ClaudeResponseMapper termination reasons', () => {
  it.each([
    ['sToP', 'end_turn'],
    ['mAx_ToKeNs', 'max_tokens'],
    ['BLOCKLIST', 'refusal'],
    ['MALFORMED_FUNCTION_CALL', 'refusal'],
    ['IMAGE_SAFETY', 'refusal'],
    ['FUTURE_GEMINI_REASON', 'refusal'],
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

  it('serializes the required non-stream stop_sequence key as null', () => {
    const response = transformResponse({
      candidates: [
        { content: { role: 'model', parts: [{ text: 'result' }] }, finishReason: 'STOP' },
      ],
    });

    expect(response).toMatchObject({ stop_sequence: null });
    expect(Object.hasOwn(response, 'stop_sequence')).toBe(true);
  });
});
