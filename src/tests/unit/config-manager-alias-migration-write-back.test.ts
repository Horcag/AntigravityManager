import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';

const agentDirectory = { current: '' };

vi.mock('@/shared/platform/paths', () => ({
  getAgentDir: () => agentDirectory.current,
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const LEGACY_CONFIG = {
  ...DEFAULT_APP_CONFIG,
  proxy: {
    ...DEFAULT_APP_CONFIG.proxy,
    model_aliases: null,
    custom_mapping: { 'my-fast': 'gemini-3-flash' },
    anthropic_mapping: {},
  },
};

/**
 * Covers the wiring rather than the migration itself: loading a legacy config
 * has to reach the disk, or the migration re-runs forever and the file keeps
 * describing a shape the app no longer reads.
 */
describe('ConfigManager legacy alias write-back', () => {
  let configPath = '';

  beforeEach(() => {
    agentDirectory.current = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-config-manager-'));
    configPath = path.join(agentDirectory.current, 'gui_config.json');
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(agentDirectory.current, { force: true, recursive: true });
  });

  async function loadConfigOnce() {
    vi.resetModules();
    const { ConfigManager } = await import('@/modules/config/ipc/manager');
    const loaded = ConfigManager.loadConfig();
    // The rewrite is queued behind the save queue so loading stays synchronous.
    await ConfigManager.flushPendingWrites();
    return loaded;
  }

  function readConfigFile(filePath = configPath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  it('rewrites the config and backs up the original on the first load', async () => {
    fs.writeFileSync(configPath, JSON.stringify(LEGACY_CONFIG, null, 2), 'utf-8');

    const loaded = await loadConfigOnce();

    expect(loaded.proxy.model_aliases).toEqual([
      { alias: 'my-fast', target: 'gemini-3-flash', enabled: true },
    ]);
    expect(readConfigFile().proxy).toMatchObject({
      model_aliases: [{ alias: 'my-fast', target: 'gemini-3-flash', enabled: true }],
      custom_mapping: {},
    });
    expect(
      readConfigFile(path.join(agentDirectory.current, 'gui_config.pre-model-alias-migration.json'))
        .proxy.custom_mapping,
    ).toEqual({ 'my-fast': 'gemini-3-flash' });
  });

  it('leaves the rewritten file alone on the next load', async () => {
    fs.writeFileSync(configPath, JSON.stringify(LEGACY_CONFIG, null, 2), 'utf-8');
    await loadConfigOnce();
    const afterFirstLoad = fs.readFileSync(configPath, 'utf-8');

    await loadConfigOnce();

    expect(fs.readFileSync(configPath, 'utf-8')).toBe(afterFirstLoad);
  });
});
