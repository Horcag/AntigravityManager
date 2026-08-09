import type { Usage } from '../../../antigravity/types';
import type { GeminiUsageMetadata } from '../interfaces/request-interfaces';
import { billedOutputTokensOf, cachedInputTokensOf, promptTokensOf } from './gemini-usage-metadata';

/**
 * Projects upstream usage onto Anthropic's shape.
 *
 * Anthropic's usage object has no reasoning field of its own — thinking tokens
 * are billed inside `output_tokens` — so the proxy must not invent one. It used
 * to emit `reasoning_tokens` on the streamed path only, which both added a
 * field no Anthropic client knows and left its value out of the field that was
 * supposed to contain it.
 */
export function toAnthropicUsage(usage: GeminiUsageMetadata | undefined): Usage {
  return {
    input_tokens: promptTokensOf(usage),
    output_tokens: billedOutputTokensOf(usage),
    cache_read_input_tokens: cachedInputTokensOf(usage),
  };
}
