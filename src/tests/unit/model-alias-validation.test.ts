import { describe, expect, it } from 'vitest';
import type { ModelAliasRow } from '@/modules/proxy-gateway/components/model-alias-presets';
import {
  hasBlockingModelAliasIssues,
  validateModelAliasRows,
} from '@/modules/proxy-gateway/components/model-alias-validation';

function codesOf(rows: readonly ModelAliasRow[], canonicalModels: readonly string[] = []) {
  return validateModelAliasRows(rows, canonicalModels).map((validation) =>
    validation.issues.map((issue) => issue.code),
  );
}

describe('validateModelAliasRows', () => {
  it('reports no issue for a well-formed row', () => {
    const rows: ModelAliasRow[] = [{ alias: 'gpt-4o', target: 'gemini-3-flash', enabled: true }];

    expect(validateModelAliasRows(rows, ['gemini-3-flash'])).toEqual([
      { index: 0, issues: [], hasError: false },
    ]);
    expect(hasBlockingModelAliasIssues(validateModelAliasRows(rows, ['gemini-3-flash']))).toBe(
      false,
    );
  });

  it('flags a duplicate alias case-insensitively on both rows', () => {
    const rows: ModelAliasRow[] = [
      { alias: 'GPT-4o', target: 'gemini-3-flash', enabled: true },
      { alias: '  gpt-4o ', target: 'claude-sonnet-4-5', enabled: true },
      { alias: 'gpt-4', target: 'gemini-3-flash', enabled: true },
    ];

    expect(codesOf(rows)).toEqual([['duplicate_alias'], ['duplicate_alias'], []]);
    expect(hasBlockingModelAliasIssues(validateModelAliasRows(rows))).toBe(true);
  });

  it('warns when an alias shadows a canonical model id from the live catalog', () => {
    const rows: ModelAliasRow[] = [
      { alias: 'Gemini-3-Flash', target: 'claude-sonnet-4-5', enabled: true },
    ];

    const validations = validateModelAliasRows(rows, ['gemini-3-flash', 'claude-sonnet-4-5']);

    expect(validations[0].issues).toEqual([
      { code: 'shadows_canonical_model', severity: 'warning' },
    ]);
    // A shadow is a warning, not a rejection: the row still saves.
    expect(validations[0].hasError).toBe(false);
    expect(hasBlockingModelAliasIssues(validations)).toBe(false);
  });

  it('does not flag a shadow when the catalog is unknown', () => {
    const rows: ModelAliasRow[] = [
      { alias: 'gemini-3-flash', target: 'claude-sonnet-4-5', enabled: true },
    ];

    expect(codesOf(rows)).toEqual([[]]);
  });

  it('names an empty alias and an empty target instead of dropping the row silently', () => {
    const rows: ModelAliasRow[] = [
      { alias: '   ', target: 'gemini-3-flash', enabled: true },
      { alias: 'gpt-4o', target: '  ', enabled: true },
      { alias: '', target: '', enabled: false },
    ];

    expect(codesOf(rows)).toEqual([
      ['empty_alias'],
      ['empty_target'],
      ['empty_alias', 'empty_target'],
    ]);
    expect(hasBlockingModelAliasIssues(validateModelAliasRows(rows))).toBe(true);
  });

  it('does not treat several blank aliases as duplicates of each other', () => {
    const rows: ModelAliasRow[] = [
      { alias: '', target: 'gemini-3-flash', enabled: true },
      { alias: '  ', target: 'gemini-3-flash', enabled: true },
    ];

    expect(codesOf(rows)).toEqual([['empty_alias'], ['empty_alias']]);
  });

  it('accumulates every issue that applies to a row', () => {
    const rows: ModelAliasRow[] = [
      { alias: 'gemini-3-flash', target: '', enabled: true },
      { alias: 'GEMINI-3-FLASH', target: 'claude-sonnet-4-5', enabled: true },
    ];

    expect(codesOf(rows, ['gemini-3-flash'])).toEqual([
      ['empty_target', 'duplicate_alias', 'shadows_canonical_model'],
      ['duplicate_alias', 'shadows_canonical_model'],
    ]);
  });

  it('treats an empty row list as valid', () => {
    expect(validateModelAliasRows([])).toEqual([]);
    expect(hasBlockingModelAliasIssues([])).toBe(false);
  });
});
