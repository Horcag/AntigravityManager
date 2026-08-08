/**
 * The answer a compatible surface owes a caller for a route it does not serve.
 *
 * Without this the framework's own 404 (`{"message":"Cannot POST /v1/embeddings",
 * "error":"Not Found","statusCode":404}`) reaches the client. An OpenAI SDK
 * reads `error.type` / `error.code`, an Anthropic SDK reads `error.type`, and a
 * Gemini client reads `error.status` — none of those exist in that envelope, so
 * every one of them mis-parses the failure instead of reporting it.
 *
 * The rules live here, apart from the filter that applies them, so they can be
 * exercised without standing up an HTTP server.
 */

export type ProxySurface = 'openai' | 'anthropic' | 'gemini';

/** Paths Anthropic owns under `/v1`; everything else there is OpenAI-compatible. */
const ANTHROPIC_PATHS = /^\/v1\/(?:messages(?:$|\/)|complete$)/iu;

const GEMINI_PREFIXES = ['/v1beta/', '/upload/v1beta/'];

/**
 * The surface a path belongs to, or null when it is not one of ours — a
 * mistyped URL outside the API surfaces keeps the framework's own answer.
 */
export function resolveProxySurface(path: string): ProxySurface | null {
  const normalized = normalizePath(path);
  if (GEMINI_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return 'gemini';
  }
  if (!normalized.startsWith('/v1/')) {
    return null;
  }
  return ANTHROPIC_PATHS.test(normalized) ? 'anthropic' : 'openai';
}

/**
 * Why this particular route cannot be served.
 *
 * Two of them have a known cause rather than a missing implementation, and
 * saying "not yet implemented" for those would promise a handler that can never
 * be written:
 *
 * - **Embeddings** — the transport carries no embedding RPC at all. That is what
 *   the vendor's protobuf descriptors show, and Google's own `gemini-cli`
 *   implements `embedContent()` as a `throw`.
 * - **Context caching** — measured 2026-08-09: three identical requests with a
 *   6788-token system block marked `cache_control: {"type":"ephemeral"}` each
 *   returned `cache_read_input_tokens: 0` with `input_tokens` unchanged. There
 *   is no cache to address and no CRUD to create one.
 */
export const EMBEDDINGS_UNAVAILABLE_REASON =
  'is unavailable on this transport: the Antigravity endpoint this proxy fronts exposes no embedding RPC, so no embedding can be produced for any model';

export const CONTEXT_CACHE_UNAVAILABLE_REASON =
  'is unavailable on this transport: it serves no context cache — there is no cache resource to address and cache_control markers are ignored upstream';

export function describeUnimplementedRoute(method: string, path: string): string {
  const route = `${method.toUpperCase()} ${normalizePath(path)}`;
  if (isEmbeddingRoute(path)) {
    return `${route} ${EMBEDDINGS_UNAVAILABLE_REASON}.`;
  }
  if (isContextCacheRoute(path)) {
    return `${route} ${CONTEXT_CACHE_UNAVAILABLE_REASON}.`;
  }
  return `${route} is not supported by this transport: the Antigravity endpoint this proxy fronts has no equivalent operation.`;
}

/** The error envelope `surface` documents, carrying `message` at `status`. */
export function buildUnimplementedRouteBody(
  surface: ProxySurface,
  message: string,
  status: number,
  requestId: string,
): Record<string, unknown> {
  if (surface === 'anthropic') {
    return {
      type: 'error',
      error: { type: 'not_found_error', message },
      request_id: requestId,
    };
  }
  if (surface === 'gemini') {
    return { error: { code: status, message, status: 'NOT_FOUND' } };
  }
  return {
    error: { message, type: 'invalid_request_error', param: null, code: 'unknown_url' },
  };
}

function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? path;
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/u, '') : withoutQuery;
}

function isEmbeddingRoute(path: string): boolean {
  return /(?:^\/v1\/embeddings$|:(?:embedContent|batchEmbedContents)$)/iu.test(normalizePath(path));
}

function isContextCacheRoute(path: string): boolean {
  return /^\/v1beta\/cachedContents(?:$|\/)/iu.test(normalizePath(path));
}
