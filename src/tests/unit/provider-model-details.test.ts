import { describe, expect, it } from 'vitest';
import { toProviderModelDetails } from '@/modules/proxy-gateway/server/modules/account-lease/model-details/provider-model-details';

describe('toProviderModelDetails', () => {
  it('keeps provider-stated limits and modalities from fetchAvailableModels', () => {
    const details = toProviderModelDetails({
      percentage: 65,
      resetTime: '2026-08-09T00:00:00Z',
      max_tokens: 32_768,
      max_output_tokens: 16_384,
      thinking_budget: 8_192.8,
      supports_images: true,
      supports_video: false,
      supports_pdf: true,
      supported_mime_types: {
        'application/pdf': true,
        'image/png': true,
      },
    });

    expect(details).toEqual({
      maxOutputTokens: 16_384,
      thinkingBudget: 8_192,
      modalities: {
        supportsImages: true,
        supportsVideo: false,
        supportsPdf: true,
        supportedMimeTypes: {
          'application/pdf': true,
          'image/png': true,
        },
      },
    });
  });

  it('leaves fallback selection to callers when ModelDetails is silent', () => {
    expect(
      toProviderModelDetails({
        percentage: 100,
        resetTime: '2026-08-09T00:00:00Z',
      }),
    ).toBeUndefined();
  });
});
