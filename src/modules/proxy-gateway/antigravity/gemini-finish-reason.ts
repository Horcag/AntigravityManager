export type OpenAIFinishReason = 'stop' | 'length' | 'content_filter';
export type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'refusal';

/**
 * Converts Gemini terminal states into the limited terminal enums exposed by downstream APIs.
 * Unknown non-empty values fail closed because forwarding them would violate both wire contracts.
 */
export function mapGeminiFinishReasonToOpenAI(
  finishReason?: string | null,
): OpenAIFinishReason | null {
  if (!finishReason) {
    return null;
  }

  switch (finishReason.toUpperCase()) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    default:
      return 'content_filter';
  }
}

export function mapGeminiFinishReasonToAnthropic(
  finishReason?: string | null,
): AnthropicStopReason {
  if (!finishReason) {
    return 'end_turn';
  }

  switch (finishReason.toUpperCase()) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    default:
      return 'refusal';
  }
}
