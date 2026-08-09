import { describe, it, expect, beforeEach } from 'vitest';
import {
  PartProcessor,
  StreamingState,
} from '../../modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import { toAnthropicMessageId } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic-message-resource';

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

    it('should emit error event when error count exceeds 3', () => {
      // Simulate 4 parse errors
      state.handleParseError('error 1');
      state.handleParseError('error 2');
      state.handleParseError('error 3');
      const chunks = state.handleParseError('error 4');

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toContain('api_error');
      expect(chunks[0]).toContain('malformed streaming data');
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
    it('reuses an upstream msg_ id in message_start', () => {
      const streamStart = state.emitMessageStart({ responseId: 'msg_existing' });
      const dataLine = streamStart
        .split('\n')
        .find((line): line is string => line.startsWith('data: '));
      const startPayload = JSON.parse(dataLine?.slice('data: '.length) ?? '{}') as {
        message?: { id?: string };
      };

      expect(startPayload.message?.id).toBe(toAnthropicMessageId('msg_existing'));
      expect(startPayload.message?.id).toBe('msg_existing');
    });

    it('aligns stream and non-stream mappings for the same upstream id', () => {
      const response = transformResponse({ responseId: 'msg_existing' });
      const streamStart = state.emitMessageStart({ responseId: 'msg_existing' });
      const dataLine = streamStart
        .split('\n')
        .find((line): line is string => line.startsWith('data: '));
      const startPayload = JSON.parse(dataLine?.slice('data: '.length) ?? '{}') as {
        message?: { id?: string };
      };

      expect(response.id).toBe(startPayload.message?.id);
      expect(response.id).toBe(toAnthropicMessageId('msg_existing'));
    });

    it('generates a msg_ id when streaming lacks responseId', () => {
      const streamStart = state.emitMessageStart({ modelVersion: 'gemini-3-flash' });
      const dataLine = streamStart
        .split('\n')
        .find((line): line is string => line.startsWith('data: '));
      const startPayload = JSON.parse(dataLine?.slice('data: '.length) ?? '{}') as {
        message?: { id?: string };
      };

      expect(startPayload.message?.id).toMatch(/^msg_/u);
      expect(startPayload.message?.id).toMatch(/^msg_[0-9a-f-]{36}$/u);
      expect(startPayload.message?.id).not.toBe('msg_unknown');
    });

    it('always starts with zeroed usage when upstream omits usage metadata', () => {
      const event = state.emitMessageStart({ responseId: 'msg_1', modelVersion: 'gemini-3-flash' });

      expect(event).toContain('"usage":{"input_tokens":0,"output_tokens":0}');
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

    it('includes cache-read tokens in the final Anthropic usage event', () => {
      const chunks = state.emitFinish('STOP', {
        cachedContentTokenCount: 5,
        candidatesTokenCount: 3,
        promptTokenCount: 10,
      });

      expect(chunks.join('')).toContain('"cache_read_input_tokens":5');
    });

    it('preserves Interactions usage fields in the final Anthropic event', () => {
      const chunks = state.emitFinish('STOP', {
        total_input_tokens: 100,
        total_output_tokens: 12,
        total_cached_tokens: 40,
        total_thought_tokens: 7,
      });

      expect(chunks.join('')).toContain(
        '"input_tokens":100,"output_tokens":19,"cache_read_input_tokens":40',
      );
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

    it('maps Gemini safety termination to Anthropic refusal', () => {
      const chunks = state.emitFinish('SAFETY');

      expect(chunks.join('')).toContain('"stop_reason":"refusal"');
    });

    it('closes an active block before a terminal Anthropic error event', () => {
      state.startBlock('Text', { type: 'text', text: '' });

      const chunks = state.emitTerminalError('timeout_error', 'Upstream timed out.');

      expect(chunks).toEqual([
        expect.stringContaining('event: content_block_stop'),
        'event: error\ndata: {"type":"error","error":{"type":"timeout_error","message":"Upstream timed out."}}\n\n',
      ]);
      expect(chunks.join('')).not.toContain('message_stop');
    });

    it('balances content block indexes for parallel tool calls', () => {
      const processor = new PartProcessor(state);
      const chunks = [
        ...processor.process({
          functionCall: { id: 'toolu_1', name: 'lookup', args: { key: 'a' } },
        }),
        ...processor.process({
          functionCall: { id: 'toolu_2', name: 'lookup', args: { key: 'b' } },
        }),
        ...state.emitFinish('STOP'),
      ];
      const payload = chunks.join('');

      expect(payload.match(/event: content_block_start/g)).toHaveLength(2);
      expect(payload.match(/event: content_block_stop/g)).toHaveLength(2);
      expect(payload).toContain('"index":0');
      expect(payload).toContain('"index":1');
      expect(payload).toContain('"stop_reason":"tool_use"');
    });

    it('emits no thinking block for a text part that only carries a signature', () => {
      const processor = new PartProcessor(state);
      const signature = Buffer.from('opaque-signature').toString('base64');
      const payload = [
        ...processor.process({ text: 'answer', thoughtSignature: signature }),
        ...state.emitFinish('STOP'),
      ].join('');

      expect(payload.match(/event: content_block_start/g)).toHaveLength(1);
      expect(payload.match(/event: content_block_stop/g)).toHaveLength(1);
      expect(payload).toContain('"content_block":{"type":"text","text":""}');
      expect(payload).not.toContain('"type":"thinking"');
      expect(payload).not.toContain('signature_delta');
    });

    it('hands a banked signature to the following function call, not to a new block', () => {
      const processor = new PartProcessor(state);
      const signature = Buffer.from('trailing-signature').toString('base64');
      const payload = [
        ...processor.process({ text: '', thoughtSignature: signature }),
        ...processor.process({ functionCall: { id: 'toolu_1', name: 'lookup', args: {} } }),
        ...state.emitFinish('STOP'),
      ].join('');

      expect(payload.match(/event: content_block_start/g)).toHaveLength(1);
      expect(payload.match(/event: content_block_stop/g)).toHaveLength(1);
      expect(payload).not.toContain('"type":"thinking"');
      expect(payload).toContain('"type":"tool_use","id":"toolu_1"');
      expect(payload).toContain('"signature":"trailing-signature"');
    });
  });
});
