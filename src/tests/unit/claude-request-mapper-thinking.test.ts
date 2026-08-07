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

  it('sends caller stop sequences exactly without internal guards or deduplication', () => {
    const body = transformClaudeRequestIn({
      ...createThinkingRequest('gemini-3-flash'),
      stop_sequences: ['custom', '<|user|>', 'custom', '[DONE]', 'another'],
    });

    expect(body.request.generationConfig?.stopSequences).toEqual([
      'custom',
      '<|user|>',
      'custom',
      '[DONE]',
      'another',
    ]);
  });

  it('omits stopSequences when the caller does not provide them', () => {
    const body = transformClaudeRequestIn(createThinkingRequest('gemini-3-flash'));

    expect(body.request.generationConfig?.stopSequences).toBeUndefined();
  });

  it('preserves tool_use input exactly without mutating the caller request across repeated transforms', () => {
    const toolInput = {
      type: 'MARKDOWN',
      default: { format: 'uri', pattern: '^https://example\\.com$' },
      const: 'literal value',
      examples: [{ type: 'MARKDOWN', additionalProperties: false }],
      nested: {
        if: { required: ['type'] },
        not: { items: [{ format: 'email', pattern: '^admin@' }] },
        additionalProperties: { type: 'MARKDOWN' },
      },
      values: [null, false, 0, 'text', { required: ['literal'], items: ['unchanged'] }],
    };
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'inspect', input: toolInput }],
        },
      ],
      tools: [
        {
          name: 'inspect',
          input_schema: {
            type: 'object',
            properties: { mode: { type: 'STRING', default: 'standard' } },
          },
        },
      ],
    };
    const requestBeforeTransform = structuredClone(request);

    const firstBody = transformClaudeRequestIn(request);
    const secondBody = transformClaudeRequestIn(request);
    const firstArgs = firstBody.request.contents
      .flatMap((content) => content.parts)
      .find((part) => part.functionCall)?.functionCall?.args;
    const secondArgs = secondBody.request.contents
      .flatMap((content) => content.parts)
      .find((part) => part.functionCall)?.functionCall?.args;
    const parameters = firstBody.request.tools?.[0]?.functionDeclarations?.[0]?.parameters;

    expect(firstArgs).toBe(toolInput);
    expect(firstArgs).toEqual(toolInput);
    expect(secondArgs).toEqual(toolInput);
    expect(request).toEqual(requestBeforeTransform);
    expect(parameters).toMatchObject({
      type: 'object',
      properties: { mode: { type: 'string' } },
    });
    expect(
      (parameters?.properties as Record<string, Record<string, unknown>>).mode?.default,
    ).toBeUndefined();
  });

  it('preserves Anthropic text and maps interleaved tool-result media inside functionResponse', () => {
    const body = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '  (no content)  ' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'inspect',
              input: {},
              signature: 'tool-signature',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [
                { type: 'text', text: ' first ' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
                },
                { type: 'text', text: ' last ' },
              ],
            },
          ],
        },
      ],
    });

    expect(body.request.contents[0]?.parts).toEqual([{ text: '  (no content)  ' }]);
    expect(body.request.contents[2]?.parts[0]?.functionResponse).toEqual({
      name: 'inspect',
      id: 'tool_1',
      response: {
        result: [' first ', { $ref: 'tool_result_2_tool_1_image_0' }, ' last '],
      },
      parts: [
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            displayName: 'tool_result_2_tool_1_image_0',
          },
        },
      ],
    });
    expect(body.request.contents[2]?.parts[0]?.thoughtSignature).toBe('tool-signature');
  });

  it('maps image-only tool results to a single response reference', () => {
    const body = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'inspect', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(body.request.contents[1]?.parts[0]?.functionResponse).toMatchObject({
      response: { result: { $ref: 'tool_result_1_tool_1_image_0' } },
      parts: [
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            displayName: 'tool_result_1_tool_1_image_0',
          },
        },
      ],
    });
  });

  it('uses the error response key without fabricating success for empty tool results', () => {
    const body = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'inspect', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', is_error: true }],
        },
      ],
    });

    expect(body.request.contents[1]?.parts[0]?.functionResponse?.response).toEqual({
      error: '(no content)',
    });
  });

  it('fails closed when a direct mapper call has no matching tool_use name', () => {
    expect(() =>
      transformClaudeRequestIn({
        model: 'gemini-3-flash',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'unknown_tool', content: 'result' }],
          },
        ],
      }),
    ).toThrow('tool_result references unknown tool_use_id: unknown_tool');
  });
});
