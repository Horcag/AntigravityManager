/**
 * Model-name predicates the Claude→Gemini request mapping branches on.
 *
 * These are name-shape tests rather than catalog lookups on purpose: the
 * mapping runs before any capability metadata is available for the resolved
 * model, and the provider only publishes the model id at that point.
 */

export function isGeminiImageModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith('gemini-3-pro-image') ||
    normalized.startsWith('gemini-3.1-pro-image') ||
    normalized.startsWith('gemini-3-flash-image') ||
    normalized.startsWith('gemini-3.1-flash-image')
  );
}

export function isGeminiFlashModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.includes('gemini') && normalized.includes('flash');
}

export function isGeminiAgentThinkingModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.includes('gemini') &&
    !normalized.includes('claude') &&
    (normalized.includes('gemini-pro') ||
      normalized.includes('-pro-agent') ||
      normalized.includes('-flash-agent'))
  );
}

export function isClaudeModel(modelName: string): boolean {
  return modelName.toLowerCase().includes('claude');
}

export function targetModelSupportsThinking(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  const isTieredGeminiPro = /^gemini-3(?:\.1)?-pro-(high|low)$/.test(normalized);
  const isUntieredGeminiPro =
    (normalized.includes('gemini-3-pro') || normalized.includes('gemini-3.1-pro')) &&
    !isTieredGeminiPro &&
    !isGeminiImageModel(normalized);

  return (
    normalized.includes('-thinking') ||
    isClaudeModel(normalized) ||
    normalized.includes('gemini-2.0-pro') ||
    isUntieredGeminiPro ||
    isGeminiAgentThinkingModel(normalized) ||
    isGeminiFlashModel(normalized)
  );
}

export function shouldEnableThinkingByDefault(mappedModel: string, originalModel: string): boolean {
  const mappedLower = mappedModel.toLowerCase();
  const originalLower = originalModel.toLowerCase();
  return (
    originalLower.includes('claude-opus-4-5') ||
    originalLower.includes('claude-opus-4-6') ||
    mappedLower.includes('-thinking') ||
    mappedLower.includes('gemini-3.1-pro') ||
    isGeminiAgentThinkingModel(mappedLower) ||
    mappedLower.includes('gemini-3-flash') ||
    mappedLower.includes('gemini-3.1-flash')
  );
}
