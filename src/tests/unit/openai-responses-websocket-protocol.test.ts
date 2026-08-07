import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { of, Subject } from 'rxjs';

import {
  OpenAIResponsesWebSocketProtocol,
  OpenAIResponsesWebSocketProtocolError,
} from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-websocket-protocol';
import { OpenAIResponsesSessionStoreImpl } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';
import { attachOpenAIResponsesWebSocketServer } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-websocket.server';

describe('OpenAIResponsesWebSocketProtocol', () => {
  it('handles generate=false locally and reuses its defaults through previous_response_id', () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    const prewarm = protocol.accept({
      type: 'response.create',
      generate: false,
      model: 'gpt-5-codex',
      instructions: 'Work carefully',
      tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }],
    });

    expect(prewarm.kind).toBe('local');
    if (prewarm.kind !== 'local') {
      throw new Error('Expected a local prewarm response');
    }
    expect(prewarm.events.map((event) => event.type)).toEqual([
      'response.created',
      'response.completed',
    ]);
    expect(prewarm.events[0]).toMatchObject({ sequence_number: 0 });
    expect(prewarm.events[1]).toMatchObject({
      sequence_number: 1,
      response: {
        model: 'gpt-5-codex',
        output: [],
        status: 'completed',
      },
    });

    const response = prewarm.events[1].response as Record<string, unknown>;
    const next = protocol.accept({
      type: 'response.create',
      previous_response_id: response.id,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
    });
    expect(next).toMatchObject({
      kind: 'request',
      request: {
        model: 'gpt-5-codex',
        instructions: 'Work carefully',
        stream: true,
      },
    });
  });

  it('starts a new chain when previous_response_id is omitted', () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    const first = protocol.accept({
      type: 'response.create',
      model: 'gemini-3-flash',
      instructions: 'Do not carry this',
      input: 'first',
    });
    expect(first.kind).toBe('request');
    protocol.complete({
      id: 'resp_first',
      output: [{ type: 'message', role: 'assistant', content: 'answer' }],
    });

    const second = protocol.accept({
      type: 'response.create',
      model: 'gemini-3-flash',
      input: 'second',
    });

    expect(second).toMatchObject({
      kind: 'request',
      request: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'second' }],
          },
        ],
      },
    });
    if (second.kind === 'request') {
      expect(second.request).not.toHaveProperty('instructions');
    }
  });

  it('returns an OpenAI-shaped error for an unknown continuation id', () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();

    expect(() =>
      protocol.accept({
        type: 'response.create',
        previous_response_id: 'resp_missing',
        input: 'continue',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<OpenAIResponsesWebSocketProtocolError>>({
        code: 'previous_response_not_found',
        param: 'previous_response_id',
        type: 'invalid_request_error',
      }),
    );
  });

  it('keeps store=false continuations connection-local', () => {
    const persistentStore = new OpenAIResponsesSessionStoreImpl();
    const firstConnection = new OpenAIResponsesWebSocketProtocol(persistentStore);
    const prewarm = firstConnection.accept({
      type: 'response.create',
      generate: false,
      model: 'gemini-3-flash',
      store: false,
    });
    if (prewarm.kind !== 'local') {
      throw new Error('Expected local prewarm');
    }
    const responseId = String((prewarm.events[1].response as Record<string, unknown>).id);

    expect(
      firstConnection.accept({
        type: 'response.create',
        previous_response_id: responseId,
        input: 'local continuation',
      }).kind,
    ).toBe('request');
    expect(() =>
      new OpenAIResponsesWebSocketProtocol(persistentStore).accept({
        type: 'response.create',
        previous_response_id: responseId,
        input: 'different connection',
      }),
    ).toThrowError(expect.objectContaining({ code: 'previous_response_not_found' }));
  });

  it('continues an HTTP-style persisted session and publishes the WS result back', () => {
    const persistentStore = new OpenAIResponsesSessionStoreImpl();
    persistentStore.save('resp_http', {
      inputItems: [{ type: 'message', role: 'user', content: 'from http' }],
      model: 'gemini-3-flash',
      store: true,
    });
    const protocol = new OpenAIResponsesWebSocketProtocol(persistentStore);

    const action = protocol.accept({
      type: 'response.create',
      previous_response_id: 'resp_http',
      input: 'from websocket',
    });
    expect(action).toMatchObject({
      kind: 'request',
      request: {
        input: [
          expect.objectContaining({ content: 'from http' }),
          expect.objectContaining({ role: 'user' }),
        ],
      },
    });
    protocol.complete({
      id: 'resp_ws',
      output: [{ type: 'message', role: 'assistant', content: 'ws answer' }],
    });

    expect(persistentStore.get('resp_ws')?.inputItems).toEqual([
      expect.objectContaining({ content: 'from http' }),
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ content: 'ws answer' }),
    ]);
  });

  it('evicts a failed store=false parent as required by the WebSocket contract', () => {
    const protocol = new OpenAIResponsesWebSocketProtocol(new OpenAIResponsesSessionStoreImpl());
    const prewarm = protocol.accept({
      type: 'response.create',
      generate: false,
      model: 'gemini-3-flash',
      store: false,
    });
    if (prewarm.kind !== 'local') {
      throw new Error('Expected local prewarm');
    }
    const responseId = String((prewarm.events[1].response as Record<string, unknown>).id);
    protocol.accept({
      type: 'response.create',
      previous_response_id: responseId,
      input: 'will fail',
      store: false,
    });
    protocol.fail();

    expect(() =>
      protocol.accept({
        type: 'response.create',
        previous_response_id: responseId,
        input: 'retry',
      }),
    ).toThrowError(expect.objectContaining({ code: 'previous_response_not_found' }));
  });

  it('rejects the non-standard response.append alias', () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();

    expect(() => protocol.accept({ type: 'response.append', input: 'hello' })).toThrowError(
      expect.objectContaining({ code: 'unsupported_value', param: 'type' }),
    );
  });
});

