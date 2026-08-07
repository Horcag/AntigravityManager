import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/modules/shared/services/model-routing.service';
import { setServerConfig } from '../../server/server-config';
import { getAllDynamicModels } from '@/modules/proxy-gateway/antigravity/ModelMapping';

function createProxyConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    ...overrides,
    upstream_proxy: {
      ...DEFAULT_APP_CONFIG.proxy.upstream_proxy,
      ...(overrides.upstream_proxy ?? {}),
    },
  };
}

describe('ModelRoutingService', () => {
  beforeEach(() => {
    setServerConfig(createProxyConfig({}));
  });

  it('advertises only discovered models and concrete configured aliases', () => {
    expect(
      getAllDynamicModels(
        {
          'custom-fast': 'gemini-3.1-flash-lite',
          'custom-*': 'gemini-3-flash',
          dangling: ' ',
          'bad alias': 'gemini-3-flash',
        },
        ['models/gemini-3.1-flash-lite', ' gemini-3.1-flash-lite '],
      ),
    ).toEqual(['custom-fast', 'gemini-3.1-flash-lite']);
  });

  it('does not synthesize a model catalog when discovery is empty', () => {
    expect(getAllDynamicModels()).toEqual([]);
  });

  it('does not hide provider-discovered models based on family or endpoint heuristics', () => {
    expect(
      getAllDynamicModels({}, ['gemini-2.5-flash', 'gemini-3-pro-image', 'claude-sonnet-4-5']),
    ).toEqual(['claude-sonnet-4-5', 'gemini-2.5-flash', 'gemini-3-pro-image']);
  });

  it('normalizes only the Google resource path prefix', () => {
    const policy = new ModelRoutingService();

    expect(policy.normalizeGeminiModel('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(policy.resolveTargetModel('models/gemini-3-flash-preview')).toBe(
      'gemini-3-flash-preview',
    );
    expect(policy.resolveTargetModel('gemini-3-pro-image-preview')).toBe(
      'gemini-3-pro-image-preview',
    );
  });

  it('does not silently substitute model families or versions', () => {
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('gpt-4o')).toBe('gpt-4o');
    expect(policy.resolveTargetModel('claude-opus-4.6')).toBe('claude-opus-4.6');
    expect(policy.resolveTargetModel('gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
    expect(policy.resolveTargetModel('gemini-3-flash-image')).toBe('gemini-3-flash-image');
    expect(policy.resolveTargetModel('gemini-pro-agent')).toBe('gemini-pro-agent');
  });

  it('applies an explicit structured alias and reports its source', () => {
    setServerConfig(
      createProxyConfig({
        model_aliases: [{ alias: 'my-opus', target: 'claude-opus-4-6-thinking', enabled: true }],
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveModelRoute('my-opus')).toEqual({
      requestedModel: 'my-opus',
      normalizedModel: 'my-opus',
      targetModel: 'claude-opus-4-6-thinking',
      source: 'configured',
      alias: 'my-opus',
      enabled: true,
      wildcard: false,
    });
  });

  it('keeps a disabled structured alias canonical and shadows legacy mappings', () => {
    setServerConfig(
      createProxyConfig({
        model_aliases: [{ alias: 'custom-fast', target: 'gemini-3-flash', enabled: false }],
        custom_mapping: { 'custom-fast': 'gemini-3.1-flash-lite' },
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveModelRoute('custom-fast')).toEqual(
      expect.objectContaining({
        targetModel: 'custom-fast',
        source: 'disabled',
        enabled: false,
      }),
    );
  });

  it('preserves legacy wildcard mappings as explicit user configuration', () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: {
          'custom-*': 'gemini-3-flash',
        },
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('custom-fast')).toBe('gemini-3-flash');
  });

  it('adds Claude beta headers only for Claude-compatible models', () => {
    const policy = new ModelRoutingService();

    expect(policy.createModelSpecificHeaders('claude-sonnet-4-5')).toEqual({
      'anthropic-beta':
        'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    });
    expect(policy.createModelSpecificHeaders('gemini-3-flash')).toEqual({});
    expect(policy.createModelSpecificHeaders(undefined)).toEqual({});
  });
});
