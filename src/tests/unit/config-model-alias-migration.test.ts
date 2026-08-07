import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { migrateLegacyModelAliases } from '@/modules/config/model-alias-migration';

describe('migrateLegacyModelAliases', () => {
  it('moves legacy routes into the editable table without changing precedence', () => {
    const migrated = migrateLegacyModelAliases({
      ...DEFAULT_APP_CONFIG.proxy,
      model_aliases: [
        { alias: 'my-fast', target: 'gemini-3-flash', enabled: false },
        { alias: '  my-pro  ', target: '  gemini-3.1-pro-high  ', enabled: true },
      ],
      custom_mapping: {
        'MY-FAST': 'gemini-3.1-flash-lite',
        legacy: 'gemini-2.5-flash',
      },
      anthropic_mapping: {
        legacy: 'claude-sonnet-4-6-thinking',
        'claude-*': 'claude-sonnet-4-6-thinking',
      },
    });

    expect(migrated.model_aliases).toEqual([
      { alias: 'my-fast', target: 'gemini-3-flash', enabled: false },
      { alias: 'my-pro', target: 'gemini-3.1-pro-high', enabled: true },
      { alias: 'legacy', target: 'gemini-2.5-flash', enabled: true },
      { alias: 'claude-*', target: 'claude-sonnet-4-6-thinking', enabled: true },
    ]);
    expect(migrated.custom_mapping).toEqual({});
    expect(migrated.anthropic_mapping).toEqual({});
  });

  it('keeps a fresh configuration alias-free', () => {
    expect(migrateLegacyModelAliases(DEFAULT_APP_CONFIG.proxy).model_aliases).toEqual([]);
  });
});
