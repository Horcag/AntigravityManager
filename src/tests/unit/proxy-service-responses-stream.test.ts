import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import { lastValueFrom, Observable, toArray } from 'rxjs';

import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

function parseEvent(frame: string): Record<string, unknown> {
  const [, dataLine] = frame.trim().split('\n');
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

function createResponsesStream(
  service: ProxyService,
  upstreamStream: NodeJS.ReadableStream,
): Observable<unknown> {
  const method: unknown = Reflect.get(service, 'processResponsesStreamResponse');
  if (typeof method !== 'function') {
    throw new Error('Responses stream processor is unavailable');
  }
  const result: unknown = Reflect.apply(method, service, [upstreamStream, 'gemini-3-pro']);
  if (!(result instanceof Observable)) {
    throw new Error('Responses stream processor did not return an Observable');
  }
  return result;
}

function createSyntheticResponsesStream(
  service: ProxyService,
  response: Record<string, unknown>,
): Observable<unknown> {
  const method: unknown = Reflect.get(service, 'createSyntheticResponsesStream');
  if (typeof method !== 'function') {
    throw new Error('Synthetic Responses stream creator is unavailable');
  }
  const result: unknown = Reflect.apply(method, service, [response]);
  if (!(result instanceof Observable)) {
    throw new Error('Synthetic Responses stream creator did not return an Observable');
  }
  return result;
}

describe('ProxyService Responses streaming', () => {
  it('keeps an otherwise idle Responses connection alive with SSE comments', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const subscription = createResponsesStream(
        new ProxyService({} as never, {} as never),
        new PassThrough(),
      ).subscribe((event) => events.push(String(event)));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(events).toContain(': ping\n\n');
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('processes a final buffered line and carries Gemini usage through completion', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstream = Readable.from([
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}}',
      ),
    ]);
    const events = (
      await lastValueFrom(createResponsesStream(service, upstream).pipe(toArray()))
    ).map((event) => parseEvent(String(event)));
    expect(events.map((event) => event.type)).toContain('response.completed');
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.at(-1)).toMatchObject({
      response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
    });
  });

  it('carries actual usage through a synthetic Responses completion event', async () => {
    const service = new ProxyService({} as never, {} as never);
    const stream = createSyntheticResponsesStream(service, {
      choices: [{ message: { content: 'ok' } }],
      model: 'gemini-3-pro',
      usage: { completion_tokens: 3, prompt_tokens: 2, total_tokens: 5 },
    });

    const events = (await lastValueFrom(stream.pipe(toArray()))).map((event) =>
      parseEvent(String(event)),
    );
    expect(events.at(-1)).toMatchObject({
      response: {
        status: 'completed',
        usage: {
          input_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 3,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 5,
        },
      },
      type: 'response.completed',
    });
  });

  it('preserves Responses usage parity for live and synthetic Gemini thinking output', async () => {
    const service = new ProxyService({} as never, {} as never);
    const liveUpstream = Readable.from([
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":5,"thoughtsTokenCount":2,"totalTokenCount":10}}}\n',
      ),
    ]);
    const liveEvents = (
      await lastValueFrom(createResponsesStream(service, liveUpstream).pipe(toArray()))
    ).map((event) => parseEvent(String(event)));
    const syntheticEvents = (
      await lastValueFrom(
        createSyntheticResponsesStream(service, {
          choices: [{ message: { content: 'ok' } }],
          model: 'gemini-3-pro',
          usage: {
            completion_tokens: 7,
            completion_tokens_details: { reasoning_tokens: 2 },
            prompt_tokens: 3,
            total_tokens: 10,
          },
        }).pipe(toArray()),
      )
    ).map((event) => parseEvent(String(event)));

    const expectedUsage = {
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 10,
    };
    expect(liveEvents.at(-1)).toMatchObject({ response: { usage: expectedUsage } });
    expect(syntheticEvents.at(-1)).toMatchObject({ response: { usage: expectedUsage } });
  });

  it('reports null usage rather than fabricated counters when synthetic usage is unavailable', async () => {
    const stream = createSyntheticResponsesStream(new ProxyService({} as never, {} as never), {
      choices: [{ message: { content: 'ok' } }],
      model: 'gemini-3-pro',
    });

    const events = (await lastValueFrom(stream.pipe(toArray()))).map((event) =>
      parseEvent(String(event)),
    );
    expect(events.at(-1)).toMatchObject({
      response: { status: 'completed', usage: null },
      type: 'response.completed',
    });
    expect(JSON.stringify(events.at(-1))).not.toContain('input_tokens');
  });

  it('accepts a usage-only frame after a usable candidate', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstream = Readable.from([
      Buffer.from('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]} }]}}\n\n'),
      Buffer.from(
        'data: {"response":{"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}}\n\n',
      ),
    ]);
    const events = (
      await lastValueFrom(createResponsesStream(service, upstream).pipe(toArray()))
    ).map((event) => parseEvent(String(event)));
    expect(events.at(-1)).toMatchObject({
      response: {
        status: 'completed',
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      },
    });
  });

  it('does not fabricate or erase usage when later metadata has no counters', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstream = Readable.from([
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]} }],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50,"totalTokenCount":150}}}\n\n',
      ),
      Buffer.from('data: {"response":{"usageMetadata":{"trafficType":"ON_DEMAND"}}}\n\n'),
    ]);
    const events = (
      await lastValueFrom(createResponsesStream(service, upstream).pipe(toArray()))
    ).map((event) => parseEvent(String(event)));

    expect(events.at(-1)).toMatchObject({
      response: {
        status: 'completed',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
      },
      type: 'response.completed',
    });
  });

  it('keeps usage null when an upstream candidate has empty metadata', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstream = Readable.from([
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{}}}\n\n',
      ),
    ]);
    const events = (
      await lastValueFrom(createResponsesStream(service, upstream).pipe(toArray()))
    ).map((event) => parseEvent(String(event)));

    expect(events.at(-1)).toMatchObject({
      response: { status: 'completed', usage: null },
      type: 'response.completed',
    });
    expect(JSON.stringify(events.at(-1))).not.toContain('input_tokens');
  });

  it.each([
    ['malformed JSON', Readable.from([Buffer.from('data: {oops\n\n')])],
    ['upstream error', Readable.from([Buffer.from('data: {"error":{"message":"nope"}}\n\n')])],
    ['empty stream', Readable.from([])],
    [
      'candidate-free stream',
      Readable.from([Buffer.from('data: {"response":{"candidates":[]}}\n\n')]),
    ],
  ])('emits one failed termination for %s', async (_name, upstream) => {
    const events = (
      await lastValueFrom(
        createResponsesStream(new ProxyService({} as never, {} as never), upstream).pipe(toArray()),
      )
    ).map((event) => parseEvent(String(event)));
    expect(events.map((event) => event.type).slice(-2)).toEqual(['error', 'response.failed']);
    expect(events.filter((event) => event.type === 'response.failed')).toHaveLength(1);
  });

  it('terminates an upstream error event without emitting DONE or subscriber errors', async () => {
    const upstream = new PassThrough();
    const events: string[] = [];
    let subscriberError: unknown;
    const completed = new Promise<void>((resolve) => {
      createResponsesStream(new ProxyService({} as never, {} as never), upstream).subscribe({
        complete: resolve,
        error: (error: unknown) => {
          subscriberError = error;
          resolve();
        },
        next: (event) => events.push(String(event)),
      });
    });
    upstream.emit('error', new Error('socket reset'));
    await completed;
    const parsedEvents = events.filter((event) => event.startsWith('event:')).map(parseEvent);
    expect(parsedEvents.slice(-2)).toEqual([
      {
        code: 'upstream_error',
        message: 'socket reset',
        param: null,
        sequence_number: 2,
        type: 'error',
      },
      expect.objectContaining({
        response: expect.objectContaining({
          error: { code: 'upstream_error', message: 'socket reset' },
          status: 'failed',
        }),
        sequence_number: 3,
        type: 'response.failed',
      }),
    ]);
    expect(events).not.toContain('data: [DONE]\n\n');
    expect(subscriberError).toBeUndefined();
  });

  it('terminates an idle stream once without emitting DONE or subscriber errors', async () => {
    vi.useFakeTimers();
    try {
      const upstream = new PassThrough();
      const events: string[] = [];
      let subscriberError: unknown;
      createResponsesStream(new ProxyService({} as never, {} as never), upstream).subscribe({
        error: (error: unknown) => {
          subscriberError = error;
        },
        next: (event) => events.push(String(event)),
      });
      await vi.advanceTimersByTimeAsync(300_000);
      const parsedEvents = events.filter((event) => event.startsWith('event:')).map(parseEvent);
      expect(parsedEvents.map((event) => event.type)).toEqual([
        'response.created',
        'response.in_progress',
        'error',
        'response.failed',
      ]);
      expect(parsedEvents.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3]);
      expect(parsedEvents[2]).toEqual({
        code: 'stream_timeout',
        message: 'Upstream Responses stream timed out',
        param: null,
        sequence_number: 2,
        type: 'error',
      });
      expect(events).not.toContain('data: [DONE]\n\n');
      expect(subscriberError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
