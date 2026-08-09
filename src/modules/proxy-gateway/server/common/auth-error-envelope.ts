import type { RequestHeaders } from '../guards/api-key-auth.util';
import { resolveProxySurface, type ProxySurface } from './unimplemented-route';

/**
 * The surface an auth rejection is answered on, reusing the same route rules
 * `resolveProxySurface` applies to a 404, plus the `anthropic-version` /
 * `anthropic-beta` header check already used to disambiguate a path OpenAI and
 * Anthropic share (kanban #48). A path outside all three surfaces — the guard
 * only ever sits on `/v1` and `/v1beta` routes — falls back to the
 * OpenAI-compatible envelope rather than the framework's default.
 */
export function resolveAuthErrorSurface(request: {
  url?: string;
  headers: RequestHeaders;
}): ProxySurface {
  const surface = resolveProxySurface(request.url ?? '');
  if (surface === 'gemini' || surface === 'anthropic') {
    return surface;
  }
  return hasAnthropicHeader(request.headers) ? 'anthropic' : 'openai';
}

function hasAnthropicHeader(headers: RequestHeaders): boolean {
  return readHeader(headers, 'anthropic-version') !== undefined ||
    readHeader(headers, 'anthropic-beta') !== undefined;
}

function readHeader(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

/** The auth-failure envelope `surface` expects, carrying `message` at 401. */
export function buildAuthErrorBody(
  surface: ProxySurface,
  message: string,
): Record<string, unknown> {
  if (surface === 'anthropic') {
    return { type: 'error', error: { type: 'authentication_error', message } };
  }
  if (surface === 'gemini') {
    return { error: { code: 401, message, status: 'UNAUTHENTICATED' } };
  }
  return {
    error: { message, type: 'invalid_request_error', code: 'invalid_api_key', param: null },
  };
}
