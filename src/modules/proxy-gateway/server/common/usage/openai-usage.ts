import type { GeminiUsageMetadata, OpenAIUsage } from '../interfaces/request-interfaces';
import {
  billedOutputTokensOf,
  cachedInputTokensOf,
  promptTokensOf,
  reasoningTokensOf,
} from './gemini-usage-metadata';

/**
 * Projects upstream usage onto OpenAI's Chat Completions shape.
 *
 * `completion_tokens_details.reasoning_tokens` is a breakdown *inside*
 * `completion_tokens`, not a quantity beside it, so `total_tokens` is computed
 * from our own two figures. An upstream total is deliberately ignored: it is
 * assembled under upstream's own rule, and adopting it is how the streamed path
 * came to report a total that did not equal the sum of its parts.
 */
export function toOpenAIUsageFromGeminiUsageMetadata(
  usage: GeminiUsageMetadata | undefined,
): OpenAIUsage {
  const promptTokens = promptTokensOf(usage);
  const completionTokens = billedOutputTokensOf(usage);
  const cachedTokens = cachedInputTokensOf(usage);
  const reasoningTokens = reasoningTokensOf(usage);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: cachedTokens > 0 ? { cached_tokens: cachedTokens } : undefined,
    completion_tokens_details:
      reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : undefined,
  };
}
