import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { isObservable, type Observable, type Subscription } from 'rxjs';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
  OpenAIResponsesWebSocketProtocol,
  OpenAIResponsesWebSocketProtocolError,
  type OpenAIResponsesWebSocketAction,
  type OpenAIResponsesWebSocketEvent,
} from './openai-responses-websocket-protocol';
import type { OpenAIResponsesSessionStoreLike } from './openai-responses-session.store';

const DEFAULT_MAX_CONNECTION_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_PING_INTERVAL_MS = 30 * 1000;

export interface OpenAIResponsesWebSocketServerDependencies {
  isAuthorized: (request: IncomingMessage) => boolean;
  maxConnectionDurationMs?: number;
  pingIntervalMs?: number;
  sessionStore?: OpenAIResponsesSessionStoreLike;
  streamRequest: (request: Record<string, unknown>) => Promise<Observable<unknown>>;
}

/**
 * Attaches the Responses WebSocket transport to an existing HTTP server.
 * Non-Responses upgrades remain available to other upgrade listeners.
 */
export function attachOpenAIResponsesWebSocketServer(
  server: Server,
  dependencies: OpenAIResponsesWebSocketServerDependencies,
): () => void {
  const webSocketServer = new WebSocketServer({ noServer: true });
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = resolvePathname(request.url);
    if (pathname !== '/v1/responses') {
      return;
    }
    if (!dependencies.isAuthorized(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  };

  webSocketServer.on('connection', (socket) => {
    handleConnection(socket, dependencies);
  });
  server.on('upgrade', handleUpgrade);

  return () => {
    server.off('upgrade', handleUpgrade);
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    webSocketServer.close();
  };
}

interface ActiveResponse {
  parser: UpstreamEventParser | null;
  responseId?: string;
  subscription: Subscription | null;
  terminal: boolean;
  token: number;
}

function handleConnection(
  socket: WebSocket,
  dependencies: OpenAIResponsesWebSocketServerDependencies,
): void {
  const protocol = new OpenAIResponsesWebSocketProtocol(dependencies.sessionStore);
  let active: ActiveResponse | null = null;
  let requestToken = 0;
  let serverSequenceNumber = 0;
  let pongReceived = true;

  const nextServerSequence = (): number => {
    const sequence = serverSequenceNumber;
    serverSequenceNumber += 1;
    return sequence;
  };

  const sendError = (error: unknown): void => {
    const normalized = normalizeProtocolError(error);
    sendEvent(socket, {
      type: 'error',
      sequence_number: nextServerSequence(),
      error: {
        code: normalized.code,
        message: normalized.message,
        param: normalized.param ?? null,
        type: normalized.type,
      },
    });
  };

  const clearActive = (expected: ActiveResponse): void => {
    if (active === expected) {
      active = null;
    }
  };

  const emitFailed = (state: ActiveResponse, error: unknown): void => {
    if (state.terminal) {
      return;
    }
    state.terminal = true;
    protocol.fail();
    const normalized = normalizeProtocolError(error);
    sendEvent(socket, {
      type: 'response.failed',
      sequence_number: nextServerSequence(),
      response: {
        id: state.responseId ?? `resp_failed_${randomUUID()}`,
        object: 'response',
        status: 'failed',
        output: [],
        error: {
          code: normalized.code,
          message: normalized.message,
          type: normalized.type,
        },
      },
    });
  };

  const consumeEvents = (state: ActiveResponse, events: OpenAIResponsesWebSocketEvent[]): void => {
    if (active !== state || state.terminal) {
      return;
    }
    for (const event of events) {
      const response = toRecord(event.response);
      const responseId = getString(response, 'id');
      if (responseId) {
        state.responseId = responseId;
      }
      sendEvent(socket, event);
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        state.terminal = true;
        protocol.complete(event.response);
        state.subscription?.unsubscribe();
        clearActive(state);
        break;
      }
      if (event.type === 'response.failed') {
        state.terminal = true;
        protocol.fail();
        state.subscription?.unsubscribe();
        clearActive(state);
        break;
      }
    }
  };

  const startRequest = (action: Extract<OpenAIResponsesWebSocketAction, { kind: 'request' }>) => {
    const state: ActiveResponse = {
      parser: null,
      subscription: null,
      terminal: false,
      token: ++requestToken,
    };
    active = state;

    void dependencies
      .streamRequest(action.request)
      .then((stream) => {
        if (active !== state || state.token !== requestToken) {
          return;
        }
        if (!isObservable(stream)) {
          throw new Error('Responses WebSocket upstream did not return a stream');
        }

        const parser = createUpstreamEventParser();
        state.parser = parser;
        const subscription = stream.subscribe({
          next: (chunk) => {
            try {
              consumeEvents(state, parser.push(chunk));
            } catch (error) {
              emitFailed(state, error);
              state.subscription?.unsubscribe();
              clearActive(state);
            }
          },
          error: (error: unknown) => {
            emitFailed(state, error);
            clearActive(state);
          },
          complete: () => {
            try {
              consumeEvents(state, parser.flush());
              if (!state.terminal) {
                emitFailed(state, new Error('upstream stream ended without a terminal event'));
              }
            } catch (error) {
              emitFailed(state, error);
            } finally {
              clearActive(state);
            }
          },
        });
        state.subscription = subscription;
        if (state.terminal || active !== state) {
          subscription.unsubscribe();
        }
      })
      .catch((error: unknown) => {
        if (active !== state) {
          return;
        }
        emitFailed(state, error);
        clearActive(state);
      });
  };

  const cancelActive = (
    action: Extract<OpenAIResponsesWebSocketAction, { kind: 'cancel' }>,
  ): void => {
    const state = active;
    if (!state) {
      sendError(
        new OpenAIResponsesWebSocketProtocolError(
          'there is no response currently in progress',
          'response_not_in_progress',
          'type',
        ),
      );
      return;
    }
    if (action.responseId && state.responseId && action.responseId !== state.responseId) {
      sendError(
        new OpenAIResponsesWebSocketProtocolError(
          `response ${action.responseId} is not in progress`,
          'response_not_in_progress',
          'response_id',
        ),
      );
      return;
    }

    requestToken += 1;
    state.subscription?.unsubscribe();
    protocol.cancel();
    clearActive(state);
    sendEvent(socket, {
      type: 'response.cancelled',
      sequence_number: nextServerSequence(),
      response: {
        id: action.responseId ?? state.responseId ?? `resp_cancelled_${randomUUID()}`,
        object: 'response',
        status: 'cancelled',
        output: [],
        error: null,
      },
    });
  };

  socket.on('message', (rawData) => {
    try {
      const payload = parseClientPayload(rawData);
      const payloadRecord = toRecord(payload);
      if (active && getString(payloadRecord, 'type') !== 'response.cancel') {
        sendError(
          new OpenAIResponsesWebSocketProtocolError(
            'only one response may be in progress on a WebSocket connection',
            'response_in_progress',
            'type',
          ),
        );
        return;
      }
      const action = protocol.accept(payload);
      if (action.kind === 'cancel') {
        cancelActive(action);
        return;
      }
      if (action.kind === 'local') {
        for (const event of action.events) {
          sendEvent(socket, event);
        }
        return;
      }
      startRequest(action);
    } catch (error) {
      sendError(error);
    }
  });

  socket.on('pong', () => {
    pongReceived = true;
  });

  const maxConnectionTimer = setTimeout(() => {
    sendError(
      new OpenAIResponsesWebSocketProtocolError(
        'Responses WebSocket connections are limited to 60 minutes',
        'websocket_connection_limit_reached',
      ),
    );
    active?.subscription?.unsubscribe();
    protocol.cancel();
    socket.close(1000, 'connection lifetime reached');
  }, dependencies.maxConnectionDurationMs ?? DEFAULT_MAX_CONNECTION_DURATION_MS);
  maxConnectionTimer.unref?.();

  const pingTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!pongReceived) {
      socket.terminate();
      return;
    }
    pongReceived = false;
    socket.ping();
  }, dependencies.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
  pingTimer.unref?.();

  socket.once('close', () => {
    clearTimeout(maxConnectionTimer);
    clearInterval(pingTimer);
    requestToken += 1;
    active?.subscription?.unsubscribe();
    active = null;
    protocol.cancel();
  });
}

