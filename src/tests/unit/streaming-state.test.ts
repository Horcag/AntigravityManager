import { describe, it, expect, beforeEach } from 'vitest';
import {
  PartProcessor,
  StreamingState,
} from '../../modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { ToolCallIdConflictError } from '../../modules/proxy-gateway/antigravity/tool-call-id-integrity';

type ClaudeSseEvent = {
  type: string;
  index?: number;
  content_block?: { type?: string };
  delta?: { signature?: string; text?: string };
};

function encodeSignature(signature: string): string {
  return Buffer.from(signature).toString('base64');
}

function parseEvents(chunks: string[]): ClaudeSseEvent[] {
  return chunks
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as ClaudeSseEvent);
}

function expectBalancedBlockLifecycle(events: ClaudeSseEvent[]): void {
  const starts = events.filter((event) => event.type === 'content_block_start');
  const stops = events.filter((event) => event.type === 'content_block_stop');

  expect(starts.map((event) => event.index)).toEqual(starts.map((_, index) => index));
  expect(stops.map((event) => event.index)).toEqual(starts.map((event) => event.index));
}

describe('StreamingState', () => {
  let state: StreamingState;

  beforeEach(() => {
    state = new StreamingState();
  });

  describe('handleParseError', () => {
    it('should return empty array on first error', () => {
      const chunks = state.handleParseError('invalid json');
      expect(chunks).toEqual([]);
    });

    it('does not emit a protocol error event when error count exceeds 3', () => {
      // Simulate 4 parse errors
      state.handleParseError('error 1');
      state.handleParseError('error 2');
      state.handleParseError('error 3');
      const chunks = state.handleParseError('error 4');

      expect(chunks).toEqual([]);
    });

    it('should safely close active block on error', () => {
      // Start a text block first
      state.startBlock('Text', { type: 'text', text: '' });

      const chunks = state.handleParseError('error during block');

      // Should contain content_block_stop event
      expect(chunks.some((c) => c.includes('content_block_stop'))).toBe(true);
    });
  });

  describe('resetErrorState', () => {
    it('should reset error counter', () => {
      state.handleParseError('error 1');
      state.handleParseError('error 2');
      state.resetErrorState();

      // After reset, should start counting from 0
      const chunks = state.handleParseError('error after reset');
      expect(chunks).toEqual([]);
    });
  });

  describe('getErrorCount', () => {
    it('should return current error count', () => {
      expect(state.getErrorCount()).toBe(0);
      state.handleParseError('error 1');
      expect(state.getErrorCount()).toBe(1);
      state.handleParseError('error 2');
      expect(state.getErrorCount()).toBe(2);
    });
  });

  describe('stream aggregation compatibility', () => {
    it('balances a signature block after non-empty signed text before later text', () => {
      const processor = new PartProcessor(state);
      const chunks = [
        ...processor.process({
          text: 'signed text',
          thoughtSignature: encodeSignature('text-signature'),
        }),
        ...processor.process({ text: 'later text' }),
        ...state.emitFinish('STOP'),
      ];
      const events = parseEvents(chunks);

      expectBalancedBlockLifecycle(events);
      expect(events.map((event) => event.delta?.signature).filter(Boolean)).toEqual([
        'text-signature',
      ]);
      expect(events.map((event) => event.delta?.text).filter(Boolean)).toEqual([
        'signed text',
        'later text',
      ]);
    });

    it('balances a pending signature after thinking before subsequent text', () => {
      const processor = new PartProcessor(state);
      const chunks = [
        ...processor.process({ text: 'reasoning', thought: true }),
        ...processor.process({ text: '', thoughtSignature: encodeSignature('thinking-signature') }),
        ...processor.process({ text: 'answer' }),
        ...state.emitFinish('STOP'),
      ];
      const events = parseEvents(chunks);

      expectBalancedBlockLifecycle(events);
      expect(events.map((event) => event.delta?.signature).filter(Boolean)).toEqual([
        'thinking-signature',
      ]);
      expect(events.map((event) => event.delta?.text).filter(Boolean)).toEqual(['answer']);
    });

    it('balances a pending signature before ordinary text', () => {
      const processor = new PartProcessor(state);
      const chunks = [
        ...processor.process({
          text: '',
          thoughtSignature: encodeSignature('pending-text-signature'),
        }),
        ...processor.process({ text: 'visible text' }),
        ...state.emitFinish('STOP'),
      ];
      const events = parseEvents(chunks);

      expectBalancedBlockLifecycle(events);
      expect(events.map((event) => event.delta?.signature).filter(Boolean)).toEqual([
        'pending-text-signature',
      ]);
      expect(events.map((event) => event.delta?.text).filter(Boolean)).toEqual(['visible text']);
    });

    it('balances a pending signature before a function call', () => {
      const processor = new PartProcessor(state);
      const chunks = [
        ...processor.process({
          text: '',
          thoughtSignature: encodeSignature('pending-tool-signature'),
        }),
        ...processor.process({
          functionCall: { args: { city: 'Samara' }, id: 'call_weather', name: 'get_weather' },
        }),
        ...state.emitFinish('STOP'),
      ];
      const events = parseEvents(chunks);

      expectBalancedBlockLifecycle(events);
      expect(events.map((event) => event.delta?.signature).filter(Boolean)).toEqual([
        'pending-tool-signature',
      ]);
      expect(events.find((event) => event.content_block?.type === 'tool_use')).toMatchObject({
        index: 1,
      });
    });

    it('emits tool_use stop reason when functionCall appears in stream', () => {
      const processor = new PartProcessor(state);
      const functionChunks = processor.process({
        functionCall: {
          name: 'builtin_web_search',
          args: { query: 'gemini docs' },
          id: 'call_stream_1',
        },
      });
      const finishChunks = state.emitFinish('STOP', {
        promptTokenCount: 2,
        candidatesTokenCount: 3,
      } as any);

      const output = [...functionChunks, ...finishChunks].join('');
      expect(output).toContain('"type":"tool_use"');
      expect(output).toContain('"stop_reason":"tool_use"');
      expect(output).toContain('"message_stop"');
    });

    it('normalizes omitted function arguments without mutating the streamed part', () => {
      const processor = new PartProcessor(state);
      const functionCall = { id: 'call_empty', name: 'lookup' };
      const output = processor.process({ functionCall: functionCall as never }).join('');

      expect(functionCall).not.toHaveProperty('args');
      expect(output).toContain('"partial_json":"{}"');
    });

    it('rejects malformed present arguments before a same-part text payload is emitted', () => {
      const processor = new PartProcessor(state);

      expect(() =>
        processor.process({
          functionCall: { args: [], name: 'invalid' },
          text: 'partial',
        } as never),
      ).toThrow('functionCall.args');
    });

    it.each([
      ['sToP', 'end_turn'],
      ['mAx_ToKeNs', 'max_tokens'],
      ['BLOCKLIST', 'refusal'],
      ['MALFORMED_FUNCTION_CALL', 'refusal'],
      ['IMAGE_SAFETY', 'refusal'],
      ['FUTURE_GEMINI_REASON', 'refusal'],
    ])('emits valid Anthropic stop reason %s for Gemini %s', (finishReason, stopReason) => {
      const output = state.emitFinish(finishReason).join('');

      expect(output).toContain(`"stop_reason":"${stopReason}"`);
      expect(output).not.toContain(finishReason);
    });

    it('suppresses an exact explicit tool call replay', () => {
      const processor = new PartProcessor(state);
      const first = processor.process({
        functionCall: {
          args: { query: 'gemini docs' },
          id: 'call_stream_1',
          name: 'builtin_web_search',
        },
      });
      const replay = processor.process({
        functionCall: {
          args: { query: 'gemini docs' },
          id: 'call_stream_1',
          name: 'builtin_web_search',
        },
      });

      expect(first.join('')).toContain('"type":"tool_use"');
      expect(replay).toEqual([]);
    });

    it('rejects a conflicting explicit tool call id across frames', () => {
      const processor = new PartProcessor(state);
      processor.process({
        functionCall: {
          args: { query: 'gemini docs' },
          id: 'call_stream_1',
          name: 'builtin_web_search',
        },
      });

      expect(() =>
        processor.process({
          functionCall: {
            args: { query: 'other docs' },
            id: 'call_stream_1',
            name: 'builtin_web_search',
          },
        }),
      ).toThrow(ToolCallIdConflictError);
    });

    it('emits distinct generated ids for repeated tool calls without upstream ids', () => {
      const processor = new PartProcessor(state);
      const first = processor.process({
        functionCall: { args: { query: 'gemini docs' }, name: 'builtin_web_search' },
      });
      const second = processor.process({
        functionCall: { args: { query: 'gemini docs' }, name: 'builtin_web_search' },
      });
      const getToolId = (chunks: string[]) => chunks.join('').match(/"id":"([^"]+)"/)?.[1];

      expect(getToolId(first)).toBeDefined();
      expect(getToolId(second)).toBeDefined();
      expect(getToolId(first)).not.toBe(getToolId(second));
    });

    it('aggregates grounding metadata into final text block', () => {
      state.webSearchQuery = 'gemini api';
      state.groundingChunks = [
        {
          web: {
            title: 'Gemini API Docs',
            uri: 'https://example.com/gemini',
          },
        },
      ];

      const chunks = state.emitFinish('STOP', {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
      } as any);
      const output = chunks.join('');

      expect(output).toContain('Searched for you');
      expect(output).toContain('Citations');
      expect(output).toContain('https://example.com/gemini');
    });

    it('includes reasoning tokens in Anthropic streaming output usage', () => {
      const output = state
        .emitFinish('STOP', {
          promptTokenCount: 2,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 4,
        })
        .join('');

      expect(output).toContain('"input_tokens":2');
      expect(output).toContain('"output_tokens":7');
    });
  });
});
