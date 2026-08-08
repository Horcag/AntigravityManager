import { app } from 'electron';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isDurableStoreTestEnvironment,
  readPositiveIntegerEnv,
} from '@/shared/persistence/durable-store-settings';
import {
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_BATCH_TTL_MS,
  DEFAULT_MAX_BATCHES,
  DEFAULT_MAX_REQUESTS_PER_BATCH,
  type BatchRunnerOptions,
} from './batch-job.types';

/**
 * Where batch state lives: `<userData>/proxy-batches.json`, beside the other
 * proxy state this app already keeps, written through the same atomic helper
 * the durable record store uses.
 *
 * Under the test runner no path is returned at all, so a unit test can never
 * write into the real data directory; tests that need a file pass one in.
 */
export function resolveBatchRunnerOptions(): BatchRunnerOptions {
  return {
    ...(isDurableStoreTestEnvironment()
      ? {}
      : { filePath: join(resolveUserDataDirectory(), 'proxy-batches.json') }),
    maxConcurrency: readPositiveIntegerEnv('AGM_BATCH_MAX_CONCURRENCY', DEFAULT_BATCH_CONCURRENCY),
    ttlMs: readPositiveIntegerEnv('AGM_BATCH_TTL_MS', DEFAULT_BATCH_TTL_MS),
    maxBatches: readPositiveIntegerEnv('AGM_BATCH_MAX_BATCHES', DEFAULT_MAX_BATCHES),
    maxRequestsPerBatch: readPositiveIntegerEnv(
      'AGM_BATCH_MAX_REQUESTS',
      DEFAULT_MAX_REQUESTS_PER_BATCH,
    ),
  };
}

function resolveUserDataDirectory(): string {
  try {
    const userData = app?.getPath?.('userData');
    if (userData) {
      return userData;
    }
  } catch {
    // Not running inside Electron.
  }
  return join(tmpdir(), 'antigravity-manager');
}
