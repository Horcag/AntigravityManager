import { describe, expect, it } from 'vitest';
import {
  MODEL_ALIAS_PRESETS,
  applyModelAliasPresetPlan,
  getModelAliasPreset,
  planModelAliasPreset,
  type ModelAliasRow,
} from '@/modules/proxy-gateway/components/model-alias-presets';

function preset(id: 'openai' | 'anthropic' | 'gemini') {
  const found = getModelAliasPreset(id);
  if (!found) {
    throw new Error(`missing preset ${id}`);
  }
  return found;
}

describe('MODEL_ALIAS_PRESETS', () => {
  it('ships the three packs clients commonly hard-code', () => {
    expect(MODEL_ALIAS_PRESETS.map((pack) => pack.id)).toEqual(['openai', 'anthropic', 'gemini']);
    expect(preset('openai').aliases).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
    ]);
    expect(preset('anthropic').aliases).toEqual([
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
    ]);
    expect(preset('gemini').aliases).toEqual([
      'gemini-2.0-flash',
      'gemini-2.5-pro',
      'gemini-pro',
      'gemini-1.5-pro',
    ]);
  });

  it('has no duplicate alias across a single pack', () => {
    for (const pack of MODEL_ALIAS_PRESETS) {
      const keys = pack.aliases.map((alias) => alias.toLowerCase());
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('planModelAliasPreset', () => {
  it('yields one enabled row per alias, all pointing at the chosen target', () => {
    const plan = planModelAliasPreset(preset('gemini'), 'gemini-3-flash', []);

    expect(plan.presetId).toBe('gemini');
    expect(plan.target).toBe('gemini-3-flash');
    expect(plan.conflicts).toEqual([]);
    expect(plan.additions).toEqual([
      { alias: 'gemini-2.0-flash', target: 'gemini-3-flash', enabled: true },
      { alias: 'gemini-2.5-pro', target: 'gemini-3-flash', enabled: true },
      { alias: 'gemini-pro', target: 'gemini-3-flash', enabled: true },
      { alias: 'gemini-1.5-pro', target: 'gemini-3-flash', enabled: true },
    ]);
  });

  it('reports existing aliases as conflicts instead of overwriting them', () => {
    const existing: ModelAliasRow[] = [
      { alias: 'GPT-4o', target: 'claude-sonnet-4-5', enabled: true },
      { alias: '  gpt-3.5-turbo  ', target: 'gemini-3-flash', enabled: false },
    ];

    const plan = planModelAliasPreset(preset('openai'), 'gemini-3-flash', existing);

    expect(plan.conflicts).toEqual([
      { alias: 'gpt-4o', existingTarget: 'claude-sonnet-4-5' },
      { alias: 'gpt-3.5-turbo', existingTarget: 'gemini-3-flash' },
    ]);
    expect(plan.additions.map((row) => row.alias)).toEqual(['gpt-4o-mini', 'gpt-4-turbo', 'gpt-4']);
  });

  it('adds nothing when no target has been picked, but still reports the collisions', () => {
    const existing: ModelAliasRow[] = [{ alias: 'gpt-4', target: 'gemini-3-flash', enabled: true }];

    const plan = planModelAliasPreset(preset('openai'), '   ', existing);

    expect(plan.target).toBe('');
    expect(plan.additions).toEqual([]);
    expect(plan.conflicts).toEqual([{ alias: 'gpt-4', existingTarget: 'gemini-3-flash' }]);
  });

  it('trims the chosen target', () => {
    const plan = planModelAliasPreset(preset('gemini'), '  gemini-3-flash ', []);

    expect(plan.target).toBe('gemini-3-flash');
    expect(plan.additions.every((row) => row.target === 'gemini-3-flash')).toBe(true);
  });
});

describe('applyModelAliasPresetPlan', () => {
  it('appends the additions and leaves every existing row untouched', () => {
    const existing: ModelAliasRow[] = [
      { alias: 'gpt-4o', target: 'claude-sonnet-4-5', enabled: false },
    ];
    const plan = planModelAliasPreset(preset('openai'), 'gemini-3-flash', existing);

    const next = applyModelAliasPresetPlan(existing, plan);

    expect(next).toHaveLength(5);
    expect(next[0]).toEqual({ alias: 'gpt-4o', target: 'claude-sonnet-4-5', enabled: false });
    expect(next.slice(1).map((row) => row.alias)).toEqual([
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
    ]);
    expect(existing).toHaveLength(1);
  });

  it('is a no-op when every alias in the pack already exists', () => {
    const existing: ModelAliasRow[] = preset('gemini').aliases.map((alias) => ({
      alias,
      target: 'gemini-3-flash',
      enabled: true,
    }));

    const plan = planModelAliasPreset(preset('gemini'), 'claude-sonnet-4-5', existing);

    expect(plan.additions).toEqual([]);
    expect(plan.conflicts).toHaveLength(4);
    expect(applyModelAliasPresetPlan(existing, plan)).toEqual(existing);
  });
});
