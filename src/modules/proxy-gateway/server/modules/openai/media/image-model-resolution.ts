import { HttpStatus } from '@nestjs/common';
import type { CloudModelRoleId } from '@/modules/cloud-account/types';
import type { ModelRouteMetadata } from '../../../common/model-route-metadata';
import { ModelRouteError } from '../../../common/exceptions/model-route-exception';

/**
 * Which model `/v1/images/*` runs when the caller names none.
 *
 * The endpoint used to substitute a hard-coded `gemini-3.1-flash-image`, which
 * makes the caller responsible for knowing an image-capable id and goes stale
 * the moment the provider renames one. `fetchAvailableModels` already reports
 * the ids the provider itself uses for image generation, so the endpoint reads
 * them instead — and says so plainly when there are none, rather than guessing.
 */

export const IMAGE_GENERATION_ROLE: CloudModelRoleId = 'image_generation';

export type ImageModelSource = 'requested' | 'provider-role:image_generation';

export interface ImageModelResolution {
  /** Model the request is sent to. */
  model: string;
  /** What the caller asked for, when it asked for anything. */
  requestedModel?: string;
  source: ImageModelSource;
}

export function resolveImageGenerationModel(
  requestedModel: string | undefined,
  roleModelIds: readonly string[],
): ImageModelResolution {
  const requested = requestedModel?.trim();
  if (requested) {
    return { model: requested, requestedModel: requested, source: 'requested' };
  }

  // Provider order: the first entry is the id the IDE itself reaches for.
  const roleModel = roleModelIds.find((modelId) => modelId.trim().length > 0)?.trim();
  if (!roleModel) {
    throw new ModelRouteError({
      message:
        'No model was requested and no account reported a model for the provider image_generation role, so no image-capable model can be resolved',
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'model_catalog_unavailable',
    });
  }

  return { model: roleModel, source: 'provider-role:image_generation' };
}

/**
 * Route metadata for an image response, so a role-resolved model is as visible
 * in `x-antigravity-resolved-model` / `-served-model` as a configured alias is.
 * The upstream metadata still supplies the served model when it reported one.
 */
export function createImageRouteMetadata(
  resolution: ImageModelResolution,
  upstream: Readonly<ModelRouteMetadata> | undefined,
): ModelRouteMetadata {
  return {
    requestedModel: resolution.requestedModel ?? upstream?.requestedModel ?? '',
    resolvedModel: resolution.model,
    servedModel: upstream?.servedModel ?? resolution.model,
    routeSource:
      resolution.source === 'requested'
        ? (upstream?.routeSource ?? 'canonical')
        : resolution.source,
  };
}

/**
 * The provider's role -> model-id arrays, reported by `/v1/model-routes` beside
 * the configured aliases so a role-resolved route is inspectable the same way.
 */
export function buildModelRoleRoutes(
  getModelIdsForRole: (role: CloudModelRoleId) => string[],
): Record<string, string[]> {
  const roles: CloudModelRoleId[] = [
    'agent',
    'command',
    'tab',
    'image_generation',
    'mquery',
    'web_search',
    'commit_message',
    'audio_transcription',
  ];

  return Object.fromEntries(roles.map((role) => [role, getModelIdsForRole(role)]));
}
