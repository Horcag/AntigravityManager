export function toOpenAIResponsesIncompleteReason(
  finishReason: string | null | undefined,
): string | null {
  const normalized = finishReason?.trim().toUpperCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized === 'MAX_TOKENS' ||
    normalized === 'MAX_OUTPUT_TOKENS' ||
    normalized === 'LENGTH'
  ) {
    return 'max_output_tokens';
  }
  if (
    normalized === 'CONTENT_FILTER' ||
    normalized === 'SAFETY' ||
    normalized === 'RECITATION' ||
    normalized === 'BLOCKLIST' ||
    normalized === 'PROHIBITED_CONTENT' ||
    normalized === 'SPII'
  ) {
    return 'content_filter';
  }
  return null;
}
