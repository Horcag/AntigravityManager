import type { FastifyRequest } from 'fastify';

/**
 * The two client dialects that share a path under `/v1`.
 *
 * OpenAI and Anthropic publish several resources at byte-identical URLs —
 * `/v1/files` and `/v1/models/{id}` among them — so one route table has to
 * answer both, and the answer has to be shaped for whoever asked.
 */
export type ClientDialect = 'anthropic' | 'openai';

/**
 * Anthropic clients always announce themselves with `anthropic-version` (their
 * SDKs send it on every call) or with `anthropic-beta`. Nothing on the OpenAI
 * side sends either header, so this is a signal rather than a guess.
 *
 * This rule was settled for `/v1/files` in kanban #48 and lives here so every
 * shared-path route decides the same way instead of growing its own variant.
 */
export function resolveClientDialect(request: FastifyRequest): ClientDialect {
  return readClientHeader(request, 'anthropic-version') ||
    readClientHeader(request, 'anthropic-beta')
    ? 'anthropic'
    : 'openai';
}

export function readClientHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}
