import { describe, expect, it } from 'vitest';
import type { ModelAliasRow } from '@/modules/proxy-gateway/components/model-alias-presets';
import {
  MODEL_ALIAS_EXPORT_FORMAT,
  MODEL_ALIAS_EXPORT_VERSION,
  applyModelAliasImportPlan,
  buildModelAliasExport,
  planModelAliasImport,
  serializeModelAliasExport,
} from '@/modules/proxy-gateway/components/model-alias-transfer';

const EXPORTED_AT = '2026-08-08T10:00:00.000Z';

const ROWS: ModelAliasRow[] = [
  { alias: 'gpt-4o', target: 'gemini-3-flash', enabled: true },
  { alias: '  claude-3-5-sonnet-20241022  ', target: '  claude-sonnet-4-5 ', enabled: false },
];

describe('buildModelAliasExport', () => {
  it('writes the alias rows under a versioned envelope and nothing else', () => {
    const file = buildModelAliasExport(ROWS, EXPORTED_AT);

    expect(file).toEqual({
      format: MODEL_ALIAS_EXPORT_FORMAT,
      version: MODEL_ALIAS_EXPORT_VERSION,
      exported_at: EXPORTED_AT,
      aliases: [
        { alias: 'gpt-4o', target: 'gemini-3-flash', enabled: true },
        { alias: 'claude-3-5-sonnet-20241022', target: 'claude-sonnet-4-5', enabled: false },
      ],
    });
    expect(Object.keys(file)).toEqual(['format', 'version', 'exported_at', 'aliases']);
    for (const row of file.aliases) {
      expect(Object.keys(row)).toEqual(['alias', 'target', 'enabled']);
    }
  });

  it('carries no secret from the surrounding config', () => {
    const serialized = serializeModelAliasExport(ROWS, EXPORTED_AT);
    const keys = [...serialized.matchAll(/"([^"]+)":/g)].map((match) => match[1]);

    expect(new Set(keys)).toEqual(
      new Set(['format', 'version', 'exported_at', 'aliases', 'alias', 'target', 'enabled']),
    );
    expect(serialized.endsWith('\n')).toBe(true);
  });
});

