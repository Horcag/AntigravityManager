import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';

const pngData = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]).toString('base64');

describe('Anthropic request mapper fidelity', () => {
  it('keeps caller stop sequences off the wire so the fired one stays reportable', () => {
    const result = transformClaudeRequestIn(
      {
        model: 'gemini-3-flash',
        max_tokens: 64,
        stop_sequences: ['CUSTOM_STOP', 'SECOND_STOP'],
        messages: [{ role: 'user', content: 'hello' }],
      },
      'project-1',
      'test-agent',
      'gemini-3-flash',
    );

    // The provider strips the matched sequence and reports the same finish
    // reason as a natural ending, so forwarding these would make
    // `stop_reason: "stop_sequence"` unreportable. `ClaudeResponseMapper` cuts
    // the answer instead. No proxy sentinel is substituted either.
    expect(result.request.generationConfig?.stopSequences).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('CUSTOM_STOP');
  });

  it('preserves parallel tool calls and maps successful and failed results distinctly', () => {
    const result = transformClaudeRequestIn(
      {
        model: 'gemini-3-flash',
        max_tokens: 64,
        thinking: { type: 'disabled' },
        messages: [
          { role: 'user', content: 'Run both.' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { key: 'a' } },
              { type: 'tool_use', id: 'toolu_2', name: 'lookup', input: { key: 'b' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'A' },
              {
                type: 'tool_result',
                tool_use_id: 'toolu_2',
                content: [
                  { type: 'text', text: 'Lookup failed.' },
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: pngData },
                  },
                ],
                is_error: true,
              },
            ],
          },
        ],
      },
      'project-1',
      'test-agent',
      'gemini-3-flash',
    );

    expect(result.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Run both.' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { args: { key: 'a' }, id: 'toolu_1', name: 'lookup' } },
          { functionCall: { args: { key: 'b' }, id: 'toolu_2', name: 'lookup' } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'toolu_1',
              name: 'lookup',
              response: { result: 'A' },
            },
          },
          {
            functionResponse: {
              id: 'toolu_2',
              name: 'lookup',
              response: { error: 'Lookup failed.' },
            },
          },
          { inlineData: { data: pngData, mimeType: 'image/png' } },
        ],
      },
    ]);
  });

  it('does not inject hidden stop sequences when the caller omitted them', () => {
    const result = transformClaudeRequestIn(
      {
        model: 'gemini-3-flash',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      },
      'project-1',
      'test-agent',
      'gemini-3-flash',
    );

    expect(result.request.generationConfig?.stopSequences).toBeUndefined();
  });
});
