import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateLegacyModelAliases } from '@/modules/config/model-alias-migration';
import {
  getModelAliasMigrationBackupPath,
  persistMigratedModelAliases,
} from '@/modules/config/model-alias-migration-persistence';
import { DEFAULT_APP_CONFIG, type AppConfig } from '@/modules/config/types';

vi.mock('@/shared/logging/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const LEGACY_CONFIG = {
  ...DEFAULT_APP_CONFIG,
  proxy: {
    ...DEFAULT_APP_CONFIG.proxy,
    model_aliases: null as unknown as AppConfig['proxy']['model_aliases'],
    custom_mapping: { 'my-fast': 'gemini-3-flash' },
    anthropic_mapping: { 'my-smart': 'claude-4-opus' },
  },
};

describe('persistMigratedModelAliases', () => {
  let directory = '';
  let configPath = '';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-alias-migration-'));
    configPath = path.join(directory, 'gui_config.json');
  });

  afterEach(() => {
    fs.rmSync(directory, { force: true, recursive: true });
  });

  function writeConfig(config: unknown): void {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  function readConfig(filePath = configPath): AppConfig {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AppConfig;
  }

  function migrate(config: AppConfig): AppConfig {
    return { ...config, proxy: migrateLegacyModelAliases(config.proxy) };
  }

  it('rewrites the file in the new shape after a first migration', async () => {
    writeConfig(LEGACY_CONFIG);

    const outcome = await persistMigratedModelAliases(
      configPath,
      LEGACY_CONFIG.proxy,
      migrate(LEGACY_CONFIG as AppConfig),
    );

    expect(outcome).toBe('persisted');
    const written = readConfig();
    expect(written.proxy.model_aliases).toEqual([
      { alias: 'my-fast', target: 'gemini-3-flash', enabled: true },
      { alias: 'my-smart', target: 'claude-4-opus', enabled: true },
    ]);
    expect(written.proxy.custom_mapping).toEqual({});
    expect(written.proxy.anthropic_mapping).toEqual({});
  });

  it('backs the original up next to the config under an obvious name', async () => {
    writeConfig(LEGACY_CONFIG);

    await persistMigratedModelAliases(
      configPath,
      LEGACY_CONFIG.proxy,
      migrate(LEGACY_CONFIG as AppConfig),
    );

    const backupPath = getModelAliasMigrationBackupPath(configPath);
    expect(path.basename(backupPath)).toBe('gui_config.pre-model-alias-migration.json');
    expect(readConfig(backupPath).proxy.custom_mapping).toEqual({ 'my-fast': 'gemini-3-flash' });
  });

  it('is a no-op on the second load because the file no longer carries legacy maps', async () => {
    writeConfig(LEGACY_CONFIG);
    await persistMigratedModelAliases(
      configPath,
      LEGACY_CONFIG.proxy,
      migrate(LEGACY_CONFIG as AppConfig),
    );
    const afterFirst = readConfig();

    const secondOutcome = await persistMigratedModelAliases(
      configPath,
      afterFirst.proxy,
      migrate(afterFirst),
    );

    expect(secondOutcome).toBe('not_needed');
    expect(readConfig()).toEqual(afterFirst);
  });

  it('leaves a configuration already in the new shape untouched', async () => {
    const modern = {
      ...DEFAULT_APP_CONFIG,
      proxy: {
        ...DEFAULT_APP_CONFIG.proxy,
        model_aliases: [{ alias: 'my-fast', target: 'gemini-3-flash', enabled: true }],
      },
    } as AppConfig;
    writeConfig(modern);
    const before = fs.readFileSync(configPath, 'utf-8');

    const outcome = await persistMigratedModelAliases(configPath, modern.proxy, migrate(modern));

    expect(outcome).toBe('not_needed');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    expect(fs.existsSync(getModelAliasMigrationBackupPath(configPath))).toBe(false);
  });

  it('keeps the first backup when a retry runs after a failed write', async () => {
    writeConfig(LEGACY_CONFIG);
    const backupPath = getModelAliasMigrationBackupPath(configPath);
    await persistMigratedModelAliases(
      configPath,
      LEGACY_CONFIG.proxy,
      migrate(LEGACY_CONFIG as AppConfig),
    );
    const firstBackup = fs.readFileSync(backupPath, 'utf-8');

    // Simulate a retry that still believes the on-disk config is legacy.
    await persistMigratedModelAliases(
      configPath,
      LEGACY_CONFIG.proxy,
      migrate(LEGACY_CONFIG as AppConfig),
    );

    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(firstBackup);
  });

  it('reports failure instead of throwing when the config cannot be rewritten', async () => {
    writeConfig(LEGACY_CONFIG);

    const outcome = await persistMigratedModelAliases(
      path.join(directory, 'missing-directory', 'gui_config.json'),
      LEGACY_CONFIG.proxy,
      migrate(LEGACY_CONFIG as AppConfig),
    );

    expect(outcome).toBe('failed');
  });
});
