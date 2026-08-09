/**
 * Run formatting.
 *
 * A failure line has to be enough to open a card from: which endpoint, which
 * field, what the vendor contract says it should be, and what actually came
 * back. Nothing is summarised away.
 */

import { CHECK_OUTCOMES } from './harness.mjs';

const OUTCOME_MARKERS = {
  [CHECK_OUTCOMES.passed]: 'PASS',
  [CHECK_OUTCOMES.failed]: 'FAIL',
  [CHECK_OUTCOMES.inconclusive]: 'SKIP',
  [CHECK_OUTCOMES.error]: 'ERR ',
};

export function formatHuman(run) {
  const lines = [`Endpoint meaningfulness — ${run.baseUrl} (model ${run.model})`, ''];

  let surface;
  for (const result of run.results) {
    if (result.surface !== surface) {
      surface = result.surface;
      lines.push(`${surface}:`);
    }

    lines.push(
      `  ${OUTCOME_MARKERS[result.outcome]}  ${result.name}  (${result.durationMs}ms)`,
      `        ${result.endpoint} — ${result.title}`,
    );

    if (result.error) {
      lines.push(`        ! the check itself threw: ${result.error}`);
    }

    for (const failure of result.failures) {
      lines.push(
        `        ✗ ${failure.endpoint}: ${failure.what}`,
        `            expected: ${failure.expected}`,
        `            actual:   ${failure.actual}`,
      );
    }

    for (const reason of result.inconclusiveReasons) {
      lines.push(`        ~ inconclusive: ${reason}`);
    }

    for (const note of result.notes) {
      lines.push(`        · ${note}`);
    }
  }

  lines.push(
    '',
    `${run.counts.passed} passed, ${run.counts.failed} failed, ` +
      `${run.counts.inconclusive} inconclusive, ${run.counts.error} errored`,
    `${run.upstreamCalls} upstream call${run.upstreamCalls === 1 ? '' : 's'} made ` +
      `(budgeted ${run.budgetedUpstreamCalls})`,
  );

  if (!run.ok) {
    lines.push('', 'Report these as defects; this checker deliberately does not fix them.');
  }

  return lines.join('\n');
}

export function formatJson(run) {
  return JSON.stringify(
    {
      baseUrl: run.baseUrl,
      model: run.model,
      ok: run.ok,
      counts: run.counts,
      upstreamCalls: run.upstreamCalls,
      budgetedUpstreamCalls: run.budgetedUpstreamCalls,
      checks: run.results,
    },
    null,
    2,
  );
}

export function formatCheckList(checks) {
  return checks
    .map(
      (check) =>
        `${check.name.padEnd(40)} ${String(check.upstreamCalls).padStart(2)} call(s)` +
        `${check.optional ? '  [optional]' : ''}  ${check.endpoint}`,
    )
    .join('\n');
}
