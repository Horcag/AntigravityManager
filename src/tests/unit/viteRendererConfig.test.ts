import { beforeAll, describe, expect, it } from 'vitest';
import type { PluginOption, UserConfig } from 'vite';

async function loadRendererConfig() {
  // @ts-expect-error Vitest can load the root .mts config directly, while the app tsconfig emits declarations.
  return (await import('../../../vite.renderer.config.mts')).default;
}

async function resolveRendererConfig(mode: string) {
  const rendererConfig = await loadRendererConfig();

  if (typeof rendererConfig === 'function') {
    return rendererConfig({
      command: mode === 'production' ? 'build' : 'serve',
      mode,
    }) as UserConfig;
  }

  return rendererConfig as UserConfig;
}

function flattenPluginNames(plugins: PluginOption[] = []): string[] {
  return plugins.flatMap((plugin) => {
    if (!plugin) {
      return [];
    }

    if (Array.isArray(plugin)) {
      return flattenPluginNames(plugin);
    }

    if (typeof plugin === 'object' && 'name' in plugin && typeof plugin.name === 'string') {
      return [plugin.name];
    }

    return [];
  });
}

describe('renderer Vite config', () => {
  let productionConfig: UserConfig;
  let developmentConfig: UserConfig;

  beforeAll(async () => {
    productionConfig = await resolveRendererConfig('production');
    developmentConfig = await resolveRendererConfig('development');
  }, 30000);

  it('keeps code inspector out of production builds', () => {
    const config = productionConfig;

    expect(flattenPluginNames(config.plugins)).not.toContain('@code-inspector/vite');
  });

  it('keeps code inspector available during development', () => {
    const config = developmentConfig;

    expect(flattenPluginNames(config.plugins)).toContain('@code-inspector/vite');
  });

  it('defines NODE_ENV for renderer code without requiring Node integration', () => {
    const config = productionConfig;

    expect(config.define?.['process.env.NODE_ENV']).toBe(JSON.stringify('production'));
  });
});
