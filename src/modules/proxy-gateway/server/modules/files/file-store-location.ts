import { app } from 'electron';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FileStoreOptions } from './file-store.types';

/**
 * Where the file store lives: `<userData>/proxy-files`, beside the other proxy
 * state this app already keeps. Falls back to a temp directory when Electron is
 * unavailable (unit tests, CLI use), so the store is always constructible.
 */
export function resolveFileStoreOptions(): FileStoreOptions {
  return { rootDirectory: join(resolveUserDataDirectory(), 'proxy-files') };
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
