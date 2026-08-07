import { describe, it, expect, beforeEach } from 'vitest';
import {
  PartProcessor,
  StreamingState,
} from '../../modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { ToolCallIdConflictError } from '../../modules/proxy-gateway/antigravity/tool-call-id-integrity';

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
