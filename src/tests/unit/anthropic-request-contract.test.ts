import { describe, expect, it } from 'vitest';

import {
  AnthropicRequestValidationError,
  normalizeAnthropicCountTokensRequest,
  normalizeAnthropicMessagesRequest,
} from '@/modules/proxy-gateway/server/modules/anthropic/anthropic-request-contract';

const pngData = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]).toString('base64');

describe('Anthropic Messages request contract', () => {
  it('preserves ordered system, image, parallel tool, and tool-result blocks', () => {
    const request = {
      model: 'claude-opus-5',
      max_tokens: 2048,
      stop_sequences: ['DONE'],
      system: [
        { type: 'text', text: 'First instruction.' },
        { type: 'text', text: 'Second instruction.' },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Look up a value.',
          input_schema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
          },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect both values.' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: pngData },
            },
          ],
        },
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
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'B' },
            { type: 'text', text: 'Summarize.' },
          ],
        },
      ],
    };

    expect(normalizeAnthropicMessagesRequest(request)).toEqual(request);
  });

  it.each([
    [{ messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 }, 'model'],
    [{ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hello' }] }, 'max_tokens'],
    [{ model: 'claude-opus-5', max_tokens: 64, messages: [] }, 'messages'],
  ])('rejects missing required input at %s', (request, param) => {
    expect(() => normalizeAnthropicMessagesRequest(request)).toThrowError(
      expect.objectContaining<Partial<AnthropicRequestValidationError>>({
        name: 'AnthropicRequestValidationError',
        param,
      }),
    );
  });

  it('rejects a system message role because system is top-level in Messages', () => {
    expect(() =>
      normalizeAnthropicMessagesRequest({
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [{ role: 'system', content: 'Do this.' }],
      }),
    ).toThrowError(expect.objectContaining({ param: 'messages.0.role' }));
  });

  it('requires every parallel tool result before ordinary user content', () => {
    expect(() =>
      normalizeAnthropicMessagesRequest({
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'Look up both.' },
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
              { type: 'text', text: 'Here is one result.' },
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'A' },
            ],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ param: 'messages.2.content' }));
  });

  it('rejects duplicate tool-use ids across parallel calls', () => {
    expect(() =>
      normalizeAnthropicMessagesRequest({
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'Look up both.' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { key: 'a' } },
              { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { key: 'b' } },
            ],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ param: 'messages.1.content.1.id' }));
  });

  it('rejects image MIME declarations that do not match decoded bytes', () => {
    expect(() =>
      normalizeAnthropicMessagesRequest({
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: pngData },
              },
            ],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ param: 'messages.0.content.0.source.data' }));
  });

  it.each([
    [{ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, 'tools.0.type'],
    [{ output_config: { format: { type: 'json_schema', schema: {} } } }, 'output_config.format'],
    [
      {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'redacted_thinking', data: 'opaque-data' }],
          },
        ],
      },
      'messages.0.content.0.type',
    ],
  ])('fails closed for unsupported Anthropic semantics at %s', (extra, param) => {
    expect(() =>
      normalizeAnthropicMessagesRequest({
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
        ...extra,
      }),
    ).toThrowError(expect.objectContaining({ param }));
  });

  it('rejects disable_parallel_tool_use because Gemini cannot enforce it', () => {
    expect(() =>
      normalizeAnthropicMessagesRequest({
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      }),
    ).toThrowError(expect.objectContaining({ param: 'tool_choice.disable_parallel_tool_use' }));
  });

  it('rejects forced tool choice while thinking is enabled', () => {
    expect(() =>
      normalizeAnthropicMessagesRequest({
        model: 'claude-opus-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'enabled', budget_tokens: 2048 },
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'lookup' },
      }),
    ).toThrowError(expect.objectContaining({ param: 'tool_choice.type' }));
  });

  it('rejects unknown nested fields instead of silently dropping their semantics', () => {
    expect(() =>
      normalizeAnthropicMessagesRequest({
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hello', future_control: true }],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ param: 'messages.0.content.0.future_control' }));
  });

  it('requires a declared tool when tool_choice requests any tool', () => {
    expect(() =>
      normalizeAnthropicMessagesRequest({
        model: 'claude-opus-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
        tool_choice: { type: 'any' },
      }),
    ).toThrowError(expect.objectContaining({ param: 'tool_choice.type' }));
  });
});

describe('Anthropic count_tokens request contract', () => {
  it('accepts the counting subset without the generation-only fields', () => {
    expect(
      normalizeAnthropicCountTokensRequest({
        model: 'claude-opus-5',
        system: 'Be terse.',
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'lookup' },
        messages: [{ role: 'user', content: 'How many tokens?' }],
      }),
    ).toEqual({
      model: 'claude-opus-5',
      system: 'Be terse.',
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'lookup' },
      messages: [{ role: 'user', content: 'How many tokens?' }],
    });
  });

  it.each(['max_tokens', 'stream', 'temperature'])(
    'rejects the generation-only field %s',
    (field) => {
      expect(() =>
        normalizeAnthropicCountTokensRequest({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'hello' }],
          [field]: field === 'stream' ? true : 64,
        }),
      ).toThrowError(expect.objectContaining({ param: field, code: 'unsupported_parameter' }));
    },
  );

  it('applies the same block validation as the Messages contract', () => {
    expect(() =>
      normalizeAnthropicCountTokensRequest({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', future_control: true }] }],
      }),
    ).toThrowError(expect.objectContaining({ param: 'messages.0.content.0.future_control' }));
  });

  it('requires a model and a non-empty message list', () => {
    expect(() =>
      normalizeAnthropicCountTokensRequest({ messages: [{ role: 'user', content: 'hi' }] }),
    ).toThrowError(expect.objectContaining({ param: 'model' }));
    expect(() =>
      normalizeAnthropicCountTokensRequest({ model: 'claude-opus-5', messages: [] }),
    ).toThrowError(expect.objectContaining({ param: 'messages' }));
  });
});
