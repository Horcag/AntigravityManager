import { UpstreamRequestError } from './upstream-request-exception';

export type ModelRouteErrorCode =
  | 'model_not_found'
  | 'model_catalog_unavailable'
  | 'model_capacity_exhausted';

export class ModelRouteError extends UpstreamRequestError {
  readonly code: ModelRouteErrorCode;

  constructor(params: { message: string; status: number; code: ModelRouteErrorCode }) {
    super({
      message: params.message,
      status: params.status,
      body: JSON.stringify({
        error: {
          code: params.status,
          message: params.message,
          status:
            params.status === 404
              ? 'NOT_FOUND'
              : params.status === 429
                ? 'RESOURCE_EXHAUSTED'
                : 'UNAVAILABLE',
        },
      }),
    });
    this.name = 'ModelRouteError';
    this.code = params.code;
  }
}
