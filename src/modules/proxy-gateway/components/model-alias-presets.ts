/**
 * Preset packs for the Model Mapping card.
 *
 * A pack is nothing but a shortcut for typing several alias rows by hand: every row it produces is
 * an ordinary, visible, editable, deletable alias. There is no hidden rule and no implicit routing.
 *
 * This module is intentionally pure and dependency-free so the renderer never pulls server-side
 * model tables into the bundle (commit fff3518 exists because it once did).
 */

export interface ModelAliasRow {
  alias: string;
  target: string;
  enabled: boolean;
}

export type ModelAliasPresetId = 'openai' | 'anthropic' | 'gemini';

export interface ModelAliasPreset {
  id: ModelAliasPresetId;
  /** Alias names clients of this family commonly hard-code. */
  aliases: readonly string[];
}

export const MODEL_ALIAS_PRESETS: readonly ModelAliasPreset[] = [
  {
    id: 'openai',
    aliases: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
  },
  {
    id: 'anthropic',
    aliases: [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
    ],
  },
  {
    id: 'gemini',
    aliases: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-pro', 'gemini-1.5-pro'],
  },
];

export function getModelAliasPreset(id: string): ModelAliasPreset | undefined {
  return MODEL_ALIAS_PRESETS.find((preset) => preset.id === id);
}

export interface ModelAliasPresetConflict {
  alias: string;
  /** Target of the row that already owns this alias; it is left untouched. */
  existingTarget: string;
}

export interface ModelAliasPresetPlan {
  presetId: ModelAliasPresetId;
  target: string;
  /** Rows that would be appended, in pack order. */
  additions: ModelAliasRow[];
  /** Aliases the pack skips because a row already claims them. */
  conflicts: ModelAliasPresetConflict[];
}

/**
 * Works out what applying `preset` at `target` would do, without changing anything.
 *
 * An empty target yields no additions: a pack is never applied to a guessed target.
 */
export function planModelAliasPreset(
  preset: ModelAliasPreset,
  target: string,
  existingRows: readonly ModelAliasRow[],
): ModelAliasPresetPlan {
  const normalizedTarget = target.trim();
  const existingByAlias = new Map<string, ModelAliasRow>();
  for (const row of existingRows) {
    const key = row.alias.trim().toLowerCase();
    if (key && !existingByAlias.has(key)) {
      existingByAlias.set(key, row);
    }
  }

  const additions: ModelAliasRow[] = [];
  const conflicts: ModelAliasPresetConflict[] = [];
  const planned = new Set<string>();

  for (const rawAlias of preset.aliases) {
    const alias = rawAlias.trim();
    const key = alias.toLowerCase();
    if (!alias || planned.has(key)) {
      continue;
    }
    planned.add(key);

    const existing = existingByAlias.get(key);
    if (existing) {
      conflicts.push({ alias, existingTarget: existing.target });
      continue;
    }
    if (!normalizedTarget) {
      continue;
    }
    additions.push({ alias, target: normalizedTarget, enabled: true });
  }

  return { presetId: preset.id, target: normalizedTarget, additions, conflicts };
}

/** Appends a plan's additions to the existing rows. Existing rows are never rewritten. */
export function applyModelAliasPresetPlan(
  existingRows: readonly ModelAliasRow[],
  plan: ModelAliasPresetPlan,
): ModelAliasRow[] {
  return [...existingRows, ...plan.additions.map((row) => ({ ...row }))];
}
