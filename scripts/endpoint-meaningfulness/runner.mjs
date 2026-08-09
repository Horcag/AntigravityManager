/**
 * Check selection and sequential execution.
 *
 * Checks run in declaration order and never concurrently: several of them
 * compare against what an earlier check observed (a truncated answer must
 * report a different stop reason than a natural one), and a conformance run
 * that spent quota in parallel would be harder to reason about when it fails.
 */

import { CHECK_OUTCOMES, CheckAssertions, CheckContext } from './harness.mjs';
import { OPENAI_CHECKS } from './openai-checks.mjs';
import { OPENAI_RESPONSES_CHECKS } from './openai-responses-checks.mjs';
import { ANTHROPIC_CHECKS } from './anthropic-checks.mjs';
import { GEMINI_CHECKS } from './gemini-checks.mjs';

export const SURFACES = ['openai', 'anthropic', 'gemini'];

export const ALL_CHECKS = [
  ...OPENAI_CHECKS,
  ...OPENAI_RESPONSES_CHECKS,
  ...ANTHROPIC_CHECKS,
  ...GEMINI_CHECKS,
];

export class CheckSelectionError extends Error {}

/**
 * @param {{ surfaces?: string[], only?: string[], includeOptional?: boolean }} options
 */
export function selectChecks(options = {}) {
  const surfaces = options.surfaces?.length ? options.surfaces : SURFACES;
  for (const surface of surfaces) {
    if (!SURFACES.includes(surface)) {
      throw new CheckSelectionError(
        `unknown surface '${surface}'; expected one of ${SURFACES.join(', ')}`,
      );
    }
  }

  let selected = ALL_CHECKS.filter((check) => surfaces.includes(check.surface));

  if (options.only?.length) {
    const matched = new Set();
    for (const pattern of options.only) {
      const hits = selected.filter(
        (check) => check.name === pattern || check.name.startsWith(`${pattern}.`),
      );
      if (hits.length === 0) {
        throw new CheckSelectionError(
          `--only '${pattern}' matched no check in the selected surfaces`,
        );
      }
      for (const hit of hits) {
        matched.add(hit.name);
      }
    }
    // An explicitly named check runs even when it is optional: --only is how a
    // single expensive check is re-run cheaply after a fix.
    return selected.filter((check) => matched.has(check.name));
  }

  if (!options.includeOptional) {
    selected = selected.filter((check) => !check.optional);
  }

  return selected;
}

/**
 * Runs the selected checks against one proxy.
 *
 * @returns a plain result object; formatting lives in `report.mjs` so the same
 * run can be printed for a human or emitted as JSON.
 */
export async function runChecks(checks, contextOptions) {
  const ctx =
    contextOptions instanceof CheckContext ? contextOptions : new CheckContext(contextOptions);
  const results = [];

  for (const check of checks) {
    const assertions = new CheckAssertions(check.endpoint);
    const startedAt = performance.now();
    let error;

    try {
      await check.run(ctx, assertions);
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    }

    results.push({
      name: check.name,
      surface: check.surface,
      endpoint: check.endpoint,
      title: check.title,
      optional: Boolean(check.optional),
      outcome: error ? CHECK_OUTCOMES.error : assertions.outcome,
      failures: assertions.failures,
      notes: assertions.notes,
      inconclusiveReasons: assertions.inconclusiveReasons,
      error,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  const counts = {
    passed: results.filter((result) => result.outcome === CHECK_OUTCOMES.passed).length,
    failed: results.filter((result) => result.outcome === CHECK_OUTCOMES.failed).length,
    inconclusive: results.filter((result) => result.outcome === CHECK_OUTCOMES.inconclusive).length,
    error: results.filter((result) => result.outcome === CHECK_OUTCOMES.error).length,
  };

  return {
    baseUrl: ctx.baseUrl,
    model: ctx.model,
    results,
    counts,
    upstreamCalls: ctx.upstreamCalls,
    /** What the run would have cost had every check reached its last request. */
    budgetedUpstreamCalls: checks.reduce((total, check) => total + (check.upstreamCalls ?? 0), 0),
    ok: counts.failed === 0 && counts.error === 0,
  };
}
