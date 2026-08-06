import { readFileSync } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';

const mockAccountLeaseService = {
  getNextToken: vi.fn(),
  markAsRateLimited: vi.fn(),
  markAsForbidden: vi.fn(),
  markFromUpstreamError: vi.fn(),
  recordParityError: vi.fn(),
};
const mockGeminiClient = { streamGenerateInternal: vi.fn(), generateInternal: vi.fn() };

class TestableProxyService extends ProxyService {
  constructor() {
    super(mockAccountLeaseService as any, mockGeminiClient as any);
  }

  public toAnthropic(request: any): any {
    return (this as any).convertOpenAIToClaude(request);
  }

  public toOpenAI(response: any, model: string): any {
    return (this as any).convertClaudeToOpenAIResponse(response, model);
  }

  public streamToOpenAI(
    upstreamStream: any,
    model: string,
    signatureContext?: { accountId: string; model: string },
  ): Observable<string> {
    return (this as any).processStreamResponse(upstreamStream, model, signatureContext);
  }
}

const SIGNATURE_CONTEXT = { accountId: 'account-parity', model: 'gemini-3.6-flash-high' };

function readFixture<T>(relativePath: string): T {
  const fullPath = path.join(process.cwd(), 'src/tests/fixtures/proxy-parity', relativePath);
  return JSON.parse(readFileSync(fullPath, 'utf-8')) as T;
}

