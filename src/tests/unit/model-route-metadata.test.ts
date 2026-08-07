import { describe, expect, it } from 'vitest';
import {
  attachModelRouteMetadata,
  createModelRouteHeaders,
  getModelRouteMetadata,
} from '@/modules/proxy-gateway/server/common/model-route-metadata';

describe('model route metadata', () => {
  it('attaches non-enumerable route identity and emits stable headers', () => {
    const response = attachModelRouteMetadata(
      { id: 'response-1' },
      {
        requestedModel: 'my-fast',
        resolvedModel: 'gemini-3-flash',
        servedModel: 'gemini-3-flash-001',
        routeSource: 'configured',
      },
    );

    expect(Object.keys(response)).toEqual(['id']);
    expect(createModelRouteHeaders(getModelRouteMetadata(response))).toEqual({
      'x-antigravity-requested-model': 'my-fast',
      'x-antigravity-resolved-model': 'gemini-3-flash',
      'x-antigravity-served-model': 'gemini-3-flash-001',
      'x-antigravity-route-source': 'configured',
      'x-antigravity-fallback-policy': 'none',
    });
  });

  it('strips control and non-ASCII characters from user-derived header values', () => {
    expect(
      createModelRouteHeaders({
        requestedModel: 'model\r\nx-injected: yesλ',
        resolvedModel: 'gemini-3-flash',
        routeSource: 'configured',
      }),
    ).toMatchObject({
      'x-antigravity-requested-model': 'modelx-injected: yes',
      'x-antigravity-resolved-model': 'gemini-3-flash',
    });
  });
});
