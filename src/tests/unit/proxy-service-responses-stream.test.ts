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
  configuration?: Record<string, unknown>,
): Observable<unknown> {
  const method: unknown = Reflect.get(service, 'processResponsesStreamResponse');
  if (typeof method !== 'function') {
    throw new Error('Responses stream processor is unavailable');
  }
  const result: unknown = Reflect.apply(method, service, [
    upstreamStream,
    'gemini-3-pro',
    undefined,
    configuration,
  ]);
  if (!(result instanceof Observable)) {
    throw new Error('Responses stream processor did not return an Observable');
  }
  return result;
}

function createSyntheticResponsesStream(
  service: ProxyService,
  response: Record<string, unknown>,
  configuration?: Record<string, unknown>,
): Observable<unknown> {
  const method: unknown = Reflect.get(service, 'createSyntheticResponsesStream');
  if (typeof method !== 'function') {
    throw new Error('Synthetic Responses stream creator is unavailable');
  }
  const result: unknown = Reflect.apply(method, service, [response, configuration]);
  if (!(result instanceof Observable)) {
    throw new Error('Synthetic Responses stream creator did not return an Observable');
  }
  return result;
}

describe('ProxyService Responses streaming', () => {
  it('preserves metadata in every live and synthetic Responses snapshot', async () => {
    const service = new ProxyService({} as never, {} as never);
    const configuration = {
      instructions: null,
      max_output_tokens: null,
      metadata: { request_id: 'req_123' },
      parallel_tool_calls: true as const,
      previous_response_id: null,
      reasoning: null,
      store: false as const,
      temperature: 1,
      text: { format: { type: 'text' as const } },
      tool_choice: 'auto',
      tools: [],
      top_p: 1,
      truncation: 'disabled' as const,
    };
    const liveEvents = (
      await lastValueFrom(
        createResponsesStream(
          service,
          Readable.from([
            Buffer.from(
              'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]} ,"finishReason":"STOP"}]}}\n\n',
            ),
          ]),
          configuration,
        ).pipe(toArray()),
      )
    ).map((event) => parseEvent(String(event)));
    const syntheticEvents = (
      await lastValueFrom(
        createSyntheticResponsesStream(
          service,
          { choices: [{ message: { content: 'ok' } }], model: 'gemini-3-pro' },
          configuration,
        ).pipe(toArray()),
      )
    ).map((event) => parseEvent(String(event)));

    for (const events of [liveEvents, syntheticEvents]) {
      const responseSnapshots = events.filter((event) => event.response !== undefined);
      expect(responseSnapshots).not.toHaveLength(0);
      for (const event of responseSnapshots) {
        expect((event.response as Record<string, unknown>).metadata).toEqual(
          configuration.metadata,
        );
      }
    }
  });

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
      response: {
        output: [expect.objectContaining({ status: 'completed', type: 'message' })],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      },
    });
  });

  it('accepts a no-space SSE data frame as a normal Responses stream', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstream = Readable.from([
      Buffer.from(
        'data:{"response":{"candidates":[{"content":{"parts":[{"text":"ok"} ]},"finishReason":"STOP"}]}}\n\n',
      ),
    ]);
    const events = (
      await lastValueFrom(createResponsesStream(service, upstream).pipe(toArray()))
    ).map((event) => parseEvent(String(event)));

    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  it('skips empty SSE keepalives before a normal Responses completion', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstream = Readable.from([
      Buffer.from(
        'data:\n\ndata: \n\ndata:{"response":{"candidates":[{"content":{"parts":[{"text":"kept alive"}]},"finishReason":"STOP"}]}}\n\n',
      ),
    ]);
    const events = (
      await lastValueFrom(createResponsesStream(service, upstream).pipe(toArray()))
    ).map((event) => parseEvent(String(event)));

    expect(events.map((event) => event.type)).toContain('response.output_text.delta');
    expect(events.map((event) => event.type)).toContain('response.completed');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(JSON.stringify(events)).toContain('kept alive');
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
        output: [expect.objectContaining({ status: 'completed', type: 'message' })],
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

  it('reports incomplete MAX_TOKENS Responses streams from live Gemini', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstream = Readable.from([
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"cut off"}]},"finishReason":"mAx_ToKeNs"}]}}\n\n',
      ),
    ]);
    const liveEvents = (
      await lastValueFrom(createResponsesStream(service, upstream).pipe(toArray()))
    ).map((event) => parseEvent(String(event)));
    const textItemDone = liveEvents.find(
      (event) =>
        event.type === 'response.output_item.done' &&
        (event.item as Record<string, unknown>).type === 'message',
    );
    expect(liveEvents.at(-1)).toMatchObject({
      response: {
        completed_at: null,
        incomplete_details: { reason: 'max_output_tokens' },
        output: [expect.objectContaining({ status: 'incomplete', type: 'message' })],
        status: 'incomplete',
      },
      type: 'response.incomplete',
    });
    expect(textItemDone).toMatchObject({ item: { status: 'incomplete', type: 'message' } });
  });

  it.each([
    ['length', 'response.incomplete', 'incomplete', { reason: 'max_output_tokens' }],
    ['content_filter', 'response.incomplete', 'incomplete', { reason: 'content_filter' }],
    ['stop', 'response.completed', 'completed', null],
    ['tool_calls', 'response.completed', 'completed', null],
    ['function_call', 'response.completed', 'completed', null],
  ])(
    'preserves synthetic OpenAI finish reason %s',
    async (finishReason, terminalType, status, incompleteDetails) => {
      const service = new ProxyService({} as never, {} as never);
      const events = (
        await lastValueFrom(
          createSyntheticResponsesStream(service, {
            choices: [{ finish_reason: finishReason, message: { content: 'done' } }],
            model: 'gemini-3-pro',
          }).pipe(toArray()),
        )
      ).map((event) => parseEvent(String(event)));

      expect(events.at(-1)).toMatchObject({
        response: { incomplete_details: incompleteDetails, status },
        type: terminalType,
      });
    },
  );

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
    ['empty parts', { content: { parts: [{}] }, finishReason: 'STOP' }],
    ['empty text', { content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
    [
      'signature-only thought',
      {
        content: {
          parts: [{ text: 'internal reasoning', thought: true, thoughtSignature: 'c2lnbmF0dXJl' }],
        },
        finishReason: 'STOP',
      },
    ],
    ['finish reason only', { finishReason: 'STOP' }],
  ])('fails an unusable candidate with %s as an empty stream', async (_name, candidate) => {
    const upstream = Readable.from([
      Buffer.from(`data: ${JSON.stringify({ response: { candidates: [candidate] } })}\n\n`),
    ]);
    const events = (
      await lastValueFrom(
        createResponsesStream(new ProxyService({} as never, {} as never), upstream).pipe(toArray()),
      )
    ).map((event) => parseEvent(String(event)));

    expect(events.map((event) => event.type).slice(-2)).toEqual(['error', 'response.failed']);
    expect(events.at(-2)).toMatchObject({ code: 'empty_stream' });
    expect(events.at(-1)).toMatchObject({
      response: { error: { code: 'empty_stream' }, status: 'failed' },
      type: 'response.failed',
    });
  });

  it('fails a usage-only stream as empty output', async () => {
    const upstream = Readable.from([
      Buffer.from(
        'data: {"response":{"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}}\n\n',
      ),
    ]);
    const events = (
      await lastValueFrom(
        createResponsesStream(new ProxyService({} as never, {} as never), upstream).pipe(toArray()),
      )
    ).map((event) => parseEvent(String(event)));

    expect(events.map((event) => event.type).slice(-2)).toEqual(['error', 'response.failed']);
    expect(events.at(-2)).toMatchObject({ code: 'empty_stream' });
  });

  it.each([
    ['text', { content: { parts: [{ text: 'visible' }] }, finishReason: 'STOP' }],
    [
      'function call',
      {
        content: {
          parts: [{ functionCall: { args: { query: 'test' }, id: 'call_search', name: 'search' } }],
        },
        finishReason: 'STOP',
      },
    ],
    [
      'inline data',
      {
        content: {
          parts: [{ inlineData: { data: 'aGVsbG8=', mimeType: 'text/plain' } }],
        },
        finishReason: 'STOP',
      },
    ],
    [
      'grounding',
      {
        groundingMetadata: { webSearchQueries: ['Responses API'] },
        finishReason: 'STOP',
      },
    ],
  ])('completes a usable %s candidate', async (_name, candidate) => {
    const upstream = Readable.from([
      Buffer.from(`data: ${JSON.stringify({ response: { candidates: [candidate] } })}\n\n`),
    ]);
    const events = (
      await lastValueFrom(
        createResponsesStream(new ProxyService({} as never, {} as never), upstream).pipe(toArray()),
      )
    ).map((event) => parseEvent(String(event)));

    expect(events.at(-1)).toMatchObject({
      response: { status: 'completed' },
      type: 'response.completed',
    });
    expect(events.some((event) => event.type === 'response.failed')).toBe(false);
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
