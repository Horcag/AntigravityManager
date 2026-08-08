import type { FastifyInstance } from 'fastify';

/**
 * The body parsers every proxy surface is served behind.
 *
 * Registered from one place so the real server and the conformance harness
 * parse a request identically — a parser only `main.ts` installs is a parser no
 * test can observe.
 */

/**
 * Methods that carry no payload of their own.
 *
 * Fastify still runs the JSON parser for `DELETE` and `OPTIONS` when the
 * request announces `Content-Type: application/json`, and the default parser
 * rejects the empty body those methods send. `GET`/`HEAD` are listed for
 * completeness; Fastify does not parse a body for them at all.
 */
const METHODS_WITHOUT_REQUEST_BODY = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS']);

/**
 * Lets `POST /upload/v1beta/files` accept Google's simple media form, where the
 * whole request body is the file and `Content-Type` names its type.
 *
 * The parser is registered for media families only. `application/json` and
 * `multipart/form-data` already have exact-match parsers, and Fastify prefers
 * an exact match over a matcher, so every existing route keeps its current
 * behaviour.
 */
function registerRawMediaBodyParser(instance: FastifyInstance): void {
  instance.addContentTypeParser(
    /^(?:application|audio|font|image|model|text|video)\//u,
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body as Buffer);
    },
  );
}

/**
 * Makes an empty body legal on a method that carries none, and leaves every
 * other JSON request exactly as it was parsed before.
 *
 * `DELETE /v1/responses/{id}` and `DELETE /v1/model-routes/miss-journal` used
 * to answer 400 `Body cannot be empty when content-type is set to
 * 'application/json'` to any client that sets a JSON content type globally,
 * while the identical call without the header answered 200. That is the default
 * parser refusing an empty body, not a handler, but from outside it reads as a
 * broken endpoint.
 *
 * Only the empty-and-bodyless case is intercepted. Everything else is handed to
 * Fastify's own default JSON parser, so an empty `POST` body still fails with
 * the same `FST_ERR_CTP_EMPTY_JSON_BODY` — there the emptiness is a real client
 * error — and prototype-poisoning protection is unchanged.
 *
 * This replaces the parser `@nestjs/platform-fastify` installs, which is why it
 * has to run once the Nest application has initialised; see
 * {@link registerProxyBodyParsers}. `bodyLimit` and the poisoning options are
 * carried over from that registration, and the body is read as a string, which
 * is how Fastify reads it for its own default JSON parser.
 */
function registerEmptyTolerantJsonBodyParser(instance: FastifyInstance): void {
  const { bodyLimit, onProtoPoisoning, onConstructorPoisoning } = instance.initialConfig;
  const parseJson = instance.getDefaultJsonParser(
    onProtoPoisoning ?? 'error',
    onConstructorPoisoning ?? 'error',
  );

  instance.removeContentTypeParser('application/json');
  instance.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string', bodyLimit },
    (request, body, done) => {
      if (
        METHODS_WITHOUT_REQUEST_BODY.has((request.method ?? '').toUpperCase()) &&
        isEmptyBody(body)
      ) {
        done(null, undefined);
        return;
      }

      parseJson(request, body, done);
    },
  );
}

function isEmptyBody(body: string | undefined | null): boolean {
  return body === undefined || body === null || body.trim() === '';
}

/**
 * Installs the parsers on a Fastify instance that already carries Nest's own.
 *
 * Call after `NestApplication.init()` — which is where
 * `@nestjs/platform-fastify` registers its `application/json` and
 * `application/x-www-form-urlencoded` parsers — and before `ready()`/`listen()`,
 * after which Fastify refuses to change the parser table. Calling it earlier
 * makes Nest's own registration fail with `Content type parser
 * 'application/json' already present`.
 */
export function registerProxyBodyParsers(instance: FastifyInstance): void {
  registerEmptyTolerantJsonBodyParser(instance);
  registerRawMediaBodyParser(instance);
}
