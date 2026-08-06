import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastValueFrom, Observable, toArray } from 'rxjs';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { OpenAIResponsesStreamingMapper } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import {
  SignatureContext,
  SignatureStore,
} from '@/modules/proxy-gateway/antigravity/SignatureStore';
import type { ClaudeRequest, GeminiPart } from '@/modules/proxy-gateway/antigravity/types';
import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

const ACCOUNT_A: SignatureContext = { accountId: 'account-a', model: 'gemini-3-pro' };
const ACCOUNT_B: SignatureContext = { accountId: 'account-b', model: 'gemini-3-pro' };
const ACCOUNT_A_FLASH: SignatureContext = { accountId: 'account-a', model: 'gemini-3-flash' };

const SIGNATURE_A = 'signature-for-call-a';
const SIGNATURE_B = 'signature-for-call-b';

function encode(signature: string): string {
  return Buffer.from(signature).toString('base64');
}

function streamToolCall(
  context: SignatureContext | undefined,
  toolCallId: string,
  signature: string,
): void {
  const processor = new PartProcessor(new StreamingState(), context);
  processor.process({
    functionCall: { name: 'get_weather', args: { city: 'London' }, id: toolCallId },
    thoughtSignature: encode(signature),
  } as GeminiPart);
}

function toolUseRequest(toolCallId: string, model = 'gemini-3-pro'): ClaudeRequest {
  return {
    model,
    max_tokens: 1024,
    thinking: { type: 'enabled', budget_tokens: 256 },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolCallId, name: 'get_weather', input: { city: 'London' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolCallId, content: 'Cloudy' }],
      },
    ],
  };
}

function toolUsePart(request: ClaudeRequest, context?: SignatureContext) {
  const body = transformClaudeRequestIn(request, undefined, undefined, context);
  return body.request.contents[0].parts.find((part) => part.functionCall !== undefined);
}

function parseSseData(chunks: string[]): Record<string, any>[] {
  return chunks
    .flatMap((chunk) => chunk.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as Record<string, any>);
}

/** Pull the tool_use id out of the Claude SSE content_block_start event. */
function findClaudeToolUseId(chunks: string[]): string {
  const id = parseSseData(chunks).find(
    (event) => event.type === 'content_block_start' && event.content_block?.type === 'tool_use',
  )?.content_block?.id;
  if (typeof id !== 'string') {
    throw new Error('No tool_use id was emitted');
  }
  return id;
}

/** Pull the call_id out of the Responses function_call output item. */
function findResponsesCallId(events: string[]): string {
  const id = parseSseData(events).find((event) => event.item?.type === 'function_call')?.item
    ?.call_id;
  if (typeof id !== 'string') {
    throw new Error('No function_call call_id was emitted');
  }
  return id;
}

/**
 * Drive the chat-completions SSE path with a Gemini functionCall that has no upstream id
 * and return the tool call id the client received.
 */
async function runChatStream(
  service: ProxyService,
  context: SignatureContext,
  signature = SIGNATURE_A,
): Promise<string> {
  const upstreamStream = Readable.from([
    Buffer.from(
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'thinking', thought: true, thoughtSignature: encode(signature) },
                { functionCall: { name: 'get_weather', args: { city: 'London' } } },
              ],
            },
          },
        ],
      })}\n\n`,
    ),
    Buffer.from(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }] })}\n\n`),
  ]);

  const method: unknown = Reflect.get(service, 'processStreamResponse');
  if (typeof method !== 'function') {
    throw new Error('Chat stream processor is unavailable');
  }
  const result: unknown = Reflect.apply(method, service, [upstreamStream, context.model, context]);
  if (!(result instanceof Observable)) {
    throw new Error('Chat stream processor did not return an Observable');
  }

  const chunks = await lastValueFrom(result.pipe(toArray()));
  const id = parseSseData(chunks.map(String)).find(
    (event) => event.choices?.[0]?.delta?.tool_calls?.[0]?.id,
  )?.choices[0].delta.tool_calls[0].id;
  if (typeof id !== 'string') {
    throw new Error('No tool call id was emitted');
  }
  return id;
}

