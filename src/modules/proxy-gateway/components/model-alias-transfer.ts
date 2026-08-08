/**
 * Export and import of the alias set for the Model Mapping card.
 *
 * The exported file carries the alias rows and nothing else — no api key, no account ids, no ports —
 * because it is meant to be pasted into a chat or a ticket.
 *
 * Import merges: rows whose alias is already configured are reported and left untouched, so the file
 * can never silently rewrite a mapping the user tuned by hand. Every row is checked with the same
 * rules the card applies while typing, and the caller gets the whole verdict before anything is
 * written, so an import is either fully previewed and applied or not applied at all.
 *
 * Pure and dependency-free — see the note in `model-alias-presets.ts`.
 */

import type { ModelAliasRow } from './model-alias-presets';
import { validateModelAliasRows, type ModelAliasIssueCode } from './model-alias-validation';

export const MODEL_ALIAS_EXPORT_FORMAT = 'antigravity-manager.model-aliases';
export const MODEL_ALIAS_EXPORT_VERSION = 1;

export interface ModelAliasExportFile {
  format: string;
  version: number;
  exported_at: string;
  aliases: ModelAliasRow[];
}

/** Builds the envelope. `exportedAt` is passed in so the caller owns the clock. */
export function buildModelAliasExport(
  rows: readonly ModelAliasRow[],
  exportedAt: string,
): ModelAliasExportFile {
  return {
    format: MODEL_ALIAS_EXPORT_FORMAT,
    version: MODEL_ALIAS_EXPORT_VERSION,
    exported_at: exportedAt,
    aliases: rows.map((row) => ({
      alias: row.alias.trim(),
      target: row.target.trim(),
      enabled: row.enabled,
    })),
  };
}

/** The exact bytes written to disk: indented, newline-terminated, diff-friendly. */
export function serializeModelAliasExport(
  rows: readonly ModelAliasRow[],
  exportedAt: string,
): string {
  return `${JSON.stringify(buildModelAliasExport(rows, exportedAt), null, 2)}\n`;
}

export type ModelAliasImportEnvelopeCode =
  | 'invalid_json'
  | 'not_an_object'
  | 'unknown_format'
  | 'unsupported_version'
  | 'aliases_not_an_array';

export type ModelAliasImportStructureCode =
  | 'entry_not_an_object'
  | 'alias_not_a_string'
  | 'target_not_a_string'
  | 'enabled_not_a_boolean';

export type ModelAliasImportRejection =
  | {
      /** 1-based position in the file's `aliases` array, so a message can point at the entry. */
      entry: number;
      alias: string | null;
      kind: 'structure';
      code: ModelAliasImportStructureCode;
    }
  | {
      entry: number;
      alias: string | null;
      kind: 'validation';
      code: ModelAliasIssueCode;
    };

export interface ModelAliasImportCollision {
  alias: string;
  /** Target of the row already configured; it is left untouched. */
  existingTarget: string;
  /** Target the file wanted for this alias. */
  importedTarget: string;
}

export interface ModelAliasImportWarning {
  entry: number;
  alias: string;
  code: ModelAliasIssueCode;
}

export interface ModelAliasImportPlan {
  /** Set when the file itself is unusable; nothing can be applied and the other lists are empty. */
  envelopeError: ModelAliasImportEnvelopeCode | null;
  exportedAt: string | null;
  /** Rows that would be appended, in file order. */
  additions: ModelAliasRow[];
  /** Aliases the file brings that a configured row already claims. */
  collisions: ModelAliasImportCollision[];
  /** Entries dropped, each with the reason it was dropped. */
  rejections: ModelAliasImportRejection[];
  /** Non-blocking remarks about rows that will be added. */
  warnings: ModelAliasImportWarning[];
}

function emptyPlan(envelopeError: ModelAliasImportEnvelopeCode | null): ModelAliasImportPlan {
  return {
    envelopeError,
    exportedAt: null,
    additions: [],
    collisions: [],
    rejections: [],
    warnings: [],
  };
}

