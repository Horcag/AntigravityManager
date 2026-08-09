/**
 * Endpoint meaningfulness checker.
 *
 * The route-coverage matrix answers "does this route exist and answer in its
 * own envelope". This script answers the other question: **when a route
 * answers 200, is what it returned true?** Every defect fixed in kanban #50 was
 * on an endpoint that answered 200 — `json_object` content that would not
 * parse, a fired stop sequence reported as `end_turn`, an empty `thinking`
 * block, provider rejections typed `server_error` so SDKs retried a request
 * that could never succeed. A status code proves nothing.
 *
 * It reports; it does not fix. Measuring and patching in the same pass is how a
 * measurement stops being trustworthy.
 *
 * Usage:
 *   node scripts/check-endpoint-meaningfulness.mjs [options]
 *
 *   --base-url <url>     proxy to check (default http://127.0.0.1:8045)
 *   --model <id>         model the checks call (default gemini-3-flash)
 *   --image-model <id>   model the optional image check calls (default: let the
 *                        proxy resolve its own image-capable model)
 *   --surface <name>     openai | anthropic | gemini; repeatable, default all
 *   --only <check>       run one check (or one dotted prefix); repeatable
 *   --optional           also run the checks excluded from a default run
 *   --api-key <key>      sent as both Authorization: Bearer and x-api-key
 *   --timeout <ms>       per-request timeout (default 120000)
 *   --json               emit machine-readable JSON instead of text
 *   --list               list the selected checks and their call cost, run none
 *
 * Exit codes: 0 when every check passed or was inconclusive, 1 when any check
 * failed or threw, 2 on a usage error.
 *
 * No `#!` line, deliberately. Node strips a shebang, but the test runner's
 * transform does not: with one present, importing this module from
 * `endpoint-meaningfulness-checker.test.ts` threw `SyntaxError: Invalid or
 * unexpected token` at the first character on one checkout while passing on a
 * byte-identical one. Nothing else under `scripts/` carries a shebang either, and
 * the npm alias already runs this through `node`.
 */

import { pathToFileURL } from 'node:url';

import {
  CheckSelectionError,
  runChecks,
  selectChecks,
  SURFACES,
} from './endpoint-meaningfulness/runner.mjs';
import { formatCheckList, formatHuman, formatJson } from './endpoint-meaningfulness/report.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8045';
const DEFAULT_MODEL = 'gemini-3-flash';
const DEFAULT_TIMEOUT_MS = 120_000;

export function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    imageModel: undefined,
    surfaces: [],
    only: [],
    includeOptional: false,
    apiKey: process.env.AGM_PROXY_API_KEY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    list: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CheckSelectionError(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--base-url':
        options.baseUrl = next();
        break;
      case '--model':
        options.model = next();
        break;
      case '--image-model':
        options.imageModel = next();
        break;
      case '--surface':
        options.surfaces.push(next());
        break;
      case '--only':
        options.only.push(next());
        break;
      case '--api-key':
        options.apiKey = next();
        break;
      case '--timeout':
        options.timeoutMs = Number(next());
        break;
      case '--optional':
        options.includeOptional = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new CheckSelectionError(`unknown argument '${arg}'`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new CheckSelectionError('--timeout must be a positive number of milliseconds');
  }

  return options;
}

function usage() {
  return [
    'node scripts/check-endpoint-meaningfulness.mjs [options]',
    '',
    `  --base-url <url>     default ${DEFAULT_BASE_URL}`,
    `  --model <id>         default ${DEFAULT_MODEL}`,
    '  --image-model <id>   model for the optional image check',
    `  --surface <name>     ${SURFACES.join(' | ')}; repeatable, default all`,
    '  --only <check>       run one check or dotted prefix; repeatable',
    '  --optional           also run checks excluded from a default run',
    '  --api-key <key>      or set AGM_PROXY_API_KEY',
    `  --timeout <ms>       default ${DEFAULT_TIMEOUT_MS}`,
    '  --json               machine-readable output',
    '  --list               list the selected checks without running them',
  ].join('\n');
}

export async function main(argv, io = console) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error(usage());
    return 2;
  }

  if (options.help) {
    io.log(usage());
    return 0;
  }

  let checks;
  try {
    checks = selectChecks(options);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (options.list) {
    io.log(formatCheckList(checks));
    return 0;
  }

  const run = await runChecks(checks, {
    baseUrl: options.baseUrl,
    model: options.model,
    imageModel: options.imageModel,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
  });

  io.log(options.json ? formatJson(run) : formatHuman(run));
  return run.ok ? 0 : 1;
}

// Comparing the resolved entry path against this module keeps the file
// importable from tests without the CLI running as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
