import { describe, expect, it } from 'vitest';

import {
  normalizeOpenAIChatRequest,
  normalizeOpenAICompletionRequest,
  OpenAIRequestValidationError,
} from '@/modules/proxy-gateway/server/modules/openai/chat/openai-request-contract';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';

describe('OpenAI request contract', () => {
  it('uses OpenAI sampling defaults when the client omits them', () => {
    const body = transformClaudeRequestIn({
      model: 'custom-model',
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { source: 'openai' },
    });

    expect(body.request.generationConfig).toMatchObject({ temperature: 1, topP: 1 });
  });

  it('maps OpenAI candidate, stop, structured-output, and logprobs controls to Gemini', () => {
    const body = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'return json' }],
      max_tokens: 256,
      candidate_count: 3,
      stop_sequences: ['DONE'],
      temperature: 0.3,
      top_p: 0.8,
      presence_penalty: 0.2,
      frequency_penalty: -0.1,
      seed: 42,
      response_format: {
        type: 'json_schema',
        json_schema: {
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
          },
        },
      },
      response_logprobs: true,
      top_logprobs: 4,
      metadata: { source: 'openai' },
    });

    expect(body.request.generationConfig).toMatchObject({
      maxOutputTokens: 256,
      candidateCount: 3,
      stopSequences: ['DONE'],
      temperature: 0.3,
      topP: 0.8,
      presencePenalty: 0.2,
      frequencyPenalty: -0.1,
      seed: 42,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
      responseLogprobs: true,
      logprobs: 4,
    });
  });

  it('normalizes supported Chat Completions parameters without dropping semantics', () => {
    const request = normalizeOpenAIChatRequest({
      model: ' gemini-3-flash ',
      messages: [{ role: 'user', content: 'hello' }],
      n: 2,
      max_completion_tokens: 512,
      stop: 'DONE',
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
      logprobs: false,
      store: false,
      service_tier: 'default',
    });

    expect(request).toMatchObject({
      model: 'gemini-3-flash',
      n: 2,
      max_tokens: 512,
      stop: ['DONE'],
      stream_options: { include_usage: true },
    });
  });

  it.each([
    ['n', { n: 0 }],
    ['stop', { stop: ['1', '2', '3', '4', '5'] }],
    ['top_logprobs', { top_logprobs: 2 }],
    ['logprobs', { stream: true, logprobs: true }],
    ['parallel_tool_calls', { tools: [{ type: 'function' }], parallel_tool_calls: false }],
    ['logit_bias', { logit_bias: { '42': 1 } }],
    ['store', { store: true }],
    ['service_tier', { service_tier: 'priority' }],
    ['reasoning_effort', { reasoning_effort: 'minimal' }],
    [
      'stream_options.include_obfuscation',
      { stream: true, stream_options: { include_obfuscation: true } },
    ],
    ['unknown_control', { unknown_control: true }],
  ])('rejects unsupported or invalid Chat parameter %s explicitly', (param, extra) => {
    expect(() =>
      normalizeOpenAIChatRequest({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        ...extra,
      } as any),
    ).toThrowError(
      expect.objectContaining<Partial<OpenAIRequestValidationError>>({
        name: 'OpenAIRequestValidationError',
        param,
      }),
    );
  });

  it('requires a named JSON schema for structured output', () => {
    expect(() =>
      normalizeOpenAIChatRequest({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        response_format: {
          type: 'json_schema',
          json_schema: { schema: { type: 'object' } },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<OpenAIRequestValidationError>>({
        param: 'response_format.json_schema.name',
        code: 'missing_required_parameter',
      }),
    );
  });

  it('does not reject controls based on stale hard-coded capability guesses', () => {
    expect(() =>
      normalizeOpenAIChatRequest({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'use a tool' }],
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', parameters: { type: 'object' } },
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      normalizeOpenAIChatRequest({
        model: 'gemini-3.1-flash-lite',
        messages: [{ role: 'user', content: 'think' }],
        reasoning_effort: 'high',
      }),
    ).not.toThrow();
  });

  it('accepts inline images but rejects silently downgraded remote image URLs', () => {
    expect(
      normalizeOpenAIChatRequest({
        model: 'gemini-3-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe it' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      }),
    ).toBeDefined();

    expect(() =>
      normalizeOpenAIChatRequest({
        model: 'gemini-3-flash',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/image.png' },
              },
            ],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        param: 'messages.0.content.0.image_url.url',
        code: 'unsupported_parameter',
      }),
    );
  });

  it('normalizes the honestly supported legacy Completions subset', () => {
    const normalized = normalizeOpenAICompletionRequest({
      model: 'gemini-3-flash',
      prompt: ['hello'],
      n: 2,
      max_tokens: 64,
      stop: ['END'],
      stream: true,
      stream_options: { include_usage: true },
      best_of: 1,
      echo: false,
    });

    expect(normalized.prompt).toBe('hello');
    expect(normalized.request).toMatchObject({
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'hello' }],
      n: 2,
      max_tokens: 64,
      stop: ['END'],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it.each([
    ['prompt', {}],
    ['prompt', { prompt: ['one', 'two'] }],
    ['prompt', { prompt: [1, 2, 3] }],
    ['best_of', { prompt: 'hello', best_of: 2 }],
    ['echo', { prompt: 'hello', echo: true }],
    ['suffix', { prompt: 'hello', suffix: 'tail' }],
    ['logprobs', { prompt: 'hello', logprobs: 2 }],
    ['max_completion_tokens', { prompt: 'hello', max_completion_tokens: 2 }],
  ])('rejects unrepresentable legacy parameter %s', (param, extra) => {
    expect(() =>
      normalizeOpenAICompletionRequest({ model: 'gemini-3-flash', ...extra } as any),
    ).toThrowError(expect.objectContaining({ param, type: 'invalid_request_error' }));
  });
});
