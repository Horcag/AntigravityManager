import type { GeminiUsageMetadata } from '../interfaces/request-interfaces';

/**
 * Field selection for the upstream usage block, shared by every surface.
 *
 * Upstream reports the same quantity under two dialects — the legacy Gemini
 * names (`candidatesTokenCount`, `thoughtsTokenCount`) and the Interactions
 * names (`total_output_tokens`, `total_thought_tokens`) — so each getter picks
 * the first name that is present rather than adding them together. Summing
 * aliases would double a payload that happens to carry both, and these numbers
 * are what clients bill against.
 */
function firstPresent(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (value !== undefined) {
      return Math.max(0, value);
    }
  }

  return 0;
}

export function promptTokensOf(usage: GeminiUsageMetadata | undefined): number {
  return firstPresent(usage?.total_input_tokens, usage?.promptTokenCount);
}

/**
 * Generated answer tokens only. Thought and tool-use tokens are reported
 * separately by upstream and are *not* part of this figure — measured against
 * the native surface, where `promptTokenCount + candidatesTokenCount +
 * thoughtsTokenCount` equals `totalTokenCount` exactly.
 */
export function generatedOutputTokensOf(usage: GeminiUsageMetadata | undefined): number {
  return firstPresent(usage?.total_output_tokens, usage?.candidatesTokenCount);
}

export function reasoningTokensOf(usage: GeminiUsageMetadata | undefined): number {
  return firstPresent(
    usage?.total_thought_tokens,
    usage?.totalThoughtTokens,
    usage?.thoughtsTokenCount,
  );
}

export function toolUseTokensOf(usage: GeminiUsageMetadata | undefined): number {
  return firstPresent(usage?.total_tool_use_tokens);
}

export function cachedInputTokensOf(usage: GeminiUsageMetadata | undefined): number {
  return firstPresent(
    usage?.total_cached_tokens,
    usage?.cachedContentTokenCount,
    usage?.cachedTokens,
  );
}

/**
 * Everything the model produced. Both OpenAI and Anthropic count reasoning
 * inside their single output figure, so this is the value both surfaces bill.
 */
export function billedOutputTokensOf(usage: GeminiUsageMetadata | undefined): number {
  return generatedOutputTokensOf(usage) + reasoningTokensOf(usage) + toolUseTokensOf(usage);
}
