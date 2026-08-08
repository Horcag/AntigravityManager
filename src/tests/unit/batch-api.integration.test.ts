import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import { attachModelRouteMetadata } from '@/modules/proxy-gateway/server/common/model-route-metadata';
import { createProxyConformanceApp } from '../support/proxy-conformance-harness';
import { createMultipartPayload } from '../support/http-payloads';

const proxyService = {
  handleAnthropicCountTokens: vi.fn(),
  handleAnthropicMessages: vi.fn(),
  handleChatCompletions: vi.fn(),
  handleGeminiCountTokens: vi.fn(),
  handleGeminiGenerateContent: vi.fn(),
  handleGeminiStreamGenerateContent: vi.fn(),
};

function withRoute<T extends object>(value: T): T {
  return attachModelRouteMetadata(value, {
    requestedModel: 'conformance-model',
    resolvedModel: 'conformance-model',
    servedModel: 'conformance-model',
    routeSource: 'canonical',
  });
}

function chatBody(prompt: string) {
  return { model: 'conformance-model', messages: [{ role: 'user', content: prompt }] };
}

function messagesBody(prompt: string) {
  return {
    model: 'conformance-model',
    max_tokens: 16,
    messages: [{ role: 'user', content: prompt }],
  };
}

describe('local batch API across the three surfaces', () => {
  let app: NestFastifyApplication;

  async function drain(): Promise<void> {
    await app.get(BatchRunnerService).drain();
  }

  async function uploadJsonl(lines: unknown[]): Promise<string> {
    const boundary = '----agmbatch';
    const payload = createMultipartPayload(
      boundary,
      [['purpose', 'batch']],
      [
        {
          bytes: Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8'),
          field: 'file',
          filename: 'requests.jsonl',
          mimeType: 'application/jsonl',
        },
      ],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(response.statusCode).toBe(200);
    return response.json().id as string;
  }

  beforeEach(async () => {
    app = await createProxyConformanceApp({ proxyService });
    vi.clearAllMocks();
    proxyService.handleChatCompletions.mockImplementation(async () =>
      withRoute({
        id: 'chatcmpl-batch',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'conformance-model',
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    proxyService.handleAnthropicMessages.mockImplementation(async () =>
      withRoute({
        id: 'msg_batch',
        type: 'message',
        role: 'assistant',
        model: 'conformance-model',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }),
    );
    proxyService.handleGeminiGenerateContent.mockImplementation(async () =>
      withRoute({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('OpenAI /v1/batches', () => {
    it('runs a batch end to end and writes JSONL output back into the file store', async () => {
      const inputFileId = await uploadJsonl([
        { custom_id: 'a', method: 'POST', url: '/v1/chat/completions', body: chatBody('one') },
        { custom_id: 'b', method: 'POST', url: '/v1/chat/completions', body: chatBody('two') },
      ]);

      const created = await app.inject({
        method: 'POST',
        url: '/v1/batches',
        payload: {
          input_file_id: inputFileId,
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
          metadata: { note: 'conformance' },
        },
      });
      expect(created.statusCode).toBe(200);
      const batch = created.json();
      expect(batch).toMatchObject({
        object: 'batch',
        endpoint: '/v1/chat/completions',
        input_file_id: inputFileId,
        completion_window: '24h',
        metadata: { note: 'conformance' },
      });
      expect(batch.id).toMatch(/^batch_[0-9a-f]{24}$/u);
      // Honest counts: nothing has completed at creation time.
      expect(batch.request_counts).toEqual({ total: 2, completed: 0, failed: 0 });
      expect(['validating', 'in_progress']).toContain(batch.status);

      await drain();

      const fetched = await app.inject({ method: 'GET', url: `/v1/batches/${batch.id}` });
      const done = fetched.json();
      expect(done.status).toBe('completed');
      expect(done.request_counts).toEqual({ total: 2, completed: 2, failed: 0 });
      expect(done.output_file_id).toMatch(/^file-[0-9a-f]{32}$/u);
      expect(done.error_file_id).toBeNull();

      const output = await app.inject({
        method: 'GET',
        url: `/v1/files/${done.output_file_id}/content`,
      });
      const lines = output.payload
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        custom_id: 'a',
        error: null,
        response: { status_code: 200, body: { object: 'chat.completion' } },
      });
      expect(lines.map((line) => line.custom_id)).toEqual(['a', 'b']);

      const listed = await app.inject({ method: 'GET', url: '/v1/batches' });
      expect(listed.json().data.some((entry: { id: string }) => entry.id === batch.id)).toBe(true);
    });

    it('keeps a failing line to itself and reports it through the error file', async () => {
      proxyService.handleChatCompletions.mockImplementation(async (request: unknown) => {
        if (JSON.stringify(request).includes('boom')) {
          throw Object.assign(new Error('model refused'), { status: 400 });
        }
        return withRoute({
          id: 'chatcmpl-batch',
          object: 'chat.completion',
          created: 1,
          model: 'conformance-model',
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
          ],
        });
      });
      const inputFileId = await uploadJsonl([
        { custom_id: 'good', body: chatBody('fine') },
        { custom_id: 'bad', body: chatBody('boom') },
      ]);

      const created = await app.inject({
        method: 'POST',
        url: '/v1/batches',
        payload: {
          input_file_id: inputFileId,
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
        },
      });
      await drain();

      const done = (
        await app.inject({ method: 'GET', url: `/v1/batches/${created.json().id}` })
      ).json();
      expect(done.status).toBe('completed');
      expect(done.request_counts).toEqual({ total: 2, completed: 1, failed: 1 });
      expect(done.error_file_id).toMatch(/^file-[0-9a-f]{32}$/u);

      const errors = await app.inject({
        method: 'GET',
        url: `/v1/files/${done.error_file_id}/content`,
      });
      const line = JSON.parse(errors.payload.trim());
      expect(line).toMatchObject({
        custom_id: 'bad',
        response: null,
        error: { message: 'model refused' },
      });
    });

    it('serves /v1/responses through the same preparation the live endpoint uses', async () => {
      const inputFileId = await uploadJsonl([
        {
          custom_id: 'r1',
          url: '/v1/responses',
          body: { model: 'conformance-model', input: 'summarise this' },
        },
      ]);
      const created = await app.inject({
        method: 'POST',
        url: '/v1/batches',
        payload: {
          input_file_id: inputFileId,
          endpoint: '/v1/responses',
          completion_window: '24h',
        },
      });
      expect(created.statusCode).toBe(200);
      await drain();

      const done = (
        await app.inject({ method: 'GET', url: `/v1/batches/${created.json().id}` })
      ).json();
      expect(done.status).toBe('completed');
      expect(done.request_counts).toEqual({ total: 1, completed: 1, failed: 0 });

      const output = await app.inject({
        method: 'GET',
        url: `/v1/files/${done.output_file_id}/content`,
      });
      const line = JSON.parse(output.payload.trim());
      expect(line.custom_id).toBe('r1');
      expect(line.response.body).toMatchObject({ object: 'response' });
      // The Responses protocol was requested from the proxy service, not chat.
      expect(proxyService.handleChatCompletions.mock.calls[0][1]).toBe('responses');
    });

    it('rejects an endpoint it cannot serve, naming the ones it can', async () => {
      const inputFileId = await uploadJsonl([{ custom_id: 'a', body: { input: 'x' } }]);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batches',
        payload: {
          input_file_id: inputFileId,
          endpoint: '/v1/embeddings',
          completion_window: '24h',
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.param).toBe('endpoint');
      expect(response.json().error.message).toContain('/v1/chat/completions');
      expect(response.json().error.message).toContain('no embedding RPC');
    });

    it('rejects a completion window it does not honour', async () => {
      const inputFileId = await uploadJsonl([{ custom_id: 'a', body: chatBody('x') }]);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/batches',
        payload: {
          input_file_id: inputFileId,
          endpoint: '/v1/chat/completions',
          completion_window: '7d',
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.param).toBe('completion_window');
    });

    it('cancels an in-flight batch', async () => {
      let release: (value: unknown) => void = () => undefined;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      proxyService.handleChatCompletions.mockImplementation(async () => {
        await gate;
        return withRoute({ id: 'chatcmpl-late', object: 'chat.completion', choices: [] });
      });
      const inputFileId = await uploadJsonl([
        { custom_id: 'a', body: chatBody('one') },
        { custom_id: 'b', body: chatBody('two') },
        { custom_id: 'c', body: chatBody('three') },
      ]);
      const created = await app.inject({
        method: 'POST',
        url: '/v1/batches',
        payload: {
          input_file_id: inputFileId,
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
        },
      });
      const id = created.json().id as string;

      const cancelled = await app.inject({ method: 'POST', url: `/v1/batches/${id}/cancel` });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().status).toBe('cancelling');
      expect(cancelled.json().cancelling_at).toEqual(expect.any(Number));

      release(undefined);
      await drain();

      const done = (await app.inject({ method: 'GET', url: `/v1/batches/${id}` })).json();
      expect(done.status).toBe('cancelled');
      expect(done.request_counts).toEqual({ total: 3, completed: 0, failed: 3 });
    });

    it('reports an unknown batch as not found', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/batches/batch_000000000000000000000000',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('not_found');
    });
  });

  describe('Anthropic /v1/messages/batches', () => {
    it('takes inline requests and streams back the documented result lines', async () => {
      proxyService.handleAnthropicMessages.mockImplementation(async (request: unknown) => {
        if (JSON.stringify(request).includes('explode')) {
          throw Object.assign(new Error('overloaded'), { status: 529 });
        }
        return withRoute({
          id: 'msg_batch',
          type: 'message',
          role: 'assistant',
          model: 'conformance-model',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        });
      });

      const created = await app.inject({
        method: 'POST',
        url: '/v1/messages/batches',
        headers: { 'anthropic-version': '2023-06-01' },
        payload: {
          requests: [
            { custom_id: 'first', params: messagesBody('hello') },
            { custom_id: 'second', params: messagesBody('explode') },
          ],
        },
      });
      expect(created.statusCode).toBe(200);
      const batch = created.json();
      expect(batch).toMatchObject({ type: 'message_batch', processing_status: 'in_progress' });
      expect(batch.id).toMatch(/^msgbatch_[0-9a-f]{24}$/u);
      expect(batch.results_url).toBeNull();
      expect(batch.request_counts.processing).toBe(2);

      await drain();

      const done = (
        await app.inject({ method: 'GET', url: `/v1/messages/batches/${batch.id}` })
      ).json();
      expect(done.processing_status).toBe('ended');
      expect(done.request_counts).toEqual({
        processing: 0,
        succeeded: 1,
        errored: 1,
        canceled: 0,
        expired: 0,
      });
      expect(done.results_url).toBe(`/v1/messages/batches/${batch.id}/results`);
      expect(done.ended_at).toEqual(expect.any(String));

      const results = await app.inject({
        method: 'GET',
        url: `/v1/messages/batches/${batch.id}/results`,
      });
      expect(results.headers['content-type']).toContain('application/x-jsonl');
      const lines = results.payload
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(lines[0]).toMatchObject({
        custom_id: 'first',
        result: { type: 'succeeded', message: { type: 'message' } },
      });
      expect(lines[1]).toMatchObject({
        custom_id: 'second',
        result: { type: 'errored', error: { type: 'error', error: { message: 'overloaded' } } },
      });

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/messages/batches/${batch.id}`,
      });
      expect(deleted.json()).toEqual({ id: batch.id, type: 'message_batch_deleted' });
      expect(
        (await app.inject({ method: 'GET', url: `/v1/messages/batches/${batch.id}` })).statusCode,
      ).toBe(404);
    });

    it('refuses results until the batch has ended', async () => {
      let release: (value: unknown) => void = () => undefined;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      proxyService.handleAnthropicMessages.mockImplementation(async () => {
        await gate;
        return withRoute({ id: 'msg_late', type: 'message', content: [] });
      });

      const created = await app.inject({
        method: 'POST',
        url: '/v1/messages/batches',
        payload: { requests: [{ custom_id: 'first', params: messagesBody('slow') }] },
      });
      const id = created.json().id as string;

      const early = await app.inject({ method: 'GET', url: `/v1/messages/batches/${id}/results` });
      expect(early.statusCode).toBe(400);
      expect(early.json().error.message).toContain('available once it has ended');

      release(undefined);
      await drain();
      expect(
        (await app.inject({ method: 'GET', url: `/v1/messages/batches/${id}/results` })).statusCode,
      ).toBe(200);
    });

    it('rejects a request array it cannot read', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages/batches',
        payload: { requests: [{ custom_id: 'x' }] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error' },
      });
    });
  });

  describe('Gemini :batchGenerateContent and /v1beta/operations', () => {
    it('answers with an operation and completes it through the operations route', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1beta/models/conformance-model:batchGenerateContent',
        payload: {
          batch: {
            displayName: 'conformance-batch',
            inputConfig: {
              requests: {
                requests: [
                  {
                    request: { contents: [{ role: 'user', parts: [{ text: 'one' }] }] },
                    metadata: { key: 'alpha' },
                  },
                  {
                    request: { contents: [{ role: 'user', parts: [{ text: 'two' }] }] },
                    metadata: { key: 'beta' },
                  },
                ],
              },
            },
          },
        },
      });
      expect(created.statusCode).toBe(200);
      const operation = created.json();
      expect(operation.name).toMatch(/^operations\/[0-9a-f]{24}$/u);
      expect(operation.done).toBe(false);
      expect(operation.metadata).toMatchObject({
        model: 'models/conformance-model',
        displayName: 'conformance-batch',
      });
      expect(operation.metadata.batchStats.requestCount).toBe('2');

      await drain();

      const polled = await app.inject({
        method: 'GET',
        url: `/v1beta/${operation.name}`,
      });
      const done = polled.json();
      expect(done.done).toBe(true);
      expect(done.metadata.state).toBe('BATCH_STATE_SUCCEEDED');
      expect(done.error).toBeUndefined();
      const inlined = done.response.inlinedResponses.inlinedResponses;
      expect(inlined).toHaveLength(2);
      expect(inlined[0]).toMatchObject({
        metadata: { key: 'alpha' },
        response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
      });

      const listed = await app.inject({ method: 'GET', url: '/v1beta/operations' });
      expect(
        listed.json().operations.some((entry: { name: string }) => entry.name === operation.name),
      ).toBe(true);
    });

    it('rejects the file-input form it does not support', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1beta/models/conformance-model:batchGenerateContent',
        payload: { batch: { inputConfig: { fileName: 'files/abc' } } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.status).toBe('INVALID_ARGUMENT');
      expect(response.json().error.message).toContain('inlined requests array');
    });

    it('still reports embedding actions as unimplemented', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1beta/models/conformance-model:embedContent',
        payload: { content: { parts: [{ text: 'x' }] } },
      });
      expect(response.statusCode).toBe(501);
      expect(response.json().error.status).toBe('UNIMPLEMENTED');
    });
  });

  describe('Anthropic legacy /v1/complete', () => {
    it('maps the prompt onto a single user turn and answers with a completion', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        headers: { 'anthropic-version': '2023-06-01' },
        payload: {
          model: 'conformance-model',
          prompt: '\n\nHuman: what is 2+2?\n\nAssistant:',
          max_tokens_to_sample: 32,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        type: 'completion',
        completion: ' ok',
        stop_reason: 'end_turn',
        model: 'conformance-model',
      });
      expect(response.headers['request-id']).toEqual(expect.any(String));

      const sent = proxyService.handleAnthropicMessages.mock.calls[0][0] as {
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
      expect(sent.max_tokens).toBe(32);
      expect(sent.messages).toEqual([{ role: 'user', content: 'what is 2+2?' }]);
    });

    it('keeps a prefilled assistant turn and a multi-turn prompt', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/complete',
        payload: {
          model: 'conformance-model',
          prompt: '\n\nHuman: hi\n\nAssistant: hello\n\nHuman: again\n\nAssistant:',
          max_tokens_to_sample: 8,
        },
      });
      const sent = proxyService.handleAnthropicMessages.mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(sent.messages).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' },
      ]);
    });

    it('refuses the fields it cannot honour', async () => {
      const missing = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        payload: { model: 'conformance-model', prompt: 'hi' },
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.type).toBe('invalid_request_error');

      const streamed = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        payload: {
          model: 'conformance-model',
          prompt: '\n\nHuman: hi\n\nAssistant:',
          max_tokens_to_sample: 8,
          stream: true,
        },
      });
      expect(streamed.statusCode).toBe(400);
      expect(streamed.json().error.message).toContain('/v1/messages');
    });
  });
});
