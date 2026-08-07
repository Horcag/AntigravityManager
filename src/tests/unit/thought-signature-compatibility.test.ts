import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

const THOUGHT_SIGNATURE = 'thought-signature-for-tool-call';
const ACCOUNT_ID = 'account-a';
const MODEL = 'gemini-3-flash';

describe('thought signature compatibility', () => {
  it('sends both signature field names for explicit thinking, function calls, and results', () => {
    const request: ClaudeRequest = {
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should call the tool.', signature: THOUGHT_SIGNATURE },
            {
              type: 'tool_use',
              id: 'call_weather',
              name: 'get_weather',
              input: { location: 'London' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_weather', content: 'Cloudy' }],
        },
      ],
    };

    const body = transformClaudeRequestIn(request);
    const [thinkingPart, functionCallPart] = body.request.contents[0].parts;
    const [functionResponsePart] = body.request.contents[1].parts;

    for (const part of [thinkingPart, functionCallPart, functionResponsePart]) {
      expect(part.thoughtSignature).toBe(THOUGHT_SIGNATURE);
      expect(part.thought_signature).toBe(THOUGHT_SIGNATURE);
    }
  });

  it('captures a snake-case non-stream signature under the emitted tool id and exact context', () => {
    const store = new SignatureStore();
    const response = transformResponse(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'get_weather',
                    args: { location: 'London' },
                    id: 'call_weather',
                  },
                  thought_signature: THOUGHT_SIGNATURE,
                },
              ],
            },
          },
        ],
      },
      { accountId: ACCOUNT_ID, model: MODEL, store },
    );

    expect(response.content).toContainEqual({
      type: 'tool_use',
      id: 'call_weather',
      name: 'get_weather',
      input: { location: 'London' },
      signature: THOUGHT_SIGNATURE,
    });
    expect(store.get({ accountId: ACCOUNT_ID, model: MODEL, toolCallId: 'call_weather' })).toBe(
      THOUGHT_SIGNATURE,
    );
  });

  it('accepts snake-case signatures from streaming Gemini responses', () => {
    const state = new StreamingState();
    const processor = new PartProcessor(state);
    const chunks = processor.process({
      text: 'Reasoning',
      thought: true,
      thought_signature: THOUGHT_SIGNATURE,
    });
    chunks.push(...state.emitFinish('STOP', {}));

    expect(chunks.join('')).toContain(THOUGHT_SIGNATURE);
  });

  it('replays only the signature matching account, effective model, and tool-call id', () => {
    const store = new SignatureStore();
    store.store(
      { accountId: ACCOUNT_ID, model: MODEL, toolCallId: 'call_alpha' },
      'alpha-signature-value',
    );
    store.store(
      { accountId: 'account-b', model: MODEL, toolCallId: 'call_alpha' },
      'wrong-account-signature',
    );

    const request: ClaudeRequest = {
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_alpha', name: 'get_weather', input: {} },
            { type: 'tool_use', id: 'call_missing', name: 'get_time', input: {} },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request, undefined, undefined, MODEL, {
      accountId: ACCOUNT_ID,
      store,
    });
    const functionCalls = body.request.contents[0].parts.filter((part) => part.functionCall);

    expect(functionCalls[0].thoughtSignature).toBe('alpha-signature-value');
    expect(functionCalls[1].thoughtSignature).toBe('skip_thought_signature_validator');
    expect(
      store.get({ accountId: ACCOUNT_ID, model: 'gemini-3-pro', toolCallId: 'call_alpha' }),
    ).toBeNull();
  });

  it('replays distinct signatures for distinct historical tool-call ids', () => {
    const store = new SignatureStore();
    store.store(
      { accountId: ACCOUNT_ID, model: MODEL, toolCallId: 'call_first' },
      'first-turn-signature',
    );
    store.store(
      { accountId: ACCOUNT_ID, model: MODEL, toolCallId: 'call_latest' },
      'latest-turn-signature',
    );

    const request: ClaudeRequest = {
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_first', name: 'first_tool', input: {} },
            { type: 'tool_use', id: 'call_latest', name: 'latest_tool', input: {} },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request, undefined, undefined, MODEL, {
      accountId: ACCOUNT_ID,
      store,
    });
    const functionCalls = body.request.contents[0].parts.filter((part) => part.functionCall);

    expect(functionCalls[0].thoughtSignature).toBe('first-turn-signature');
    expect(functionCalls[1].thoughtSignature).toBe('latest-turn-signature');
  });

  it('stores a streamed tool signature under the client-visible generated id', () => {
    const store = new SignatureStore();
    const state = new StreamingState({ accountId: ACCOUNT_ID, model: MODEL, store });
    const processor = new PartProcessor(state);

    const chunks = processor.process({
      functionCall: { name: 'streamed_tool', args: {} },
      thoughtSignature: THOUGHT_SIGNATURE,
    });
    const startEvent = chunks
      .map((chunk) => chunk.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line): line is string => Boolean(line))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
      .find((event) => event.type === 'content_block_start');
    const contentBlock = startEvent?.content_block as { id?: string } | undefined;

    expect(contentBlock?.id).toBeTruthy();
    expect(
      store.get({ accountId: ACCOUNT_ID, model: MODEL, toolCallId: contentBlock?.id ?? '' }),
    ).toBe(THOUGHT_SIGNATURE);
  });
});