describe('Proxy Parity Fixtures', () => {
  it('maps OpenAI request fixture to expected Anthropic request semantics', () => {
    const service = new TestableProxyService();
    const input = readFixture<any>('request/openai.chat-tools.input.json');
    const expected = readFixture<any>('request/openai.chat-tools.expected.json');

    const actual = service.toAnthropic(input);

    expect(actual.model).toBe(expected.model);
    expect(actual.system).toBe(expected.system);
    expect(actual.temperature).toBe(expected.temperature);
    expect(actual.max_tokens).toBe(expected.max_tokens);
    expect(actual.tools?.[0]?.name).toBe(expected.tools[0].name);
    expect(actual.messages[0]).toEqual(expected.messages[0]);
    expect(actual.messages[1].content[1]).toEqual(expected.messages[1].content[1]);
    expect(actual.messages[2].content[0]).toEqual(expected.messages[2].content[0]);
  });

  it('preserves OpenAI tool_choice for the Gemini request mapper', () => {
    const service = new TestableProxyService();
    const tools = [
      {
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object' } },
      },
      {
        type: 'function',
        function: { name: 'get_time', parameters: { type: 'object' } },
      },
    ];
    const choices = [
      { choice: undefined, expected: { mode: 'VALIDATED' } },
      { choice: 'none', expected: { mode: 'NONE' } },
      { choice: 'auto', expected: { mode: 'AUTO' } },
      { choice: 'required', expected: { mode: 'ANY' } },
      {
        choice: { type: 'function', function: { name: 'get_weather' } },
        expected: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
      },
    ];

    for (const { choice, expected } of choices) {
      const claudeRequest = service.toAnthropic({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'Use a tool' }],
        tools,
        tool_choice: choice,
      });
      const body = transformClaudeRequestIn(claudeRequest);

      expect(body.request.toolConfig?.functionCallingConfig).toEqual(expected);
    }
  });

  it('rejects malformed and unavailable named OpenAI tool choices', () => {
    const service = new TestableProxyService();
    const request = {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'Use a tool' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
        },
      ],
    };

    expect(() => service.toAnthropic({ ...request, tool_choice: { type: 'function' } })).toThrow(
      'tool_choice.function.name',
    );
    expect(() =>
      service.toAnthropic({
        ...request,
        tool_choice: { type: 'tool', function: { name: 'get_weather' } },
      }),
    ).toThrow('must be none, auto, required, or a named function selection');
    expect(() =>
      service.toAnthropic({
        ...request,
        tool_choice: { type: 'function', function: { name: 'get_time' } },
      }),
    ).toThrow('not among the provided tools');
  });

  it('accepts a null assistant content field between tool calls and tool results', () => {
    const service = new TestableProxyService();
    const input = readFixture<any>('request/openai.chat-tools.input.json');
    input.messages[2].content = null;

    const actual = service.toAnthropic(input);

    expect(actual.messages[1].content).toEqual([
      {
        type: 'tool_use',
        id: 'call_weather',
        name: 'get_weather',
        input: { city: 'Paris' },
      },
    ]);
    expect(actual.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_weather',
      content: '18 C and cloudy',
    });
  });

  it('groups consecutive OpenAI tool results into one Gemini user turn', () => {
    const service = new TestableProxyService();
    const claudeRequest = service.toAnthropic({
      model: 'gemini-3-flash',
      messages: [
        { role: 'user', content: 'Look up both cities.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_paris',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
            {
              id: 'call_tokyo',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_paris', content: 'Paris: 18 C' },
        { role: 'tool', tool_call_id: 'call_tokyo', content: 'Tokyo: 24 C' },
      ],
    });
    const body = transformClaudeRequestIn(claudeRequest);

    expect(body.request.contents).toHaveLength(3);
    expect(body.request.contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
    expect(body.request.contents[1]?.parts.map((part) => part.functionCall)).toEqual([
      { id: 'call_paris', name: 'get_weather', args: { city: 'Paris' } },
      { id: 'call_tokyo', name: 'get_weather', args: { city: 'Tokyo' } },
    ]);
    expect(body.request.contents[2]?.parts.map((part) => part.functionResponse)).toEqual([
      { id: 'call_paris', name: 'get_weather', response: { result: 'Paris: 18 C' } },
      { id: 'call_tokyo', name: 'get_weather', response: { result: 'Tokyo: 24 C' } },
    ]);
  });

  it('keeps a single OpenAI tool result in its existing Gemini turn shape', () => {
    const service = new TestableProxyService();
    const claudeRequest = service.toAnthropic({
      model: 'gemini-3-flash',
      messages: [
        { role: 'user', content: 'Look up Paris.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_paris',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_paris', content: 'Paris: 18 C' },
      ],
    });
    const body = transformClaudeRequestIn(claudeRequest);

    expect(body.request.contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
    expect(body.request.contents[2]?.parts).toEqual([
      {
        functionResponse: {
          id: 'call_paris',
          name: 'get_weather',
          response: { result: 'Paris: 18 C' },
        },
      },
    ]);
  });

  it('removes Codex-injected tools from function parameter schemas', () => {
    const service = new TestableProxyService();
    const input = {
      model: 'claude-sonnet-4-5',
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_docs',
            description: 'Search docs',
            parameters: {
              type: 'object',
              tools: [{ type: 'function' }],
              properties: {
                query: {
                  type: 'string',
                  tools: [{ type: 'function' }],
                },
              },
            },
          },
        },
      ],
      messages: [{ role: 'user', content: 'Find API key docs' }],
    };

    const actual = service.toAnthropic(input);

    expect(actual.tools?.[0]?.input_schema).not.toHaveProperty('tools');
    expect(actual.tools?.[0]?.input_schema.properties.query).not.toHaveProperty('tools');
  });

  it('maps Anthropic response fixture to expected OpenAI response semantics', () => {
    const service = new TestableProxyService();
    const input = readFixture<any>('response/anthropic.tool-use.input.json');
    const expected = readFixture<any>('response/anthropic.tool-use.expected.json');

    const actual = service.toOpenAI(input, expected.model);

    expect(actual.model).toBe(expected.model);
    expect(actual.choices[0].message.content).toBe(expected.message.content);
    expect(actual.choices[0].message.reasoning_content).toBe(expected.message.reasoning_content);
    expect(actual.choices[0].message.tool_calls?.[0]).toEqual(expected.message.tool_calls[0]);
    expect(actual.choices[0].finish_reason).toBe(expected.finish_reason);
    expect(actual.usage).toEqual(expected.usage);
  });

  it('maps upstream stream fixture into expected OpenAI SSE semantics', async () => {
    const service = new TestableProxyService();
    const input = readFixture<any>('stream/openai-from-gemini.input.json');
    const expected = readFixture<{ contains: string[] }>('stream/openai-from-gemini.expected.json');

    const stream = new EventEmitter();
    const outputChunks: string[] = [];

    const promise = new Promise<void>((resolve, reject) => {
      service.streamToOpenAI(stream, input.model).subscribe({
        next: (chunk) => outputChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.emit('data', Buffer.from(`data: ${JSON.stringify(input.upstream)}\n`));
    stream.emit('end');

    await promise;

    const output = outputChunks.join('');
    for (const token of expected.contains) {
      expect(output).toContain(token);
    }
  });

  it('assigns stable distinct indices to streamed tool calls', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const outputChunks: string[] = [];
    const promise = new Promise<void>((resolve, reject) => {
      service.streamToOpenAI(stream, 'gemini-3-flash').subscribe({
        next: (chunk) => outputChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    for (const functionCall of [
      { id: 'call_weather', name: 'get_weather', args: { city: 'Paris' } },
      { id: 'call_time', name: 'get_time', args: { city: 'Tokyo' } },
      { id: 'call_weather', name: 'get_weather', args: { city: 'London' } },
    ]) {
      stream.emit(
        'data',
        Buffer.from(
          'data: ' +
            JSON.stringify({ candidates: [{ content: { parts: [{ functionCall }] } }] }) +
            '\n',
        ),
      );
    }
    stream.emit('end');
    await promise;

    const chunks = outputChunks
      .filter((chunk) => chunk.startsWith('data: {'))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
    expect(chunks[0]?.choices).toEqual([
      { index: 0, delta: { role: 'assistant' }, finish_reason: null },
    ]);
    expect(chunks.filter((chunk) => chunk.choices[0].delta.role === 'assistant')).toHaveLength(1);

    const toolCallChunks = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls);
    expect(toolCallChunks.map((chunk) => chunk.choices[0].index)).toEqual([0, 0, 0]);
    expect(toolCallChunks.map((chunk) => chunk.choices[0].delta.tool_calls[0].index)).toEqual([
      0, 1, 0,
    ]);
    expect(outputChunks.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('replays a streamed tool thought signature for an OpenAI null-content follow-up', async () => {
    SignatureStore.clear();
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const outputChunks: string[] = [];

    const promise = new Promise<void>((resolve, reject) => {
      service.streamToOpenAI(stream, 'gemini-3.6-flash-high', SIGNATURE_CONTEXT).subscribe({
        next: (chunk) => outputChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.emit(
      'data',
      Buffer.from(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'call_weather',
                      name: 'get_weather',
                      args: { city: 'Paris' },
                    },
                    thoughtSignature: 'thought-signature-for-openai-tool-loop',
                  },
                ],
              },
            },
          ],
        })}\n`,
      ),
    );
    stream.emit('end');
    await promise;

    const followUp = service.toAnthropic({
      model: 'gemini-3.6-flash-high',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_weather',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_weather', content: '18 C and cloudy' },
      ],
    });
    const body = transformClaudeRequestIn(followUp, undefined, undefined, SIGNATURE_CONTEXT);
    const [functionCallPart] = body.request.contents[0].parts;
    const [functionResponsePart] = body.request.contents[1].parts;

    expect(outputChunks.join('')).toContain('"tool_calls"');
    expect(body.request.generationConfig?.thinkingConfig).toBeDefined();
    for (const part of [functionCallPart, functionResponsePart]) {
      expect(part.thoughtSignature).toBe('thought-signature-for-openai-tool-loop');
      expect(part.thought_signature).toBe('thought-signature-for-openai-tool-loop');
    }
    SignatureStore.clear();
  });
});
