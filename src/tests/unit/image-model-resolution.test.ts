import { describe, expect, it } from 'vitest';

import {
  buildModelRoleRoutes,
  createImageRouteMetadata,
  resolveImageGenerationModel,
} from '@/modules/proxy-gateway/server/modules/openai/media/image-model-resolution';
import { createModelRouteHeaders } from '@/modules/proxy-gateway/server/common/model-route-metadata';
import { AccountLeaseModelPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-model-policy';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';

// Ids measured in the wild (kanban #43): ours and the one other accounts report.
const OUR_IMAGE_MODEL = 'gemini-3.1-flash-image';
const OTHER_IMAGE_MODEL = 'gemini-2.5-flash-image';

describe('image generation model resolution', () => {
  it('resolves from the provider image_generation role when the caller names no model', () => {
    const resolution = resolveImageGenerationModel(undefined, [OUR_IMAGE_MODEL]);

    expect(resolution).toEqual({
      model: OUR_IMAGE_MODEL,
      source: 'provider-role:image_generation',
    });
  });

  it('takes the provider order, so the first role entry wins', () => {
    expect(resolveImageGenerationModel(' ', [OTHER_IMAGE_MODEL, OUR_IMAGE_MODEL]).model).toBe(
      OTHER_IMAGE_MODEL,
    );
  });

  it('keeps an explicitly requested model', () => {
    const resolution = resolveImageGenerationModel(OTHER_IMAGE_MODEL, [OUR_IMAGE_MODEL]);

    expect(resolution).toEqual({
      model: OTHER_IMAGE_MODEL,
      requestedModel: OTHER_IMAGE_MODEL,
      source: 'requested',
    });
  });

  it('fails with an explicit error rather than guessing when the role array is absent', () => {
    expect(() => resolveImageGenerationModel(undefined, [])).toThrowError(/image_generation role/);
  });

  it('reports a role-resolved model in the route headers with fallback policy none', () => {
    const headers = createModelRouteHeaders(
      createImageRouteMetadata(resolveImageGenerationModel(undefined, [OUR_IMAGE_MODEL]), {
        requestedModel: OUR_IMAGE_MODEL,
        resolvedModel: OUR_IMAGE_MODEL,
        servedModel: 'gemini-3.1-flash-image-preview',
        routeSource: 'canonical',
      }),
    );

    expect(headers['x-antigravity-resolved-model']).toBe(OUR_IMAGE_MODEL);
    expect(headers['x-antigravity-served-model']).toBe('gemini-3.1-flash-image-preview');
    expect(headers['x-antigravity-route-source']).toBe('provider-role:image_generation');
    expect(headers['x-antigravity-fallback-policy']).toBe('none');
  });

  it('falls back to the resolved model as served model when the upstream reported none', () => {
    const headers = createModelRouteHeaders(
      createImageRouteMetadata(
        resolveImageGenerationModel(undefined, [OUR_IMAGE_MODEL]),
        undefined,
      ),
    );

    expect(headers['x-antigravity-served-model']).toBe(OUR_IMAGE_MODEL);
  });
});

describe('provider role -> model id lookup', () => {
  function policyWith(tokens: Record<string, AccountLeaseTokenData>): AccountLeaseModelPolicy {
    return new AccountLeaseModelPolicy({
      getTokenCache: () => new Map(Object.entries(tokens)),
      logger: { log: () => {} },
    });
  }

  it('reads the ids the provider assigned to a role, in provider order', () => {
    const policy = policyWith({
      'account-1': {
        quota: {
          models: {},
          model_roles: {
            image_generation: [OUR_IMAGE_MODEL],
            web_search: ['gemini-3.1-flash-lite'],
          },
        },
      } as unknown as AccountLeaseTokenData,
    });

    expect(policy.getModelIdsForRole('image_generation')).toEqual([OUR_IMAGE_MODEL]);
    expect(policy.getModelIdsForRole('web_search')).toEqual(['gemini-3.1-flash-lite']);
  });

  it('unions the role across accounts without duplicating an id', () => {
    const policy = policyWith({
      'account-1': {
        quota: { models: {}, model_roles: { image_generation: [OUR_IMAGE_MODEL] } },
      } as unknown as AccountLeaseTokenData,
      'account-2': {
        quota: {
          models: {},
          model_roles: { image_generation: [OUR_IMAGE_MODEL, OTHER_IMAGE_MODEL] },
        },
      } as unknown as AccountLeaseTokenData,
    });

    expect(policy.getModelIdsForRole('image_generation')).toEqual([
      OUR_IMAGE_MODEL,
      OTHER_IMAGE_MODEL,
    ]);
  });

  it('returns an empty list when no account reported the role', () => {
    const policy = policyWith({
      'account-1': { quota: { models: {} } } as unknown as AccountLeaseTokenData,
    });

    expect(policy.getModelIdsForRole('image_generation')).toEqual([]);
    expect(() => resolveImageGenerationModel(undefined, [])).toThrowError();
  });

  it('exposes every role in the /v1/model-routes role map', () => {
    const roleRoutes = buildModelRoleRoutes((role) =>
      role === 'image_generation' ? [OUR_IMAGE_MODEL] : [],
    );

    expect(roleRoutes.image_generation).toEqual([OUR_IMAGE_MODEL]);
    expect(roleRoutes.web_search).toEqual([]);
    expect(Object.keys(roleRoutes)).toContain('audio_transcription');
  });
});
