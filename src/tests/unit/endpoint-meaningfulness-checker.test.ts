// @vitest-environment node
// The checker talks to a real loopback HTTP server; the default happy-dom
// environment applies browser CORS rules to `fetch` and would block every call.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALL_CHECKS,
  runChecks,
  selectChecks,
} from '../../../scripts/endpoint-meaningfulness/runner.mjs';
import { main, parseArgs } from '../../../scripts/check-endpoint-meaningfulness.mjs';
import {
  FAKE_PROXY_DEFECTS,
  FAKE_PROXY_MODEL,
  startFakeProxy,
  type FakeProxyDefect,
  type FakeProxyServer,
} from '../support/meaningfulness-fake-proxy';

interface CheckResult {
  name: string;
  outcome: string;
  failures: { what: string; expected: string; actual: string }[];
  error?: string;
}

interface CheckRun {
  ok: boolean;
  counts: { passed: number; failed: number; inconclusive: number; error: number };
  upstreamCalls: number;
  results: CheckResult[];
}

async function runAgainst(
  server: FakeProxyServer,
  options: { only?: string[]; includeOptional?: boolean } = {},
): Promise<CheckRun> {
  return runChecks(selectChecks(options), {
    baseUrl: server.baseUrl,
    model: FAKE_PROXY_MODEL,
    timeoutMs: 30_000,
  });
}

/** Renders every failure so a regression names the field, not just a count. */
function describeFailures(run: CheckRun): string {
  return run.results
    .filter((result) => result.outcome === 'failed' || result.outcome === 'error')
    .map(
      (result) =>
        `${result.name}: ${result.error ?? ''}${result.failures
          .map(
            (failure) =>
              `\n    ${failure.what} — expected ${failure.expected}, got ${failure.actual}`,
          )
          .join('')}`,
    )
    .join('\n');
}

describe('endpoint meaningfulness checker', () => {
  let conforming: FakeProxyServer;

  beforeAll(async () => {
    conforming = await startFakeProxy();
  });

  afterAll(async () => {
    await conforming.close();
  });

  it('passes every check against a conforming three-surface proxy', async () => {
    const run = await runAgainst(conforming, { includeOptional: true });

    expect(describeFailures(run)).toBe('');
    expect(run.counts.failed).toBe(0);
    expect(run.counts.error).toBe(0);
    expect(run.ok).toBe(true);
    expect(run.results).toHaveLength(ALL_CHECKS.length);
    expect(run.upstreamCalls).toBeGreaterThan(0);
  });

  it('reports the surface, the expectation and the actual value on a failure', async () => {
    const broken = await startFakeProxy({ defects: ['openai-json-object-fence'] });
    try {
      const run = await runAgainst(broken, { only: ['openai.chat.json-object'] });

      expect(run.ok).toBe(false);
      expect(run.results).toHaveLength(1);
      expect(run.results[0].outcome).toBe('failed');
      expect(run.results[0].failures[0].what).toBe('choices[0].message.content parses as JSON');
      expect(run.results[0].failures[0].actual).toContain('markdown fence');
    } finally {
      await broken.close();
    }
  });

  // One row per defect class the checker exists to catch; every one of these
  // answers HTTP 200 (or a plausible 4xx), so only the content betrays it.
  const DEFECT_CASES: { defect: FakeProxyDefect; check: string }[] = [
    { defect: 'openai-json-object-fence', check: 'openai.chat.json-object' },
    { defect: 'openai-usage-total-mismatch', check: 'openai.chat.natural-stop' },
    { defect: 'openai-responses-stream-drift', check: 'openai.responses.stream-consistency' },
    { defect: 'openai-client-error-typed-server-error', check: 'openai.rejects-unknown-model' },
    { defect: 'anthropic-stop-sequence-as-end-turn', check: 'anthropic.messages.stop-sequence' },
    { defect: 'anthropic-empty-thinking-block', check: 'anthropic.messages.natural-stop' },
    { defect: 'gemini-max-tokens-as-stop', check: 'gemini.generate.max-tokens' },
    { defect: 'gemini-tool-args-violate-schema', check: 'gemini.generate.function-call' },
  ];

  it('covers every defect the fake proxy can seed', () => {
    expect(DEFECT_CASES.map((entry) => entry.defect).sort()).toEqual(
      [...FAKE_PROXY_DEFECTS].sort(),
    );
  });

  it.each(DEFECT_CASES)('reports $defect via $check', async ({ defect, check }) => {
    const broken = await startFakeProxy({ defects: [defect] });
    try {
      const run = await runAgainst(broken, { only: [check] });

      expect(run.results.map((result) => result.name)).toEqual([check]);
      expect(run.results[0].outcome).toBe('failed');
      expect(run.results[0].failures.length).toBeGreaterThan(0);
      expect(run.ok).toBe(false);
    } finally {
      await broken.close();
    }
  });

  it('leaves the other surfaces untouched when one surface is selected', async () => {
    const run = await runAgainst(conforming, { only: [] });
    const anthropicOnly = await runChecks(selectChecks({ surfaces: ['anthropic'] }), {
      baseUrl: conforming.baseUrl,
      model: FAKE_PROXY_MODEL,
      timeoutMs: 30_000,
    });

    expect(
      new Set(anthropicOnly.results.map((result: CheckResult) => result.name.split('.')[0])),
    ).toEqual(new Set(['anthropic']));
    expect(anthropicOnly.results.length).toBeLessThan(run.results.length);
    expect(describeFailures(anthropicOnly)).toBe('');
  });
});

