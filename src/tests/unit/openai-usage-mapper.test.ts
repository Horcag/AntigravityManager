import { describe, expect, it } from 'vitest';

import {
  toOpenAIResponsesUsage,
  toOpenAIUsage,
  toOpenAIUsageFromGeminiUsageMetadata,
} from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';

describe('toOpenAIUsage', () => {
  it('preserves totals while exposing cache and reasoning token details', () => {
    expect(
      toOpenAIUsage({
        input_tokens: 1200,
        output_tokens: 300,
        cache_read_input_tokens: 800,
        reasoning_tokens: 120,
      }),
    ).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 120 },
    });
  });

  it('omits optional details when upstream did not provide them', () => {
    expect(toOpenAIUsage({ input_tokens: 12, output_tokens: 4 })).toEqual({
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });

  it('uses Responses input/output usage field names', () => {
    expect(
      toOpenAIResponsesUsage({
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25,
        prompt_tokens_details: { cached_tokens: 15 },
      }),
    ).toEqual({
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
      input_tokens_details: { cached_tokens: 15 },
      output_tokens_details: undefined,
    });
  });

  it('adds Gemini legacy reasoning tokens to completion before summing totals', () => {
    expect(
      toOpenAIUsageFromGeminiUsageMetadata({
        cachedContentTokenCount: 11,
        candidatesTokenCount: 7,
        promptTokenCount: 19,
        thoughtsTokenCount: 5,
      }),
    ).toEqual({
      prompt_tokens: 19,
      completion_tokens: 12,
      total_tokens: 31,
      prompt_tokens_details: { cached_tokens: 11 },
      completion_tokens_details: { reasoning_tokens: 5 },
    });
  });

  it('adds tool-use tokens to completion when present', () => {
    expect(
      toOpenAIUsageFromGeminiUsageMetadata({
        candidatesTokenCount: 20,
        promptTokenCount: 7,
        thoughtsTokenCount: 8,
        total_tool_use_tokens: 5,
      }),
    ).toEqual({
      prompt_tokens: 7,
      completion_tokens: 33,
      total_tokens: 40,
      prompt_tokens_details: undefined,
      completion_tokens_details: { reasoning_tokens: 8 },
    });
  });

  it('adds native reasoning to completion for Interactions usage', () => {
    expect(
      toOpenAIUsageFromGeminiUsageMetadata({
        total_cached_tokens: 40,
        total_input_tokens: 100,
        total_output_tokens: 25,
        total_thought_tokens: 10,
        total_tokens: 135,
      }),
    ).toEqual({
      prompt_tokens: 100,
      completion_tokens: 35,
      total_tokens: 135,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
  });

  it('counts Gemini tool-use tokens as output tokens', () => {
    expect(
      toOpenAIUsageFromGeminiUsageMetadata({
        total_input_tokens: 7,
        total_output_tokens: 20,
        total_thought_tokens: 22,
        total_tool_use_tokens: 5,
        total_tokens: 54,
      }),
    ).toEqual({
      prompt_tokens: 7,
      completion_tokens: 47,
      total_tokens: 54,
      prompt_tokens_details: undefined,
      completion_tokens_details: { reasoning_tokens: 22 },
    });
  });

  it('computes OpenAI totals from prompt + completion even when vendor total is absent', () => {
    expect(
      toOpenAIUsageFromGeminiUsageMetadata({
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_tokens: 20,
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });

  it('computes OpenAI totals from prompt + completion even on legacy fields', () => {
    expect(
      toOpenAIUsageFromGeminiUsageMetadata({
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 18,
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });

  it('uses the same canonical accounting for openai.chat and openai.responses payloads', () => {
    const upstreamUsage = {
      promptTokenCount: 89,
      candidatesTokenCount: 26,
      thoughtsTokenCount: 170,
    };
    const openAIUsage = toOpenAIUsageFromGeminiUsageMetadata(upstreamUsage);

    expect(openAIUsage).toEqual({
      prompt_tokens: 89,
      completion_tokens: 196,
      total_tokens: 285,
      prompt_tokens_details: undefined,
      completion_tokens_details: { reasoning_tokens: 170 },
    });
    expect(toOpenAIResponsesUsage(openAIUsage)).toEqual({
      input_tokens: 89,
      output_tokens: 196,
      total_tokens: 285,
      input_tokens_details: undefined,
      output_tokens_details: { reasoning_tokens: 170 },
    });
  });

  it('picks one dialect name per quantity when a payload carries several aliases', () => {
    expect(
      toOpenAIUsageFromGeminiUsageMetadata({
        promptTokenCount: 30,
        candidatesTokenCount: 10,
        total_thought_tokens: 40,
        totalThoughtTokens: 40,
        thoughtsTokenCount: 40,
        cachedContentTokenCount: 6,
        cachedTokens: 6,
      }),
    ).toEqual({
      prompt_tokens: 30,
      completion_tokens: 50,
      total_tokens: 80,
      prompt_tokens_details: { cached_tokens: 6 },
      completion_tokens_details: { reasoning_tokens: 40 },
    });
  });
});
