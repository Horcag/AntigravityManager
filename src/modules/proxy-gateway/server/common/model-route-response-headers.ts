import { isObjectLike } from 'lodash-es';
import type { ModelRoutingService } from '../modules/shared/services/model-routing.service';
import {
  createModelRouteHeaders,
  getModelRouteMetadata,
  type ModelRouteMetadata,
} from './model-route-metadata';
import { asString } from './utils/json-record';

/**
 * The `x-model-route-*` headers a surface answers with.
 *
 * Upstream results usually carry their own route metadata. When they do not —
 * a buffered result that never travelled through the streaming path, say — the
 * route is recomputed from the routing service so the caller still learns which
 * model actually served the request.
 */
export function buildModelRouteResponseHeaders(
  result: unknown,
  requestedModel: string | undefined,
  modelRoutingService?: ModelRoutingService,
): Record<string, string> {
  let metadata = getModelRouteMetadata(result);
  if (!metadata && requestedModel && modelRoutingService) {
    const route = modelRoutingService.resolveModelRoute(requestedModel);
    const responseRecord = isObjectLike(result) ? (result as Record<string, unknown>) : undefined;
    metadata = {
      requestedModel,
      resolvedModel: route.targetModel,
      servedModel:
        asString(responseRecord?.model) ?? asString(responseRecord?.modelVersion) ?? undefined,
      routeSource: route.source,
    } satisfies ModelRouteMetadata;
  }
  return createModelRouteHeaders(metadata);
}
