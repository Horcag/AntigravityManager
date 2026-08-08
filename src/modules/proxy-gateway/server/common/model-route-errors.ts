import { HttpStatus } from '@nestjs/common';

import { ModelRouteError } from './exceptions/model-route-exception';

export interface ModelCatalogStatusReader {
  getModelCatalogStatus(model: string): string;
}

export interface ModelRouteMissRecorder {
  record(model: string): void;
}

/**
 * Builds the fail-closed error every protocol returns when no account can serve a model.
 *
 * Shared so that any endpoint routed through the model catalog — generation and token counting
 * alike — reports the same status, code and miss-journal side effect for the same situation.
 */
export function createNoAvailableAccountError(params: {
  accountLeaseService: ModelCatalogStatusReader;
  missJournal: ModelRouteMissRecorder;
  model: string;
}): ModelRouteError {
  const catalogStatus = params.accountLeaseService.getModelCatalogStatus(params.model);
  if (catalogStatus === 'unknown_model') {
    params.missJournal.record(params.model);
    return new ModelRouteError({
      message: `The requested model '${params.model}' is not present in the discovered provider catalog`,
      status: HttpStatus.NOT_FOUND,
      code: 'model_not_found',
    });
  }
  if (catalogStatus === 'catalog_unavailable') {
    return new ModelRouteError({
      message: `The provider model catalog is currently unavailable while resolving '${params.model}'`,
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'model_catalog_unavailable',
    });
  }
  return new ModelRouteError({
    message: `No account currently has capacity for model '${params.model}'`,
    status: HttpStatus.TOO_MANY_REQUESTS,
    code: 'model_capacity_exhausted',
  });
}
