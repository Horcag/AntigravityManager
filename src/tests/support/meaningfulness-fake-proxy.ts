/**
 * A conforming three-surface proxy the endpoint meaningfulness checker can be
 * run against inside a test.
 *
 * The slot that develops the checker cannot reach a live proxy, and a checker
 * that has never been executed is not evidence of anything. This server closes
 * that gap: by default it answers exactly what the vendors document, so a green
 * run proves the assertions are satisfiable; with `defects` it answers wrongly
 * in one specific way, so a red run proves the checker reports rather than
 * passes silently.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  jsonReply,
  type FakeProxyDefect,
  type FakeProxyReply,
  type FakeProxyRequest,
} from './fake-proxy-shared';
import { handleOpenAI } from './fake-proxy-openai';
import { handleAnthropic } from './fake-proxy-anthropic';
import { handleGemini } from './fake-proxy-gemini';

export { FAKE_PROXY_DEFECTS, FAKE_PROXY_MODEL } from './fake-proxy-shared';
export type { FakeProxyDefect } from './fake-proxy-shared';

export interface FakeProxyServer {
  baseUrl: string;
  close(): Promise<void>;
}

export interface FakeProxyOptions {
  defects?: readonly FakeProxyDefect[];
}

const SURFACE_HANDLERS = [handleOpenAI, handleAnthropic, handleGemini];

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

/**
 * The uploads check posts parts as multipart, so the body is no longer always
 * JSON. Anything that does not parse is handed on as an empty object and the
 * raw bytes travel beside it — a fake that threw here would report a transport
 * failure for a request the real proxy handles.
 */
function parseJsonBody(raw: Buffer): Record<string, unknown> {
  const text = raw.toString('utf8');
  if (text.trim().length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function send(response: ServerResponse, reply: FakeProxyReply): void {
  response.writeHead(reply.status, {
    'content-type': reply.contentType,
    ...(reply.headers ?? {}),
  });
  response.end(reply.body);
}

export async function startFakeProxy(options: FakeProxyOptions = {}): Promise<FakeProxyServer> {
  const defects = new Set(options.defects ?? []);
  const storedChatCompletions = new Map<string, Record<string, unknown>>();

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const rawBody = await readRawBody(request);
        const fakeRequest: FakeProxyRequest = {
          method: request.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: request.headers,
          body: parseJsonBody(rawBody),
          rawBody,
          defects,
          storedChatCompletions,
        };

        for (const handler of SURFACE_HANDLERS) {
          const reply = handler(fakeRequest);
          if (reply) {
            send(response, reply);
            return;
          }
        }

        send(
          response,
          jsonReply(404, {
            error: {
              message: `${fakeRequest.method} ${fakeRequest.path} is not implemented by the fake proxy`,
              type: 'invalid_request_error',
              code: 'unknown_route',
            },
          }),
        );
      } catch (error) {
        send(
          response,
          jsonReply(500, {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'server_error',
            },
          }),
        );
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