/**
 * Works out what importing `text` would do, without changing anything.
 *
 * Rows are first checked for shape, then handed to `validateModelAliasRows` so a row the card would
 * refuse when typed is refused here too, then compared against the configured rows.
 */
export function planModelAliasImport(
  text: string,
  existingRows: readonly ModelAliasRow[],
  canonicalModels: readonly string[] = [],
): ModelAliasImportPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return emptyPlan('invalid_json');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return emptyPlan('not_an_object');
  }

  const envelope = parsed as Record<string, unknown>;
  if (envelope.format !== MODEL_ALIAS_EXPORT_FORMAT) {
    return emptyPlan('unknown_format');
  }
  if (envelope.version !== MODEL_ALIAS_EXPORT_VERSION) {
    return emptyPlan('unsupported_version');
  }
  if (!Array.isArray(envelope.aliases)) {
    return emptyPlan('aliases_not_an_array');
  }

  const exportedAt = typeof envelope.exported_at === 'string' ? envelope.exported_at : null;
  const rejections: ModelAliasImportRejection[] = [];
  const candidates: Array<{ entry: number; row: ModelAliasRow }> = [];

  envelope.aliases.forEach((raw: unknown, index: number) => {
    const entry = index + 1;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      rejections.push({ entry, alias: null, kind: 'structure', code: 'entry_not_an_object' });
      return;
    }
    const record = raw as Record<string, unknown>;
    const alias = typeof record.alias === 'string' ? record.alias : null;
    if (alias === null) {
      rejections.push({ entry, alias: null, kind: 'structure', code: 'alias_not_a_string' });
      return;
    }
    if (typeof record.target !== 'string') {
      rejections.push({ entry, alias, kind: 'structure', code: 'target_not_a_string' });
      return;
    }
    // An absent `enabled` is the common hand-edit; it means the row is on.
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
      rejections.push({ entry, alias, kind: 'structure', code: 'enabled_not_a_boolean' });
      return;
    }
    candidates.push({
      entry,
      row: {
        alias: alias.trim(),
        target: record.target.trim(),
        enabled: record.enabled === undefined ? true : record.enabled,
      },
    });
  });

  // The file is validated against itself, so a collision with a configured row stays a collision
  // rather than being reported as a duplicate inside the file.
  const validations = validateModelAliasRows(
    candidates.map((candidate) => candidate.row),
    canonicalModels,
  );

  const existingByAlias = new Map<string, ModelAliasRow>();
  for (const row of existingRows) {
    const key = row.alias.trim().toLowerCase();
    if (key && !existingByAlias.has(key)) {
      existingByAlias.set(key, row);
    }
  }

  const additions: ModelAliasRow[] = [];
  const collisions: ModelAliasImportCollision[] = [];
  const warnings: ModelAliasImportWarning[] = [];

  candidates.forEach((candidate, index) => {
    const validation = validations[index];
    const issues = validation?.issues ?? [];
    const errors = issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      for (const issue of errors) {
        rejections.push({
          entry: candidate.entry,
          alias: candidate.row.alias,
          kind: 'validation',
          code: issue.code,
        });
      }
      return;
    }

    const existing = existingByAlias.get(candidate.row.alias.toLowerCase());
    if (existing) {
      collisions.push({
        alias: candidate.row.alias,
        existingTarget: existing.target,
        importedTarget: candidate.row.target,
      });
      return;
    }

    for (const issue of issues) {
      warnings.push({ entry: candidate.entry, alias: candidate.row.alias, code: issue.code });
    }
    additions.push(candidate.row);
  });

  rejections.sort((left, right) => left.entry - right.entry);

  return { envelopeError: null, exportedAt, additions, collisions, rejections, warnings };
}

/** Appends a plan's additions to the configured rows. Configured rows are never rewritten. */
export function applyModelAliasImportPlan(
  existingRows: readonly ModelAliasRow[],
  plan: ModelAliasImportPlan,
): ModelAliasRow[] {
  if (plan.envelopeError) {
    return [...existingRows];
  }
  return [...existingRows, ...plan.additions.map((row) => ({ ...row }))];
}