function parseClientPayload(rawData: RawData): unknown {
  try {
    return JSON.parse(rawDataToString(rawData)) as unknown;
  } catch (error) {
    throw new OpenAIResponsesWebSocketProtocolError(
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'invalid_json',
      'body',
    );
  }
}

interface UpstreamEventParser {
  flush(): OpenAIResponsesWebSocketEvent[];
  push(chunk: unknown): OpenAIResponsesWebSocketEvent[];
}

function createUpstreamEventParser(): UpstreamEventParser {
  let buffer = '';

  const drain = (flush: boolean): OpenAIResponsesWebSocketEvent[] => {
    const events: OpenAIResponsesWebSocketEvent[] = [];
    while (true) {
      const separator = /\r?\n\r?\n/.exec(buffer);
      if (!separator || separator.index === undefined) {
        break;
      }
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const event = parseUpstreamEventBlock(block);
      if (event) {
        events.push(event);
      }
    }
    if (flush && buffer.trim().length > 0) {
      const event = parseUpstreamEventBlock(buffer);
      buffer = '';
      if (event) {
        events.push(event);
      }
    }
    return events;
  };

  return {
    flush: () => drain(true),
    push: (chunk: unknown) => {
      if (typeof chunk !== 'string') {
        return isResponsesEvent(chunk) ? [chunk] : [];
      }
      buffer += chunk;
      return drain(false);
    },
  };
}

function parseUpstreamEventBlock(block: string): OpenAIResponsesWebSocketEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    return isResponsesEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeProtocolError(error: unknown): {
  code: string;
  message: string;
  param?: string;
  type: string;
} {
  if (error instanceof OpenAIResponsesWebSocketProtocolError) {
    return {
      code: error.code,
      message: error.message,
      param: error.param,
      type: error.type,
    };
  }
  return {
    code: 'server_error',
    message: error instanceof Error ? error.message : String(error),
    type: 'server_error',
  };
}

function sendEvent(socket: WebSocket, event: OpenAIResponsesWebSocketEvent): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function rawDataToString(rawData: RawData): string {
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData).toString('utf8');
  }
  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString('utf8');
  }
  return rawData.toString('utf8');
}

function resolvePathname(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function isResponsesEvent(value: unknown): value is OpenAIResponsesWebSocketEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, 'type') === 'string'
  );
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
