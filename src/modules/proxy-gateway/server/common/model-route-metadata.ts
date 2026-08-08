export interface ModelRouteMetadata {
  requestedModel: string;
  resolvedModel: string;
  servedModel?: string;
  routeSource: string;
  /**
   * Model the provider's `web_search` role nominated, when a request had to be
   * grounded by a separate search call. Absent on every other request.
   */
  webSearchModel?: string;
}

const MODEL_ROUTE_METADATA = Symbol('proxy-model-route-metadata');
const MAX_HEADER_VALUE_LENGTH = 256;

type ModelRouteMetadataCarrier = object & {
  [MODEL_ROUTE_METADATA]?: Readonly<ModelRouteMetadata>;
};

export function attachModelRouteMetadata<T extends object>(
  value: T,
  metadata: ModelRouteMetadata,
): T {
  Object.defineProperty(value, MODEL_ROUTE_METADATA, {
    configurable: true,
    value: Object.freeze({ ...metadata }),
  });
  return value;
}

export function getModelRouteMetadata(value: unknown): Readonly<ModelRouteMetadata> | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined;
  }
  return (value as ModelRouteMetadataCarrier)[MODEL_ROUTE_METADATA];
}

function sanitizeHeaderValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const sanitized = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint <= 0x7e;
    })
    .join('')
    .trim()
    .slice(0, MAX_HEADER_VALUE_LENGTH);
  return sanitized || undefined;
}

export function createModelRouteHeaders(
  metadata: Readonly<ModelRouteMetadata> | undefined,
): Record<string, string> {
  if (!metadata) {
    return {};
  }

  const headers = {
    'x-antigravity-requested-model': sanitizeHeaderValue(metadata.requestedModel),
    'x-antigravity-resolved-model': sanitizeHeaderValue(metadata.resolvedModel),
    'x-antigravity-served-model': sanitizeHeaderValue(metadata.servedModel),
    'x-antigravity-route-source': sanitizeHeaderValue(metadata.routeSource),
    'x-antigravity-web-search-model': sanitizeHeaderValue(metadata.webSearchModel),
    'x-antigravity-fallback-policy': 'none',
  };
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
