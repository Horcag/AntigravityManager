import type { SafetySetting } from './types';

/**
 * Safety settings sent with every Claude→Gemini request, plus the per-model
 * families that reject one or more of them.
 */
const SAFETY_SETTINGS: SafetySetting[] = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
];

type SafetyCategory = SafetySetting['category'];

interface ModelSafetyOverride {
  modelFamilyMatcher: RegExp;
  omittedSafetyCategories: readonly SafetyCategory[];
}

export const MODEL_FAMILY_SAFETY_OVERRIDES: readonly ModelSafetyOverride[] = [
  {
    // 2026-08-08 (live): Unrecognized safety category error: INVALID_ARGUMENT: Unknown safety category: HARM_CATEGORY_CIVIC_INTEGRITY.
    modelFamilyMatcher: /^gemini-2\.5-flash/,
    omittedSafetyCategories: ['HARM_CATEGORY_CIVIC_INTEGRITY'],
  },
  {
    // 2026-08-08 (live): Unrecognized safety category error: INVALID_ARGUMENT: Unknown safety category: HARM_CATEGORY_CIVIC_INTEGRITY.
    modelFamilyMatcher: /^gemini-3\.1-flash-lite$/,
    omittedSafetyCategories: ['HARM_CATEGORY_CIVIC_INTEGRITY'],
  },
  {
    // 2026-08-08 (live): Non-Gemini model does not accept Gemini safety settings; route parity now preserves this by sending no safetySettings.
    modelFamilyMatcher: /^gpt-oss-120b-medium$/,
    omittedSafetyCategories: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_CIVIC_INTEGRITY',
    ],
  },
];

function normalizeModelForSafetySettings(model: string): string {
  return model
    .toLowerCase()
    .trim()
    .replace(/^models\//i, '');
}

export function resolveSafetySettings(model: string): SafetySetting[] {
  const normalizedModel = normalizeModelForSafetySettings(model);
  const override = MODEL_FAMILY_SAFETY_OVERRIDES.find((rule) =>
    rule.modelFamilyMatcher.test(normalizedModel),
  );

  if (!override) {
    return [...SAFETY_SETTINGS];
  }

  if (override.omittedSafetyCategories.length === 0) {
    return [];
  }

  const omitted = new Set(override.omittedSafetyCategories);
  return SAFETY_SETTINGS.filter((setting) => !omitted.has(setting.category));
}
