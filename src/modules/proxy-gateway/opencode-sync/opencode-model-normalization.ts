const OPEN_CODE_MODEL_NAMES: Readonly<Record<string, string>> = {
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
};

export function canonicalizeOpenCodeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export function getOpenCodeModelDisplayName(modelId: string, fallbackName: string): string {
  return OPEN_CODE_MODEL_NAMES[canonicalizeOpenCodeModelId(modelId)] ?? fallbackName;
}