describe('OpenAI Responses WebSocket transport', () => {
  it('serves prewarm events over GET /v1/responses without calling upstream', async () => {
    const server = createServer();
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: async () => {
        throw new Error('Prewarm must not call upstream');
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const received: Array<Record<string, unknown>> = [];
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'response.create',
            generate: false,
            model: 'gpt-5-codex',
          }),
        );
      });
      socket.on('message', (data) => {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (received.length === 2) {
          resolve(received);
        }
      });
    });

    expect(events.map((event) => event.type)).toEqual(['response.created', 'response.completed']);

    socket.close();
    detach();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('preserves Responses SSE events split across upstream chunks', async () => {
    const server = createServer();
    const response = {
      id: 'resp_split',
      object: 'response',
      status: 'completed',
      output: [],
    };
    const serialized = JSON.stringify({ type: 'response.completed', response });
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: async () =>
        of(`data: ${serialized.slice(0, 30)}`, `${serialized.slice(30)}\n\n`),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    const event = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'response.create',
            model: 'gpt-5-codex',
            input: [],
          }),
        );
      });
      socket.once('message', (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    expect(event).toEqual({ type: 'response.completed', response });

    socket.close();
    detach();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('flushes a terminal SSE event that has no trailing blank line', async () => {
    const server = createServer();
    const response = { id: 'resp_trailing', object: 'response', status: 'completed', output: [] };
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: async () =>
        of(`data: ${JSON.stringify({ type: 'response.completed', response })}`),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    const event = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send(JSON.stringify({ type: 'response.create', model: 'gemini-3-flash' }));
      });
      socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    expect(event).toEqual({ type: 'response.completed', response });
    socket.close();
    detach();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('cancels an active response without waiting for the upstream stream', async () => {
    const server = createServer();
    const upstream = new Subject<unknown>();
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: async () => upstream,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    const cancelled = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('error', reject);
      socket.on('message', (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === 'response.cancelled') {
          resolve(event);
        }
      });
    });
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'response.create', model: 'gemini-3-flash' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.send(JSON.stringify({ type: 'response.cancel' }));

    await expect(cancelled).resolves.toMatchObject({
      type: 'response.cancelled',
      response: { status: 'cancelled' },
    });
    expect(upstream.observed).toBe(false);

    socket.close();
    detach();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('rejects concurrent response.create events on one connection', async () => {
    const server = createServer();
    const upstream = new Subject<unknown>();
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: async () => upstream,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    await new Promise<void>((resolve) => socket.once('open', resolve));
    const errorEvent = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('error', reject);
      socket.on('message', (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === 'error') {
          resolve(event);
        }
      });
    });
    socket.send(JSON.stringify({ type: 'response.create', model: 'gemini-3-flash' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.send(JSON.stringify({ type: 'response.create', model: 'gemini-3-flash' }));

    await expect(errorEvent).resolves.toMatchObject({
      type: 'error',
      error: { code: 'response_in_progress' },
    });
    socket.send(JSON.stringify({ type: 'response.cancel' }));
    socket.close();
    detach();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('enforces the configured WebSocket connection lifetime', async () => {
    const server = createServer();
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      maxConnectionDurationMs: 20,
      pingIntervalMs: 10_000,
      streamRequest: async () => of(),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    const errorEvent = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('error', reject);
      socket.on('message', (data) => resolve(JSON.parse(data.toString())));
    });
    await new Promise<void>((resolve) => socket.once('open', resolve));

    await expect(errorEvent).resolves.toMatchObject({
      type: 'error',
      error: { code: 'websocket_connection_limit_reached' },
    });

    socket.close();
    detach();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
});
