/**
 * Validation predicates for alias rows in the Model Mapping card.
 *
 * Every problem is named on the row that carries it instead of being swallowed: a row that cannot be
 * persisted must say why, rather than quietly failing to save.
 *
 * Pure and dependency-free — see the note in `model-alias-presets.ts`.
 */

import type { ModelAliasRow } from './model-alias-presets';

export type ModelAliasIssueCode =
  | 'empty_alias'
  | 'empty_target'
  | 'duplicate_alias'
  | 'shadows_canonical_model';

export type ModelAliasIssueSeverity = 'error' | 'warning';

export interface ModelAliasIssue {
  code: ModelAliasIssueCode;
  severity: ModelAliasIssueSeverity;
}

export interface ModelAliasRowValidation {
  index: number;
  issues: ModelAliasIssue[];
  /** True when the row carries at least one `error` issue and must not be persisted. */
  hasError: boolean;
}

/**
 * Validates every row against the other rows and the live catalog.
 *
 * Aliases are compared case-insensitively on their trimmed value; both sides of a duplicate pair are
 * flagged so the conflict is visible wherever the user is looking.
 */
export function validateModelAliasRows(
  rows: readonly ModelAliasRow[],
  canonicalModels: readonly string[] = [],
): ModelAliasRowValidation[] {
  const aliasCounts = new Map<string, number>();
  for (const row of rows) {
    const key = row.alias.trim().toLowerCase();
    if (key) {
      aliasCounts.set(key, (aliasCounts.get(key) ?? 0) + 1);
    }
  }

  const canonicalKeys = new Set(
    canonicalModels.map((model) => model.trim().toLowerCase()).filter(Boolean),
  );

  return rows.map((row, index) => {
    const alias = row.alias.trim();
    const aliasKey = alias.toLowerCase();
    const issues: ModelAliasIssue[] = [];

    if (!alias) {
      issues.push({ code: 'empty_alias', severity: 'error' });
    }
    if (!row.target.trim()) {
      issues.push({ code: 'empty_target', severity: 'error' });
    }
    if (aliasKey && (aliasCounts.get(aliasKey) ?? 0) > 1) {
      issues.push({ code: 'duplicate_alias', severity: 'error' });
    }
    if (aliasKey && canonicalKeys.has(aliasKey)) {
      issues.push({ code: 'shadows_canonical_model', severity: 'warning' });
    }

    return {
      index,
      issues,
      hasError: issues.some((issue) => issue.severity === 'error'),
    };
  });
}

export function hasBlockingModelAliasIssues(validations: readonly ModelAliasRowValidation[]) {
  return validations.some((validation) => validation.hasError);
}