describe('planModelAliasImport', () => {
  it('round-trips an export back into the same rows', () => {
    const serialized = serializeModelAliasExport(ROWS, EXPORTED_AT);

    const plan = planModelAliasImport(serialized, []);

    expect(plan.envelopeError).toBeNull();
    expect(plan.exportedAt).toBe(EXPORTED_AT);
    expect(plan.rejections).toEqual([]);
    expect(plan.collisions).toEqual([]);
    expect(plan.additions).toEqual([
      { alias: 'gpt-4o', target: 'gemini-3-flash', enabled: true },
      { alias: 'claude-3-5-sonnet-20241022', target: 'claude-sonnet-4-5', enabled: false },
    ]);
    expect(applyModelAliasImportPlan([], plan)).toEqual(plan.additions);
  });

  it.each([
    ['not json at all', 'invalid_json'],
    ['[]', 'not_an_object'],
    ['"a string"', 'not_an_object'],
    ['{"version":1,"aliases":[]}', 'unknown_format'],
    [`{"format":"${MODEL_ALIAS_EXPORT_FORMAT}","version":2,"aliases":[]}`, 'unsupported_version'],
    [`{"format":"${MODEL_ALIAS_EXPORT_FORMAT}","version":1,"aliases":{}}`, 'aliases_not_an_array'],
  ])('rejects the malformed envelope %#', (text, code) => {
    const plan = planModelAliasImport(text, ROWS);

    expect(plan.envelopeError).toBe(code);
    expect(plan.additions).toEqual([]);
    expect(applyModelAliasImportPlan(ROWS, plan)).toEqual(ROWS);
  });

  it('names the reason for every rejected entry and applies none of them', () => {
    const text = JSON.stringify({
      format: MODEL_ALIAS_EXPORT_FORMAT,
      version: MODEL_ALIAS_EXPORT_VERSION,
      exported_at: EXPORTED_AT,
      aliases: [
        'gpt-4o',
        { alias: 42, target: 'gemini-3-flash' },
        { alias: 'gpt-4', target: 7 },
        { alias: 'gpt-4-turbo', target: 'gemini-3-flash', enabled: 'yes' },
        { alias: '   ', target: 'gemini-3-flash', enabled: true },
        { alias: 'gpt-4o-mini', target: '  ', enabled: true },
        { alias: 'kept', target: 'gemini-3-flash', enabled: true },
      ],
    });

    const plan = planModelAliasImport(text, []);

    expect(plan.envelopeError).toBeNull();
    expect(plan.rejections).toEqual([
      { entry: 1, alias: null, kind: 'structure', code: 'entry_not_an_object' },
      { entry: 2, alias: null, kind: 'structure', code: 'alias_not_a_string' },
      { entry: 3, alias: 'gpt-4', kind: 'structure', code: 'target_not_a_string' },
      { entry: 4, alias: 'gpt-4-turbo', kind: 'structure', code: 'enabled_not_a_boolean' },
      { entry: 5, alias: '', kind: 'validation', code: 'empty_alias' },
      { entry: 6, alias: 'gpt-4o-mini', kind: 'validation', code: 'empty_target' },
    ]);
    expect(plan.additions).toEqual([{ alias: 'kept', target: 'gemini-3-flash', enabled: true }]);
  });

  it('rejects both sides of an alias the file repeats, ignoring case', () => {
    const text = serializeModelAliasExport(
      [
        { alias: 'gpt-4o', target: 'gemini-3-flash', enabled: true },
        { alias: 'GPT-4O', target: 'claude-sonnet-4-5', enabled: true },
        { alias: 'gpt-4', target: 'gemini-3-flash', enabled: true },
      ],
      EXPORTED_AT,
    );

    const plan = planModelAliasImport(text, []);

    expect(plan.rejections).toEqual([
      { entry: 1, alias: 'gpt-4o', kind: 'validation', code: 'duplicate_alias' },
      { entry: 2, alias: 'GPT-4O', kind: 'validation', code: 'duplicate_alias' },
    ]);
    expect(plan.additions).toEqual([{ alias: 'gpt-4', target: 'gemini-3-flash', enabled: true }]);
  });

  it('reports collisions with configured rows and leaves those rows unchanged', () => {
    const existing: ModelAliasRow[] = [
      { alias: 'GPT-4o', target: 'claude-sonnet-4-5', enabled: false },
    ];
    const text = serializeModelAliasExport(
      [
        { alias: 'gpt-4o', target: 'gemini-3-flash', enabled: true },
        { alias: 'gpt-4o-mini', target: 'gemini-3-flash', enabled: true },
      ],
      EXPORTED_AT,
    );

    const plan = planModelAliasImport(text, existing);

    expect(plan.collisions).toEqual([
      { alias: 'gpt-4o', existingTarget: 'claude-sonnet-4-5', importedTarget: 'gemini-3-flash' },
    ]);
    expect(plan.rejections).toEqual([]);

    const merged = applyModelAliasImportPlan(existing, plan);

    expect(merged).toEqual([
      { alias: 'GPT-4o', target: 'claude-sonnet-4-5', enabled: false },
      { alias: 'gpt-4o-mini', target: 'gemini-3-flash', enabled: true },
    ]);
    expect(existing).toHaveLength(1);
  });

  it('adds a row that shadows a catalog model but says so', () => {
    const text = serializeModelAliasExport(
      [{ alias: 'gemini-3-flash', target: 'claude-sonnet-4-5', enabled: true }],
      EXPORTED_AT,
    );

    const plan = planModelAliasImport(text, [], ['gemini-3-flash']);

    expect(plan.rejections).toEqual([]);
    expect(plan.warnings).toEqual([
      { entry: 1, alias: 'gemini-3-flash', code: 'shadows_canonical_model' },
    ]);
    expect(plan.additions).toHaveLength(1);
  });

  it('treats an absent enabled flag as an enabled row', () => {
    const text = JSON.stringify({
      format: MODEL_ALIAS_EXPORT_FORMAT,
      version: MODEL_ALIAS_EXPORT_VERSION,
      aliases: [{ alias: 'gpt-4o', target: 'gemini-3-flash' }],
    });

    const plan = planModelAliasImport(text, []);

    expect(plan.exportedAt).toBeNull();
    expect(plan.additions).toEqual([{ alias: 'gpt-4o', target: 'gemini-3-flash', enabled: true }]);
  });
});
