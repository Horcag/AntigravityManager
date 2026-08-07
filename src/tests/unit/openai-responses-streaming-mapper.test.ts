import { afterEach, describe, expect, it } from 'vitest';

import { OpenAIResponsesStreamingMapper } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

function parseEvent(frame: string): Record<string, unknown> {
  const [eventLine, dataLine] = frame.trim().split('\n');
  expect(eventLine).toMatch(/^event: response\.|^event: error$/);
  expect(dataLine).toMatch(/^data: /);
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

function createMapper(): OpenAIResponsesStreamingMapper {
  return new OpenAIResponsesStreamingMapper({
    model: 'gemini-3-pro',
    responseId: 'resp_test',
    signatureContext: { accountId: 'account-a', model: 'gemini-3-pro' },
  });
}

describe('OpenAIResponsesStreamingMapper', () => {
  afterEach(() => SignatureStore.clear());

  it('emits exact SSE frames, monotonic sequence numbers, ordered mixed output, and usage', () => {
    const mapper = createMapper();
    mapper.setUsageMetadata({
      candidatesTokenCount: 5,
      promptTokenCount: 3,
      thoughtsTokenCount: 2,
      totalTokenCount: 10,
    });
    const events = [
      mapper.createResponseCreatedEvent(),
      mapper.createResponseInProgressEvent(),
      ...mapper.processPart({ text: 'Hello' }),
      ...mapper.processPart({
        functionCall: { args: { cmd: 'dir' }, id: 'call_shell_1', name: 'shell' },
      }),
      ...mapper.complete(),
    ].map(parseEvent);

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
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const lifecycleSnapshots = events
      .filter((event) =>
        ['response.created', 'response.in_progress', 'response.completed'].includes(
          String(event.type),
        ),
      )
      .map((event) => event.response as Record<string, unknown>);
    expect(lifecycleSnapshots.map((response) => response.id)).toEqual([
      'resp_test',
      'resp_test',
      'resp_test',
    ]);
    expect(lifecycleSnapshots.map((response) => response.model)).toEqual([
      'gemini-3-pro',
      'gemini-3-pro',
      'gemini-3-pro',
    ]);
    expect(lifecycleSnapshots.map((response) => response.created_at)).toEqual([
      lifecycleSnapshots[0].created_at,
      lifecycleSnapshots[0].created_at,
      lifecycleSnapshots[0].created_at,
    ]);
    expect(events[3]).toMatchObject({ part: { annotations: [] } });
    expect(events[7]).toMatchObject({ item: { status: 'completed', type: 'message' } });
    expect(events[8]).toMatchObject({ item: { call_id: 'call_shell_1', id: 'fc_resp_test_1' } });
    expect(events[10]).toEqual({
      arguments: '{"command":"dir"}',
      item_id: 'fc_resp_test_1',
      name: 'shell',
      output_index: 1,
      sequence_number: 10,
      type: 'response.function_call_arguments.done',
    });
    expect(events.at(-1)).toMatchObject({
      response: {
        completed_at: expect.any(Number),
        error: null,
        incomplete_details: null,
        output: [
          expect.objectContaining({ type: 'message' }),
          expect.objectContaining({ call_id: 'call_shell_1', type: 'function_call' }),
        ],
        parallel_tool_calls: true,
        status: 'completed',
        usage: {
          input_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 10,
        },
      },
    });
  });

  it('stores function signatures using the client-visible generated call id', () => {
    const mapper = createMapper();
    mapper.processPart({
      functionCall: { args: { command: 'pwd' }, name: 'shell' },
      thoughtSignature: Buffer.from('signature').toString('base64'),
    });
    mapper.complete();
    expect(
      SignatureStore.get({
        accountId: 'account-a',
        model: 'gemini-3-pro',
        toolCallId: 'call_resp_test_0',
      }),
    ).toBe('signature');
  });

  it('keeps usage unknown until Gemini provides at least one token counter', () => {
    const mapper = createMapper();
    mapper.setUsageMetadata({});
    const completed = mapper.complete().map(parseEvent).at(-1);

    expect(completed).toMatchObject({
      response: { status: 'completed', usage: null },
      type: 'response.completed',
    });
  });

  it('emits an incomplete terminal response when Gemini reaches MAX_TOKENS case-insensitively', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'cut off' }),
      ...mapper.complete('max_tokens'),
    ].map(parseEvent);
    const completed = events.at(-1);
    const textItemDone = events.find(
      (event) =>
        event.type === 'response.output_item.done' &&
        (event.item as Record<string, unknown>).type === 'message',
    );

    expect(completed).toMatchObject({
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
    'normalizes synthetic OpenAI finish reason %s without Gemini mapping',
    (finishReason, terminalType, status, incompleteDetails) => {
      const mapper = createMapper();
      const terminal = mapper.complete(finishReason, 'openai').map(parseEvent).at(-1);

      expect(terminal).toMatchObject({
        response: { incomplete_details: incompleteDetails, status },
        type: terminalType,
      });
    },
  );

  it.each([
    'SAFETY',
    'recitation',
    'BLOCKLIST',
    'MALFORMED_FUNCTION_CALL',
    'IMAGE_SAFETY',
    'UNKNOWN',
  ])('maps unknown live Gemini reason %s to content-filter incompleteness', (finishReason) => {
    const mapper = createMapper();
    const terminal = mapper.complete(finishReason).map(parseEvent).at(-1);

    expect(terminal).toMatchObject({
      response: {
        incomplete_details: { reason: 'content_filter' },
        status: 'incomplete',
      },
      type: 'response.incomplete',
    });
  });

  it('preserves real usage when later Gemini metadata has no counters', () => {
    const mapper = createMapper();
    mapper.setUsageMetadata({
      candidatesTokenCount: 50,
      promptTokenCount: 100,
      totalTokenCount: 150,
    });
    mapper.setUsageMetadata({});
    const completed = mapper.complete().map(parseEvent).at(-1);

    expect(completed).toMatchObject({
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
      },
    });
  });

  it('keeps complete Gemini usage when later metadata is partial and counts reasoning once', () => {
    const mapper = createMapper();
    mapper.setUsageMetadata({
      candidatesTokenCount: 5,
      promptTokenCount: 3,
      thoughtsTokenCount: 2,
    });
    mapper.setUsageMetadata({ totalTokenCount: 10 });
    const completed = mapper.complete().map(parseEvent).at(-1);

    expect(completed).toMatchObject({
      response: {
        usage: {
          input_tokens: 3,
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 10,
        },
      },
    });
  });

  it('deduplicates repeated grounding frames while preserving citation numbering', () => {
    const mapper = createMapper();
    const grounding = {
      groundingChunks: [
        { web: { title: 'First source', uri: 'https://example.com/first' } },
        { web: { title: 'Second source', uri: 'https://example.com/second' } },
      ],
      webSearchQueries: ['Gemini grounding'],
    };

    const events = [
      ...mapper.processGrounding(grounding),
      ...mapper.processGrounding(grounding),
      ...mapper.complete(),
    ].map(parseEvent);
    const text = String(
      events.find((event) => event.type === 'response.output_text.done')?.text ?? '',
    );

    expect(text.match(/Searched for you/g)).toHaveLength(1);
    expect(text.match(/https:\/\/example\.com\/first/g)).toHaveLength(1);
    expect(text.match(/https:\/\/example\.com\/second/g)).toHaveLength(1);
    expect(text).toContain('[1] [First source]');
    expect(text).toContain('[2] [Second source]');
  });

  it('does not leave an output-index gap for an exact function call replay', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({
        functionCall: { args: { page: 1 }, id: 'call_search', name: 'search' },
      }),
      ...mapper.processPart({
        functionCall: { args: { page: 1 }, id: 'call_search', name: 'search' },
      }),
      ...mapper.processPart({ text: 'Results ready' }),
      ...mapper.complete(),
    ].map(parseEvent);
    const completedResponse = events.at(-1)?.response as Record<string, unknown>;
    const messageDone = events.find(
      (event) =>
        event.type === 'response.output_item.done' &&
        (event.item as Record<string, unknown>).type === 'message',
    );

    expect(completedResponse.output).toEqual([
      expect.objectContaining({ type: 'function_call' }),
      expect.objectContaining({ type: 'message' }),
    ]);
    expect(messageDone).toMatchObject({ output_index: 1 });
  });

  it('rejects a cross-frame explicit tool call id with different arguments', () => {
    const mapper = createMapper();
    mapper.processPart({ functionCall: { args: { page: 1 }, id: 'call_search', name: 'search' } });

    expect(() =>
      mapper.processPart({
        functionCall: { args: { page: 2 }, id: 'call_search', name: 'search' },
      }),
    ).toThrow('Conflicting function call reuse');
  });

  it('terminates once with official-shaped error and failed events', () => {
    const mapper = createMapper();
    const events = mapper.fail('bad upstream').map(parseEvent);
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      {
        code: 'upstream_error',
        message: 'bad upstream',
        param: null,
        sequence_number: 0,
        type: 'error',
      },
      {
        response: {
          completed_at: null,
          created_at: expect.any(Number),
          error: { code: 'upstream_error', message: 'bad upstream' },
          id: 'resp_test',
          incomplete_details: null,
          instructions: null,
          max_output_tokens: null,
          metadata: {},
          model: 'gemini-3-pro',
          object: 'response',
          output: [],
          parallel_tool_calls: true,
          previous_response_id: null,
          reasoning: null,
          status: 'failed',
          store: false,
          temperature: 1,
          text: { format: { type: 'text' } },
          tool_choice: 'auto',
          tools: [],
          top_p: 1,
          truncation: 'disabled',
          usage: null,
        },
        sequence_number: 1,
        type: 'response.failed',
      },
    ]);
    expect(mapper.complete()).toEqual([]);
  });

  it('keeps partial text coherent in a failed response', () => {
    const mapper = createMapper();
    mapper.processPart({ text: 'partial' });
    const failedResponse = mapper.fail('upstream disconnected').map(parseEvent)[1];
    expect(failedResponse).toMatchObject({
      response: {
        output: [
          {
            content: [{ annotations: [], text: 'partial', type: 'output_text' }],
            status: 'in_progress',
            type: 'message',
          },
        ],
      },
    });
  });

  it('drops buffered tool calls from a failed response until their lifecycle was emitted', () => {
    const mapper = createMapper();
    mapper.processPart({ text: 'partial' });
    mapper.processPart({ functionCall: { args: {}, id: 'call_late', name: 'search' } });
    const failedResponse = mapper.fail('upstream disconnected').map(parseEvent)[1];

    expect((failedResponse.response as Record<string, unknown>).output).toEqual([
      expect.objectContaining({ type: 'message' }),
    ]);
  });
});
