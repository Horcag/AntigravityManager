/**
 * Regressions for the six adapter-conformance defects found by probing the live
 * build 0.19.29-local1 on 2026-08-09 (kanban #50).
 *
 * Every assertion is on a *final* artefact — the request body handed to the
 * transport, or the response body / SSE frames handed to the client — because
 * earlier fixes in this area passed against intermediate objects and still
 * failed live.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request-exception';
import { createProxyConformanceApp } from '../support/proxy-conformance-harness';
import { parseSseEvents } from '../support/http-payloads';

function sseFrames(payload: string): { event?: string; data: Record<string, any> }[] {
  return parseSseEvents(payload).map((frame) => ({
    ...(frame.event ? { event: frame.event } : {}),
    data: JSON.parse(frame.data) as Record<string, any>,
  }));
}

const proxyService = {
  handleAnthropicCountTokens: vi.fn(),
  handleAnthropicMessages: vi.fn(),
  handleChatCompletions: vi.fn(),
  handleGeminiCountTokens: vi.fn(),
  handleGeminiGenerateContent: vi.fn(),
  handleGeminiStreamGenerateContent: vi.fn(),
};

describe('adapter conformance defects (kanban #50)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createProxyConformanceApp({ proxyService });
  });

  beforeEach(() => {
    for (const handler of Object.values(proxyService)) {
      handler.mockReset();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('#1 response_format: json_object', () => {
    it('puts responseMimeType on the outgoing payload, exactly as json_schema does', () => {
      const jsonObject = transformClaudeRequestIn({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'return json' }],
        response_format: { type: 'json_object' },
        metadata: { source: 'openai' },
      });
      const jsonSchema = transformClaudeRequestIn({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'return json' }],
        response_format: {
          type: 'json_schema',
          json_schema: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
        },
        metadata: { source: 'openai' },
      });

      expect(jsonObject.request.generationConfig?.responseMimeType).toBe('application/json');
      // The json_object form carries no schema, which is the only difference the
      // caller asked for.
      expect(jsonObject.request.generationConfig?.responseSchema).toBeUndefined();
      expect(jsonSchema.request.generationConfig?.responseMimeType).toBe('application/json');
    });

    it('leaves response_format: text alone', () => {
      const body = transformClaudeRequestIn({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        response_format: { type: 'text' },
        metadata: { source: 'openai' },
      });

      expect(body.request.generationConfig?.responseMimeType).toBeUndefined();
    });
  });

  describe('#2 Anthropic metadata', () => {
    it('never puts a sessionId on the outgoing payload for metadata.user_id', () => {
      const body = transformClaudeRequestIn({
        model: 'gemini-3-flash',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { user_id: 'u1' },
      });

      expect(body).not.toHaveProperty('sessionId');
      expect(JSON.stringify(body)).not.toContain('sessionId');
      expect(JSON.stringify(body)).not.toContain('u1');
    });

    it('never puts a sessionId on the outgoing payload for the OpenAI user field', () => {
      const body = transformClaudeRequestIn({
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        // `convertOpenAIToClaude` moves OpenAI's `user` here.
        metadata: { source: 'openai', user_id: 'openai-user' },
      });

      expect(JSON.stringify(body)).not.toContain('sessionId');
      expect(JSON.stringify(body)).not.toContain('openai-user');
    });
  });

  describe('#3 stop sequences', () => {
    const geminiTail = (text: string) => ({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    });

    it('keeps the sequences off the outgoing payload so the match stays observable', () => {
      const body = transformClaudeRequestIn({
        model: 'gemini-3-flash',
        max_tokens: 64,
        stop_sequences: ['gamma'],
        messages: [{ role: 'user', content: 'Output exactly: alpha beta gamma delta' }],
      });

      expect(body.request.generationConfig?.stopSequences).toBeUndefined();
    });

    it('reports stop_reason and stop_sequence on the final response body', () => {
      const response = transformResponse(geminiTail('alpha beta gamma delta'), undefined, {
        stopSequences: ['gamma'],
      });

      expect(response.content).toEqual([{ type: 'text', text: 'alpha beta ' }]);
      expect(response.stop_reason).toBe('stop_sequence');
      expect(response.stop_sequence).toBe('gamma');
    });

    it('still reports end_turn when no sequence fired', () => {
      const response = transformResponse(geminiTail('alpha beta'), undefined, {
        stopSequences: ['gamma'],
      });

      expect(response.stop_reason).toBe('end_turn');
      expect(response.stop_sequence).toBeNull();
    });

    it('reports the match on the streaming message_delta, across frame boundaries', () => {
      const state = new StreamingState(undefined, 'gemini-3-flash', { stopSequences: ['gamma'] });
      const processor = new PartProcessor(state);
      const payload = [
        state.emitMessageStart({}),
        ...processor.process({ text: 'alpha beta gam' }),
        ...processor.process({ text: 'ma delta' }),
        ...state.emitFinish('STOP', {}),
      ].join('');

      const events = sseFrames(payload);
      const streamedText = events
        .filter((event) => event.event === 'content_block_delta')
        .map((event) => event.data.delta?.text ?? '')
        .join('');
      const messageDelta = events.find((event) => event.event === 'message_delta')?.data;

      expect(streamedText).toBe('alpha beta ');
      expect(messageDelta?.delta.stop_reason).toBe('stop_sequence');
      expect(messageDelta?.delta.stop_sequence).toBe('gamma');
    });

    it('releases a withheld tail when a tool call closes the text block', () => {
      const state = new StreamingState(undefined, 'gemini-3-flash', { stopSequences: ['gamma'] });
      const processor = new PartProcessor(state);
      const payload = [
        state.emitMessageStart({}),
        ...processor.process({ text: 'alpha gam' }),
        ...processor.process({ functionCall: { id: 'toolu_1', name: 'lookup', args: {} } }),
        ...state.emitFinish('STOP', {}),
      ].join('');

      const streamedText = sseFrames(payload)
        .filter((event) => event.event === 'content_block_delta')
        .map((event) => event.data.delta?.text ?? '')
        .join('');

      expect(streamedText).toBe('alpha gam');
    });

    it('releases text withheld as a partial match when the stream ends without one', () => {
      const state = new StreamingState(undefined, 'gemini-3-flash', { stopSequences: ['gamma'] });
      const processor = new PartProcessor(state);
      const payload = [
        state.emitMessageStart({}),
        ...processor.process({ text: 'alpha gam' }),
        ...state.emitFinish('STOP', {}),
      ].join('');

      const events = sseFrames(payload);
      const streamedText = events
        .filter((event) => event.event === 'content_block_delta')
        .map((event) => event.data.delta?.text ?? '')
        .join('');

      expect(streamedText).toBe('alpha gam');
      expect(events.find((event) => event.event === 'message_delta')?.data.delta.stop_reason).toBe(
        'end_turn',
      );
    });
  });

  describe('#4 upstream parameter rejections', () => {
    it.each([
      { message: 'Logprobs is not enabled for this model', param: 'logprobs' },
      { message: 'Multiple candidates is not enabled for this model', param: 'n' },
    ])('types "$message" as invalid_request_error naming $param', async ({ message, param }) => {
      proxyService.handleChatCompletions.mockRejectedValueOnce(
        new UpstreamRequestError({ message, status: 400 }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'conformance-model', messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: { message, type: 'invalid_request_error', param, code: 'unsupported_parameter' },
      });
    });

    it('recognises a control it was never told about, and grades the code', async () => {
      // The rule keys off the upstream status plus the generation control the
      // provider named, so a rejection neither of the two probed messages
      // covers is typed the same way.
      proxyService.handleChatCompletions.mockRejectedValueOnce(
        new UpstreamRequestError({
          message: 'Temperature must be <= 1 for this model',
          status: 400,
        }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'conformance-model', messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(response.json().error).toMatchObject({
        type: 'invalid_request_error',
        param: 'temperature',
        code: 'invalid_value',
      });
    });

    it('types an unrecognised 400 as invalid_request_error without inventing a param', async () => {
      proxyService.handleChatCompletions.mockRejectedValueOnce(
        new UpstreamRequestError({ message: 'Request contains an invalid argument', status: 400 }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'conformance-model', messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(response.json().error).toEqual({
        message: 'Request contains an invalid argument',
        type: 'invalid_request_error',
      });
    });

    it('still types a genuine upstream failure as server_error', async () => {
      proxyService.handleChatCompletions.mockRejectedValueOnce(
        new UpstreamRequestError({ message: 'Internal error', status: 500 }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'conformance-model', messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().error.type).toBe('server_error');
    });
  });

  describe('#5 unserved routes answer in the surface shape', () => {
    it.each([
      'embeddings',
      'moderations',
      'uploads',
      'vector_stores',
      'fine_tuning/jobs',
      'audio/speech',
      'audio/translations',
    ])('answers POST /v1/%s in the OpenAI error shape', async (route) => {
      const response = await app.inject({ method: 'POST', url: `/v1/${route}`, payload: {} });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.code).toBe('unknown_url');
      expect(body.error.message).toContain(`POST /v1/${route}`);
      expect(body).not.toHaveProperty('statusCode');
    });

    it('answers an unserved Anthropic route in the Anthropic error shape', async () => {
      // `/v1/messages/batches` and `/v1/complete` used to stand here; kanban #51
      // implemented both, so the assertion moved to a subresource Anthropic owns
      // and we do not serve.
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages/unserved',
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('not_found_error');
      expect(body.request_id).toMatch(/^req_[0-9a-f]{32}$/u);
      expect(response.headers['request-id']).toBe(body.request_id);
    });

    it.each(['cachedContents', 'tunedModels', 'corpora', 'operations'])(
      'answers POST /v1beta/%s in the Gemini error shape',
      async (route) => {
        const response = await app.inject({ method: 'POST', url: `/v1beta/${route}`, payload: {} });

        expect(response.statusCode).toBe(404);
        expect(response.json().error).toMatchObject({ code: 404, status: 'NOT_FOUND' });
      },
    );

    it('names the transport as the reason for embeddings and context caching', async () => {
      const embeddings = await app.inject({ method: 'POST', url: '/v1/embeddings', payload: {} });
      const cached = await app.inject({
        method: 'POST',
        url: '/v1beta/cachedContents',
        payload: {},
      });

      expect(embeddings.json().error.message).toContain('no embedding RPC');
      expect(embeddings.json().error.message).not.toContain('not yet');
      expect(cached.json().error.message).toContain('no context cache');
    });

    it('does not shadow the routes that are implemented', async () => {
      const files = await app.inject({ method: 'GET', url: '/v1/files' });
      const geminiFiles = await app.inject({ method: 'GET', url: '/v1beta/files' });
      const storedResponse = await app.inject({ method: 'GET', url: '/v1/responses/resp_missing' });
      // Landed after this suite was written (kanban #51). Listed here so the
      // catch-all can never quietly reclaim them.
      const batches = await app.inject({ method: 'GET', url: '/v1/batches' });
      const messageBatches = await app.inject({ method: 'GET', url: '/v1/messages/batches' });
      // Landed after this suite was written (kanban #54).
      const retrievedModel = await app.inject({
        method: 'GET',
        url: '/v1/models/conformance-model',
      });
      const unknownModel = await app.inject({ method: 'GET', url: '/v1/models/not-a-model' });

      expect(files.statusCode).toBe(200);
      expect(geminiFiles.statusCode).toBe(200);
      expect(batches.statusCode).toBe(200);
      expect(messageBatches.statusCode).toBe(200);
      expect(retrievedModel.statusCode).toBe(200);
      // Served by the store controller: a real 404 for a handle it never issued,
      // in the OpenAI shape rather than the catch-all's `unknown_url`.
      expect(storedResponse.json().error?.code).not.toBe('unknown_url');
      // Same distinction for retrieve-model: the route exists, the model does
      // not, so the caller must not be told the URL was unknown.
      expect(unknownModel.statusCode).toBe(404);
      expect(unknownModel.json().error?.code).toBe('model_not_found');
    });

    it('leaves paths outside the API surfaces to the framework', async () => {
      const response = await app.inject({ method: 'GET', url: '/not-an-api-surface' });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ statusCode: 404 });
    });
  });

  describe('#6 thinking blocks', () => {
    const textWithSignature = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'OK', thoughtSignature: Buffer.from('sig-72').toString('base64') }],
          },
          finishReason: 'STOP',
        },
      ],
    };

    it('emits no trailing empty thinking block on a request that never asked for thinking', () => {
      const response = transformResponse(textWithSignature);

      expect(response.content).toEqual([{ type: 'text', text: 'OK' }]);
    });

    it('emits no empty thinking block in the stream either', () => {
      const state = new StreamingState(undefined, 'gemini-3-flash');
      const processor = new PartProcessor(state);
      const payload = [
        state.emitMessageStart({}),
        ...processor.process({
          text: 'OK',
          thoughtSignature: Buffer.from('sig-72').toString('base64'),
        }),
        ...state.emitFinish('STOP', {}),
      ].join('');

      const starts = sseFrames(payload)
        .filter((event) => event.event === 'content_block_start')
        .map((event) => event.data.content_block.type);

      expect(starts).toEqual(['text']);
      expect(payload).not.toContain('"thinking"');
    });

    it('keeps a real thought, with its signature, ordered before the text', () => {
      const signature = Buffer.from('real-thought-signature').toString('base64');
      const response = transformResponse({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'Let me work it out.', thought: true, thoughtSignature: signature },
                { text: 'The answer is 4.' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      });

      expect(response.content).toEqual([
        {
          type: 'thinking',
          thinking: 'Let me work it out.',
          signature: 'real-thought-signature',
        },
        { type: 'text', text: 'The answer is 4.' },
      ]);
    });

    it('hands a signature from a text-only part to the tool call it preceded', () => {
      const signature = Buffer.from('tool-call-signature').toString('base64');
      const response = transformResponse({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: '', thoughtSignature: signature },
                { functionCall: { id: 'toolu_1', name: 'lookup', args: { key: 'a' } } },
              ],
            },
          },
        ],
      });

      expect(response.content).toEqual([
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'lookup',
          input: { key: 'a' },
          signature: 'tool-call-signature',
        },
      ]);
    });

    it('streams thought content exactly as unary thinking content and keeps reasoned frames before answer', () => {
      const upstream = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'I should use the weather tool.' },
                { text: 'The weather is cloudy.' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          thoughtsTokenCount: 4,
        },
      };

      const unary = transformResponse(upstream);
      const unaryThinkingBlock = unary.content.find((block) => block.type === 'thinking');

      const state = new StreamingState(undefined, 'gemini-2.5-pro');
      const processor = new PartProcessor(state);
      const streamPayload = [
        state.emitMessageStart(upstream),
        ...upstream.candidates.flatMap((candidate) =>
          candidate.content.parts.map((part) => processor.process(part)).flat(),
        ),
        ...state.emitFinish('STOP', upstream.usageMetadata),
      ].join('');

      const frames = sseFrames(streamPayload);
      const thinkingDelta = frames
        .filter((frame) => frame.event === 'content_block_delta' && 'thinking' in frame.data.delta)
        .map((frame) => frame.data.delta.thinking)
        .join('');
      const firstThinkingStart = frames.findIndex(
        (frame) =>
          frame.event === 'content_block_start' && frame.data.content_block.type === 'thinking',
      );
      const firstTextStart = frames.findIndex(
        (frame) =>
          frame.event === 'content_block_start' && frame.data.content_block.type === 'text',
      );
      const firstThinkingDelta = frames.findIndex(
        (frame) => frame.event === 'content_block_delta' && 'thinking' in frame.data.delta,
      );
      const firstTextDelta = frames.findIndex(
        (frame) => frame.event === 'content_block_delta' && 'text' in frame.data.delta,
      );

      expect(unaryThinkingBlock).toEqual({
        type: 'thinking',
        thinking: 'I should use the weather tool.',
        signature: undefined,
      });
      expect(firstThinkingStart).toBeGreaterThan(-1);
      expect(firstTextStart).toBeGreaterThan(-1);
      expect(firstThinkingStart).toBeLessThan(firstTextStart);
      expect(firstThinkingDelta).toBeLessThan(firstTextDelta);
      expect(thinkingDelta).toBe('I should use the weather tool.');
    });
  });
});