describe('thought signature state isolation', () => {
  beforeEach(() => {
    SignatureStore.clear();
    SignatureStore.resetConfig();
  });

  afterEach(() => {
    SignatureStore.clear();
    SignatureStore.resetConfig();
    vi.useRealTimers();
  });

  it('replays a captured signature only for the same tool call', () => {
    streamToolCall(ACCOUNT_A, 'call_a', SIGNATURE_A);

    expect(toolUsePart(toolUseRequest('call_a'), ACCOUNT_A)?.thoughtSignature).toBe(SIGNATURE_A);
    expect(toolUsePart(toolUseRequest('call_b'), ACCOUNT_A)?.thoughtSignature).toBeUndefined();
  });

  it('does not leak a signature across accounts or effective models', () => {
    streamToolCall(ACCOUNT_A, 'call_a', SIGNATURE_A);

    expect(SignatureStore.get({ ...ACCOUNT_B, toolCallId: 'call_a' })).toBeNull();
    expect(SignatureStore.get({ ...ACCOUNT_A_FLASH, toolCallId: 'call_a' })).toBeNull();
    expect(toolUsePart(toolUseRequest('call_a'), ACCOUNT_B)?.thoughtSignature).toBeUndefined();
    expect(
      toolUsePart(toolUseRequest('call_a'), ACCOUNT_A_FLASH)?.thoughtSignature,
    ).toBeUndefined();
  });

  it('does not replay any signature when no request context is available', () => {
    streamToolCall(ACCOUNT_A, 'call_a', SIGNATURE_A);

    expect(toolUsePart(toolUseRequest('call_a'))?.thoughtSignature).toBeUndefined();
  });

  it('keeps the most recent signature even when it is shorter', () => {
    SignatureStore.store({ ...ACCOUNT_A, toolCallId: 'call_a' }, 'a-very-long-old-signature-value');
    SignatureStore.store({ ...ACCOUNT_A, toolCallId: 'call_a' }, 'short');

    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_a' })).toBe('short');
  });

  it('keeps concurrent interleaved streams independent', () => {
    const first = new PartProcessor(new StreamingState(), ACCOUNT_A);
    const second = new PartProcessor(new StreamingState(), ACCOUNT_B);

    first.process({ text: 'thinking a', thought: true, thoughtSignature: encode(SIGNATURE_A) });
    second.process({ text: 'thinking b', thought: true, thoughtSignature: encode(SIGNATURE_B) });
    second.process({
      functionCall: { name: 'get_weather', args: {}, id: 'call_b' },
    } as GeminiPart);
    first.process({
      functionCall: { name: 'get_weather', args: {}, id: 'call_a' },
    } as GeminiPart);

    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_a' })).toBe(SIGNATURE_A);
    expect(SignatureStore.get({ ...ACCOUNT_B, toolCallId: 'call_b' })).toBe(SIGNATURE_B);
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_b' })).toBeNull();
    expect(SignatureStore.get({ ...ACCOUNT_B, toolCallId: 'call_a' })).toBeNull();
  });

  it('expires entries after the configured TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
    SignatureStore.configure({ ttlMs: 1_000 });
    SignatureStore.store({ ...ACCOUNT_A, toolCallId: 'call_a' }, SIGNATURE_A);

    vi.setSystemTime(new Date('2026-08-06T00:00:00.500Z'));
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_a' })).toBe(SIGNATURE_A);

    vi.setSystemTime(new Date('2026-08-06T00:00:01.500Z'));
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_a' })).toBeNull();
    expect(SignatureStore.size()).toBe(0);
  });

  it('evicts the oldest entries once the maximum size is exceeded', () => {
    SignatureStore.configure({ maxEntries: 2 });

    SignatureStore.store({ ...ACCOUNT_A, toolCallId: 'call_1' }, 'sig-1');
    SignatureStore.store({ ...ACCOUNT_A, toolCallId: 'call_2' }, 'sig-2');
    SignatureStore.store({ ...ACCOUNT_A, toolCallId: 'call_3' }, 'sig-3');

    expect(SignatureStore.size()).toBe(2);
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_1' })).toBeNull();
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_2' })).toBe('sig-2');
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_3' })).toBe('sig-3');
  });

  it('does not enable thinking from foreign account state', () => {
    streamToolCall(ACCOUNT_A, 'call_a', SIGNATURE_A);

    const foreignBody = transformClaudeRequestIn(
      toolUseRequest('call_a'),
      undefined,
      undefined,
      ACCOUNT_B,
    );
    expect(foreignBody.request.generationConfig?.thinkingConfig).toBeUndefined();

    const ownBody = transformClaudeRequestIn(
      toolUseRequest('call_a'),
      undefined,
      undefined,
      ACCOUNT_A,
    );
    expect(ownBody.request.generationConfig?.thinkingConfig).toBeDefined();
  });

  it('prefers an explicit request signature over stored state', () => {
    SignatureStore.store({ ...ACCOUNT_A, toolCallId: 'call_a' }, SIGNATURE_A);

    const request = toolUseRequest('call_a');
    const toolUseBlock = (request.messages[0].content as { signature?: string }[])[0];
    toolUseBlock.signature = 'explicit-signature';

    expect(toolUsePart(request, ACCOUNT_A)?.thoughtSignature).toBe('explicit-signature');
  });

  it('captures signatures from non-streaming function calls', () => {
    transformResponse(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'get_weather', args: {}, id: 'call_nonstream' },
                  thought_signature: encode(SIGNATURE_A),
                },
              ],
            },
          },
        ],
      },
      ACCOUNT_A,
    );

    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_nonstream' })).toBe(SIGNATURE_A);
    expect(SignatureStore.get({ ...ACCOUNT_B, toolCallId: 'call_nonstream' })).toBeNull();
  });

  it('captures Responses-protocol signatures under the tool call id', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp_isolation',
      signatureContext: ACCOUNT_A,
    });

    mapper.processPart({ text: 'reasoning', thought: true, thoughtSignature: encode(SIGNATURE_A) });
    mapper.processPart({
      functionCall: { args: {}, id: 'call_responses', name: 'shell' },
    });

    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_responses' })).toBe(SIGNATURE_A);
    expect(SignatureStore.get({ ...ACCOUNT_B, toolCallId: 'call_responses' })).toBeNull();
  });

  it('captures streaming signatures under the generated id when Gemini omits functionCall.id', () => {
    const processor = new PartProcessor(new StreamingState(), ACCOUNT_A);
    processor.process({ text: 'thinking', thought: true, thoughtSignature: encode(SIGNATURE_A) });
    const chunks = processor.process({
      functionCall: { name: 'get_weather', args: { city: 'London' } },
    } as GeminiPart);

    const emittedId = findClaudeToolUseId(chunks);
    expect(emittedId).toMatch(/^get_weather-/);

    // A follow-up that echoes the emitted id replays only for the same account + model.
    expect(toolUsePart(toolUseRequest(emittedId), ACCOUNT_A)?.thoughtSignature).toBe(SIGNATURE_A);
    expect(toolUsePart(toolUseRequest(emittedId), ACCOUNT_B)?.thoughtSignature).toBeUndefined();
    expect(
      toolUsePart(toolUseRequest(emittedId, 'gemini-3-flash'), ACCOUNT_A_FLASH)?.thoughtSignature,
    ).toBe('skip_thought_signature_validator');
    expect(SignatureStore.get({ ...ACCOUNT_A_FLASH, toolCallId: emittedId })).toBeNull();
    expect(
      toolUsePart(toolUseRequest('some-other-id'), ACCOUNT_A)?.thoughtSignature,
    ).toBeUndefined();
  });

  it('deduplicates repeated Chat function call ids without shifting distinct call indices', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstreamStream = Readable.from([
      Buffer.from(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { args: { city: 'London' }, id: 'call_repeat', name: 'weather' },
                    thoughtSignature: encode(SIGNATURE_A),
                  },
                  {
                    functionCall: { args: { city: 'Paris' }, id: 'call_repeat', name: 'weather' },
                    thoughtSignature: encode(SIGNATURE_B),
                  },
                  {
                    functionCall: { args: { city: 'Rome' }, id: 'call_distinct', name: 'weather' },
                    thoughtSignature: encode(SIGNATURE_B),
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      ),
      Buffer.from(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }] })}\n\n`),
    ]);
    const method: unknown = Reflect.get(service, 'processStreamResponse');
    if (typeof method !== 'function') {
      throw new Error('Chat stream processor is unavailable');
    }
    const result: unknown = Reflect.apply(method, service, [
      upstreamStream,
      ACCOUNT_A.model,
      ACCOUNT_A,
    ]);
    if (!(result instanceof Observable)) {
      throw new Error('Chat stream processor did not return an Observable');
    }

    const controller = new ProxyController({} as never);
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };
    const ended = new Promise<void>((resolve) => {
      raw.end.mockImplementation(resolve);
    });

    (controller as any).writeSseResponse({ hijack: vi.fn(), raw }, result);
    await ended;

    const toolCalls = parseSseData(raw.write.mock.calls.map(([chunk]) => String(chunk))).flatMap(
      (event) => event.choices?.[0]?.delta?.tool_calls ?? [],
    );

    expect(toolCalls.map((toolCall) => toolCall.id)).toEqual(['call_repeat', 'call_distinct']);
    expect(toolCalls.map((toolCall) => toolCall.index)).toEqual([0, 1]);
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_repeat' })).toBe(SIGNATURE_A);
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_distinct' })).toBe(SIGNATURE_B);
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('captures non-streaming signatures under the generated id when Gemini omits functionCall.id', () => {
    const response = transformResponse(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'get_weather', args: {} },
                  thought_signature: encode(SIGNATURE_A),
                },
              ],
            },
          },
        ],
      },
      ACCOUNT_A,
    );

    const emittedId = (response.content as { type: string; id?: string }[]).find(
      (block) => block.type === 'tool_use',
    )?.id as string;
    expect(emittedId).toMatch(/^get_weather-/);

    expect(toolUsePart(toolUseRequest(emittedId), ACCOUNT_A)?.thoughtSignature).toBe(SIGNATURE_A);
    expect(SignatureStore.get({ ...ACCOUNT_B, toolCallId: emittedId })).toBeNull();
    expect(SignatureStore.get({ ...ACCOUNT_A_FLASH, toolCallId: emittedId })).toBeNull();
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'get_weather-other' })).toBeNull();
  });

  it('captures Responses-protocol signatures under the generated call id when Gemini omits functionCall.id', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp_generated',
      signatureContext: ACCOUNT_A,
    });

    mapper.processPart({ text: 'reasoning', thought: true, thoughtSignature: encode(SIGNATURE_A) });
    const events = mapper.processPart({ functionCall: { args: {}, name: 'shell' } });

    const emittedId = findResponsesCallId(events);
    expect(emittedId).toBe('call_resp_generated_0');

    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: emittedId })).toBe(SIGNATURE_A);
    expect(SignatureStore.get({ ...ACCOUNT_B, toolCallId: emittedId })).toBeNull();
    expect(SignatureStore.get({ ...ACCOUNT_A_FLASH, toolCallId: emittedId })).toBeNull();
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: 'call_resp_generated_1' })).toBeNull();
  });

  it('captures chat-SSE signatures under the generated id and isolates retries by account and model', async () => {
    const service = new ProxyService({} as never, {} as never);
    const emittedId = await runChatStream(service, ACCOUNT_A);
    expect(emittedId).toMatch(/^get_weather-/);

    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: emittedId })).toBe(SIGNATURE_A);
    // A retry on a different account, or after the effective model changed, cannot read it.
    expect(SignatureStore.get({ ...ACCOUNT_B, toolCallId: emittedId })).toBeNull();
    expect(SignatureStore.get({ ...ACCOUNT_A_FLASH, toolCallId: emittedId })).toBeNull();
    expect(toolUsePart(toolUseRequest(emittedId), ACCOUNT_A)?.thoughtSignature).toBe(SIGNATURE_A);
    expect(toolUsePart(toolUseRequest(emittedId), ACCOUNT_B)?.thoughtSignature).toBeUndefined();

    // The retried attempt stores its own generated id under its own key only.
    const retryId = await runChatStream(service, ACCOUNT_B, SIGNATURE_B);
    expect(retryId).not.toBe(emittedId);
    expect(SignatureStore.get({ ...ACCOUNT_B, toolCallId: retryId })).toBe(SIGNATURE_B);
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: retryId })).toBeNull();
    expect(SignatureStore.get({ ...ACCOUNT_A, toolCallId: emittedId })).toBe(SIGNATURE_A);
  });

  it('preserves the Gemini Flash sentinel when nothing is available for the tool call', () => {
    const part = toolUsePart(toolUseRequest('call_flash', 'gemini-3-flash'), ACCOUNT_A_FLASH);

    expect(part?.thoughtSignature).toBe('skip_thought_signature_validator');
  });
});
