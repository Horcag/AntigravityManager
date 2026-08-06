import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { describe, expect, it } from 'vitest';
import {
  discoverProductionFuseTarget,
  validateProductionFuses,
} from '../../../scripts/audit-production-fuses.mjs';

function writeFile(filePath: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, 'fixture');
}

function hardenedFuseConfig() {
  return {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: 48,
    [FuseV1Options.EnableCookieEncryption]: 49,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 48,
    [FuseV1Options.EnableNodeCliInspectArguments]: 48,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: 49,
    [FuseV1Options.OnlyLoadAppFromAsar]: 49,
  };
}

describe('production fuse audit', () => {
  it('discovers the Windows executable next to a packaged app.asar', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-production-fuses-'));

    try {
      const packageDir = path.join(rootDir, 'out', 'Antigravity Manager-win32-x64');
      const executablePath = path.join(packageDir, 'antigravity-manager.exe');

      writeFile(path.join(packageDir, 'resources', 'app.asar'));
      writeFile(executablePath);

      expect(discoverProductionFuseTarget({ rootDir, platform: 'win32' })).toBe(executablePath);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      expect(existsSync(rootDir)).toBe(false);
    }
  });

  it('fails when a required production fuse is relaxed', () => {
    const fuseConfig = hardenedFuseConfig();
    fuseConfig[FuseV1Options.EnableNodeCliInspectArguments] = 49;

    expect(validateProductionFuses(fuseConfig)).toEqual([
      'EnableNodeCliInspectArguments must be disabled',
    ]);
  });

  it('accepts the required hardened fuse values', () => {
    expect(validateProductionFuses(hardenedFuseConfig())).toEqual([]);
  });
});