describe('endpoint meaningfulness CLI', () => {
  it('parses the documented flags', () => {
    expect(
      parseArgs([
        '--base-url',
        'http://127.0.0.1:8045',
        '--surface',
        'gemini',
        '--only',
        'gemini.stream',
        '--json',
        '--optional',
      ]),
    ).toMatchObject({
      baseUrl: 'http://127.0.0.1:8045',
      surfaces: ['gemini'],
      only: ['gemini.stream'],
      json: true,
      includeOptional: true,
    });
  });

  it('exits 2 on an unknown surface and 1 when a check fails', async () => {
    const messages: string[] = [];
    const io = {
      log: (line: string) => messages.push(line),
      error: (line: string) => messages.push(line),
    };

    expect(await main(['--surface', 'bedrock'], io)).toBe(2);
    expect(messages.join('\n')).toContain("unknown surface 'bedrock'");

    const broken = await startFakeProxy({ defects: ['gemini-max-tokens-as-stop'] });
    try {
      const exitCode = await main(
        [
          '--base-url',
          broken.baseUrl,
          '--model',
          FAKE_PROXY_MODEL,
          '--only',
          'gemini.generate.max-tokens',
          '--json',
        ],
        io,
      );

      expect(exitCode).toBe(1);
      const report = JSON.parse(messages.at(-1) ?? '{}');
      expect(report.ok).toBe(false);
      expect(report.checks[0].failures[0].actual).toBe('"STOP"');
    } finally {
      await broken.close();
    }
  });

  it('prints the endpoint, the expectation and the actual value in human mode', async () => {
    const messages: string[] = [];
    const io = {
      log: (line: string) => messages.push(line),
      error: (line: string) => messages.push(line),
    };
    const broken = await startFakeProxy({ defects: ['anthropic-empty-thinking-block'] });

    try {
      expect(
        await main(
          [
            '--base-url',
            broken.baseUrl,
            '--model',
            FAKE_PROXY_MODEL,
            '--only',
            'anthropic.messages.natural-stop',
          ],
          io,
        ),
      ).toBe(1);

      const report = messages.at(-1) ?? '';
      expect(report).toContain('FAIL  anthropic.messages.natural-stop');
      expect(report).toContain(
        '✗ POST /v1/messages: content[0].thinking is not an empty placeholder',
      );
      expect(report).toContain('expected: "non-empty reasoning text"');
      expect(report).toContain('actual:   ""');
      expect(report).toContain('1 upstream call made (budgeted 1)');
      expect(report).toContain('this checker deliberately does not fix them');
    } finally {
      await broken.close();
    }
  });

  it('lists the selected checks and their upstream cost without calling anything', async () => {
    const messages: string[] = [];
    const io = {
      log: (line: string) => messages.push(line),
      error: (line: string) => messages.push(line),
    };

    expect(await main(['--surface', 'openai', '--list'], io)).toBe(0);
    expect(messages.at(-1)).toContain('openai.chat.json-object');
    expect(messages.at(-1)).not.toContain('anthropic.');
  });
});
