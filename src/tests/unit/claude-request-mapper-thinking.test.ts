import { describe, expect, it, vi } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { applyAnthropicModelVariant } from '@/modules/proxy-gateway/server/modules/shared/services/model-variant-request.service';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/modules/shared/services/generation-constraints.service';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

type AnthropicPayloadCase = {
  model: string;
  maxTokens: number;
  expectedBudget: number | null;
  expectedMaxOutput: number | null;
  expectVariant: boolean;
};

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

function mapToFinalAnthropicPayload(model: string, maxTokens: number) {
  const applied = applyAnthropicModelVariant({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: 'Say OK' }],
  });
  const body = transformClaudeRequestIn(
    applied.request,
    undefined,
    undefined,
    applied.variant?.model ?? model,
  );

  const policy = new GenerationConstraintsService({
    getModelOutputLimitForAccount: vi.fn(),
    getModelThinkingBudgetForAccount: vi.fn(),
  });

  policy.applyInternalGenerationConstraints(
    body,
    body.model,
    'acc-1',
    applied.variant ?? undefined,
  );

  return {
    body,
    thinkingVariant: applied.variant,
  };
}

describe('ClaudeRequestMapper thinking support', () => {
  it.each(['gemini-3.1-pro-low', 'gemini-3-pro-low'])(
    'omits thinkingConfig for low-tier Gemini Pro variant %s',
    (model) => {
      const body = transformClaudeRequestIn(createThinkingRequest(model));

      expect(body.model).toBe(model);
      expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
    },
  );

  it.each(['gemini-3.1-pro-high', 'gemini-3-pro-high'])(
    'uses an explicitly selected physical route for high-tier Gemini Pro variant %s',
    (model) => {
      const body = transformClaudeRequestIn(
        createThinkingRequest(model),
        undefined,
        undefined,
        'gemini-pro-agent',
      );

      expect(body.model).toBe('gemini-pro-agent');
      expect(body.request.generationConfig?.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingBudget: 256,
      });
    },
  );

  it.each(['gemini-pro-agent', 'gemini-3-pro-agent', 'gemini-3-flash-agent'])(
    'enables thinking by default for Agent model %s',
    (model) => {
      const request = createThinkingRequest(model);
      delete request.thinking;

      const body = transformClaudeRequestIn(request);

      expect(body.model).toBe(model);
      expect(body.request.generationConfig?.thinkingConfig).toMatchObject({
        includeThoughts: true,
      });
    },
  );

  it.each<AnthropicPayloadCase>([
    {
      model: 'claude-opus-4-6-thinking',
      maxTokens: 8,
      expectedBudget: null,
      expectedMaxOutput: null,
      expectVariant: true,
    },
    {
      model: 'claude-opus-4-6-thinking',
      maxTokens: 1024,
      expectedBudget: null,
      expectedMaxOutput: null,
      expectVariant: true,
    },
    {
      model: 'claude-opus-4-6-thinking',
      maxTokens: 1025,
      expectedBudget: 1024,
      expectedMaxOutput: 1025,
      expectVariant: true,
    },
    {
      model: 'claude-sonnet-4-6-thinking',
      maxTokens: 8,
      expectedBudget: 32768,
      expectedMaxOutput: 64000,
      expectVariant: false,
    },
    {
      model: 'claude-sonnet-4-6-thinking',
      maxTokens: 1024,
      expectedBudget: 32768,
      expectedMaxOutput: 64000,
      expectVariant: false,
    },
    {
      model: 'claude-sonnet-4-6-thinking',
      maxTokens: 1025,
      expectedBudget: 32768,
      expectedMaxOutput: 64000,
      expectVariant: false,
    },
  ])(
    'maps final Anthropic payload for $model at max_tokens=$maxTokens',
    ({ model, maxTokens, expectedBudget, expectedMaxOutput, expectVariant }) => {
      const { body, thinkingVariant } = mapToFinalAnthropicPayload(model, maxTokens);
      const thinkingConfig = body.request.generationConfig?.thinkingConfig;
      if (expectedBudget === null || expectedMaxOutput === null) {
        expect(thinkingConfig).toBeUndefined();
      } else {
        expect(thinkingConfig).toBeDefined();
        expect(thinkingConfig).toMatchObject({
          includeThoughts: true,
          thinkingBudget: expectedBudget,
        });
        expect(body.request.generationConfig?.maxOutputTokens).toBe(expectedMaxOutput);
      }
      expect(thinkingVariant === null).toBe(!expectVariant);
    },
  );
});
