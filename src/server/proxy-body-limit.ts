import { OPENAI_JSON_BODY_LIMIT_BYTES } from '../modules/proxy-gateway/server/modules/openai/media/openai-media-request-contract';
import { ANTHROPIC_MESSAGES_BODY_LIMIT_BYTES } from '../modules/proxy-gateway/server/modules/anthropic/anthropic-request-contract';

interface ProxyRouteOptions {
  bodyLimit?: number;
  method: string | string[];
  url: string;
}

const LARGE_INLINE_MEDIA_ROUTES = new Set([
  '/v1/audio/transcriptions',
  '/v1/chat/completions',
  '/v1/images/edits',
  '/v1/images/generations',
  '/v1/responses',
]);

function acceptsPost(method: string | string[]): boolean {
  const methods = Array.isArray(method) ? method : [method];
  return methods.some((value) => value.toUpperCase() === 'POST');
}

export function resolveProxyRouteBodyLimit(
  method: string | string[],
  url: string,
): number | undefined {
  if (!acceptsPost(method)) {
    return undefined;
  }
  if (url === '/v1/messages') {
    return ANTHROPIC_MESSAGES_BODY_LIMIT_BYTES;
  }
  if (LARGE_INLINE_MEDIA_ROUTES.has(url) || url.startsWith('/v1beta/models/')) {
    return OPENAI_JSON_BODY_LIMIT_BYTES;
  }
  return undefined;
}

export function applyProxyRouteBodyLimit(routeOptions: ProxyRouteOptions): void {
  const bodyLimit = resolveProxyRouteBodyLimit(routeOptions.method, routeOptions.url);
  if (bodyLimit !== undefined) {
    routeOptions.bodyLimit = bodyLimit;
  }
}
