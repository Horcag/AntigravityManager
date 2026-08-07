const PUBLIC_MODEL_PRESET_DISPLAY_NAMES = {
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
  'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
  'claude-sonnet-4-6-thinking': 'Claude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
} as const;

const PUBLIC_MODEL_BY_DISPLAY_NAME = new Map(
  Object.entries(PUBLIC_MODEL_PRESET_DISPLAY_NAMES).map(([modelId, displayName]) => [
    displayName.toLowerCase(),
    modelId,
  ]),
);

export const PUBLIC_SUPPORTED_MODELS = [
  ...Object.keys(PUBLIC_MODEL_PRESET_DISPLAY_NAMES),
  'gemini-3-flash',
] as const;

export function getPublicModelIdForDisplayName(displayName: unknown): string | undefined {
  if (typeof displayName !== 'string') {
    return undefined;
  }

  const normalizedDisplayName = displayName.trim().toLowerCase();
  return normalizedDisplayName
    ? PUBLIC_MODEL_BY_DISPLAY_NAME.get(normalizedDisplayName)
    : undefined;
}
