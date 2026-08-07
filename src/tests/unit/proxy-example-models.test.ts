import { describe, expect, it } from 'vitest';
import type { CloudQuotaModelInfo } from '@/modules/cloud-account/types';
import {
  buildProxyExampleModels,
  isImageProxyExampleModel,
} from '@/modules/proxy-gateway/components/proxy-example-models';

function quota(displayName?: string): CloudQuotaModelInfo {
  return {
    percentage: 100,
    resetTime: '',
    display_name: displayName,
  };
}

describe('proxy example models', () => {
  it('keeps dynamic quota models first, normalizes prefixes, and deduplicates ids', () => {
    const models = buildProxyExampleModels([
      {
        quota: {
          models: {
            'models/vendor-preview': quota(),
            'gemini-3-flash': quota(),
          },
        },
      },
      {
        quota: {
          models: {
            'VENDOR-PREVIEW': quota('Vendor Preview'),
          },
        },
      },
    ]);

    expect(models).toEqual([
      { id: 'vendor-preview', name: 'Vendor Preview' },
      { id: 'gemini-3-flash', name: 'gemini-3-flash' },
    ]);
  });

  it('does not invent example models when provider quota is unavailable', () => {
    expect(buildProxyExampleModels([])).toEqual([]);
  });

  it('uses the same public display preset ids as the API catalog', () => {
    expect(
      buildProxyExampleModels([
        {
          quota: {
            models: {
              'gemini-3-flash-agent': quota('Gemini 3.5 Flash (High)'),
            },
          },
        },
      ]),
    ).toEqual([{ id: 'gemini-3.5-flash-high', name: 'Gemini 3.5 Flash (High)' }]);
  });

  it('detects image variants without depending on a fixed suffix', () => {
    expect([
      isImageProxyExampleModel('gemini-3-pro-image'),
      isImageProxyExampleModel('gemini-3-pro-image-4k-16x9'),
      isImageProxyExampleModel('gemini-3.5-flash-high'),
    ]).toEqual([true, true, false]);
  });
});
