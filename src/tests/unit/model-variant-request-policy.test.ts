import { describe, expect, it } from 'vitest';
import {
  applyAnthropicModelVariant,
  applyOpenAIModelVariant,
  rebindAnthropicModelVariant,
  rebindOpenAIModelVariant,
} from '@/modules/proxy-gateway/server/modules/shared/services/model-variant-request.service';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

describe('applyAnthropicModelVariant', () => {
  it('applies Anthropic effort before forwarding a canonical Gemini request', () => {
    const request: AnthropicChatRequest = {
      model: 'gemini-3.1-pro',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 2048,
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
      },
      output_config: {
        effort: 'high',
      },
    };

    expect(applyAnthropicModelVariant(request)).toEqual({
      request: {
        model: 'gemini-3.1-pro',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 2048,
        thinking: {
          type: 'enabled',
          budget_tokens: 10001,
        },
        output_config: undefined,
      },
      variant: {
        canonicalModel: 'gemini-3.1-pro',
        model: 'gemini-pro-agent',
        tier: 'high',
        thinkingBudget: 10001,
        maxOutputTokens: 65535,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    });
    expect(request.model).toBe('gemini-3.1-pro');
  });

  it('preserves unverified Anthropic model capabilities for the upstream to decide', () => {
    const request: AnthropicChatRequest = {
      model: 'gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'Use the tool' }],
      tools: [
        {
          name: 'lookup',
          input_schema: {
            type: 'object',
          },
        },
      ],
      tool_choice: {
        type: 'tool',
        name: 'lookup',
      },
      thinking: {
        type: 'enabled',
        budget_tokens: 8192,
      },
    };

    expect(applyAnthropicModelVariant(request)).toEqual({ request, variant: null });
  });

  it('updates the complete Anthropic request when an account requires a different registered tier', () => {
    const applied = applyAnthropicModelVariant({
      model: 'gemini-3.1-pro',
      messages: [{ role: 'user', content: 'Hello' }],
      output_config: {
        effort: 'low',
      },
    });

    expect(rebindAnthropicModelVariant(applied, 'gemini-pro-agent').request).toEqual({
      model: 'gemini-pro-agent',
      messages: [{ role: 'user', content: 'Hello' }],
      output_config: undefined,
      max_tokens: 65535,
      thinking: {
        type: 'enabled',
        budget_tokens: 10001,
      },
      tools: undefined,
      tool_choice: undefined,
    });
  });

  it('preserves an explicit Anthropic disabled-thinking request and output cap', () => {
    const applied = applyAnthropicModelVariant({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Answer directly' }],
      max_tokens: 512,
      thinking: { type: 'disabled' },
    });

    expect(applied.request).toMatchObject({
      max_tokens: 512,
      thinking: { type: 'disabled' },
    });
    expect(rebindAnthropicModelVariant(applied, 'gemini-3-flash-agent').request).toMatchObject({
      max_tokens: 512,
      thinking: { type: 'disabled' },
    });
  });

  it('disables Anthropic thinking when max_tokens cannot satisfy Opus thinking minimum', () => {
    const applied = applyAnthropicModelVariant({
      model: 'claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 1024,
    });

    expect(applied.request).toMatchObject({
      model: 'claude-opus-4-6-thinking',
      max_tokens: 1024,
      thinking: { type: 'disabled' },
    });
    expect(applied.variant).toMatchObject({
      canonicalModel: 'claude-opus-4-6-thinking',
      model: 'claude-opus-4-6-thinking',
      thinkingBudget: 1024,
    });
  });

  it('preserves Anthropic thinking when Opus max_tokens is above minimum', () => {
    const applied = applyAnthropicModelVariant({
      model: 'claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 1025,
    });

    expect(applied.request).toMatchObject({
      model: 'claude-opus-4-6-thinking',
      max_tokens: 1025,
      thinking: {
        type: 'enabled',
        budget_tokens: 1024,
      },
    });
  });

  it('does not disable thinking for Sonnet at 8 tokens because minimum is not set in registry', () => {
    const applied = applyAnthropicModelVariant({
      model: 'claude-sonnet-4-6-thinking',
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 8,
    });

    expect(applied.request).toMatchObject({
      model: 'claude-sonnet-4-6-thinking',
      max_tokens: 8,
    });
    expect(applied.variant).toBeNull();
    expect(applied.request).not.toHaveProperty('thinking');
  });
});

describe('applyOpenAIModelVariant', () => {
  it('preserves unverified model capabilities for the upstream to decide', () => {
    const request: OpenAIChatRequest = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Use the tool' }],
      max_tokens: 4096,
      thinking: {
        type: 'enabled',
        budget_tokens: 12000,
      },
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
          },
        },
      ],
      tool_choice: 'required',
    };

    expect(applyOpenAIModelVariant(request)).toEqual({ request, variant: null });
  });

  it('lets an exact OpenAI reasoning_effort override the inferred budget tier', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3.5-flash',
      messages: [],
      reasoning_effort: 'medium',
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
      },
    });

    expect(applied.request).toMatchObject({
      model: 'gemini-3.5-flash',
      max_tokens: 65536,
      thinking: {
        budget_tokens: 4000,
      },
    });
  });

  it('does not let reasoning effort change an explicitly named tier', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3.5-flash-high',
      messages: [],
      reasoning_effort: 'low',
    });

    expect(applied.request).toMatchObject({
      model: 'gemini-3.5-flash-high',
      reasoning_effort: 'high',
      max_tokens: 65536,
      thinking: {
        budget_tokens: 10000,
      },
    });
    expect(applied.variant?.model).toBe('gemini-3-flash-agent');
  });

  it('preserves an explicit OpenAI disabled-thinking request across tier routing', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Answer directly' }],
      thinking: { type: 'disabled' },
    });

    expect(applied.request.thinking).toEqual({ type: 'disabled' });
    expect(rebindOpenAIModelVariant(applied, 'gemini-3-flash-agent').request.thinking).toEqual({
      type: 'disabled',
    });
  });

  it('updates the complete OpenAI request when an account requires another registered tier', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
      },
    });

    expect(rebindOpenAIModelVariant(applied, 'gemini-3-flash-agent').request).toEqual({
      model: 'gemini-3-flash-agent',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 65536,
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,
      },
      tools: undefined,
      tool_choice: undefined,
    });
  });

  it('disables OpenAI thinking when max_tokens cannot satisfy Opus thinking minimum', () => {
    const applied = applyOpenAIModelVariant({
      model: 'claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 1024,
    });

    expect(applied.request).toMatchObject({
      model: 'claude-opus-4-6-thinking',
      max_tokens: 1024,
      thinking: { type: 'disabled' },
    });
    expect(applied.variant).toMatchObject({
      canonicalModel: 'claude-opus-4-6-thinking',
      model: 'claude-opus-4-6-thinking',
      thinkingBudget: 1024,
    });
  });

  it('preserves OpenAI thinking when Opus max_tokens is above minimum', () => {
    const applied = applyOpenAIModelVariant({
      model: 'claude-opus-4-6-thinking',
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 1025,
    });

    expect(applied.request).toMatchObject({
      model: 'claude-opus-4-6-thinking',
      max_tokens: 1025,
      thinking: {
        type: 'enabled',
        budget_tokens: 1024,
      },
    });
    expect(applied.variant).toMatchObject({
      canonicalModel: 'claude-opus-4-6-thinking',
      model: 'claude-opus-4-6-thinking',
      thinkingBudget: 1024,
    });
  });
});
