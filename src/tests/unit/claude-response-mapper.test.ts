import { describe, expect, it } from 'vitest';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import { ToolCallIdConflictError } from '@/modules/proxy-gateway/antigravity/tool-call-id-integrity';

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

  it('includes reasoning tokens in Anthropic non-stream output usage', () => {
    const response = transformResponse({
      candidates: [{ content: { role: 'model', parts: [{ text: 'result' }] } }],
      usageMetadata: {
        candidatesTokenCount: 3,
        promptTokenCount: 2,
        thoughtsTokenCount: 4,
      },
    });

    expect(response.usage).toMatchObject({ input_tokens: 2, output_tokens: 7 });
  });

  it('emits an explicit tool call only once when its exact payload is replayed', () => {
    const response = transformResponse({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { functionCall: { args: { query: 'status' }, id: 'call_1', name: 'lookup' } },
              { functionCall: { args: { query: 'status' }, id: 'call_1', name: 'lookup' } },
            ],
          },
        },
      ],
    });

    expect(response.content.filter((block) => block.type === 'tool_use')).toHaveLength(1);
  });

  it('rejects conflicting reuse of an explicit tool call id', () => {
    expect(() =>
      transformResponse({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { args: { query: 'status' }, id: 'call_1', name: 'lookup' } },
                { functionCall: { args: { query: 'other' }, id: 'call_1', name: 'lookup' } },
              ],
            },
          },
        ],
      }),
    ).toThrow(ToolCallIdConflictError);
  });

  it('emits distinct generated ids for tool calls without upstream ids', () => {
    const response = transformResponse({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { functionCall: { args: { query: 'status' }, name: 'lookup' } },
              { functionCall: { args: { query: 'status' }, name: 'lookup' } },
            ],
          },
        },
      ],
    });
    const toolUses = response.content.filter((block) => block.type === 'tool_use');

    expect(toolUses).toHaveLength(2);
    expect(toolUses[0].id).not.toBe(toolUses[1].id);
  });
});
