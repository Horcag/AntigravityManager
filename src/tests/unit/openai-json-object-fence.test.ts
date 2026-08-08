/**
 * `response_format: {"type":"json_object"}` returned a markdown-fenced object on
 * the live build 0.19.31-local1 (kanban #58). These tests pin the unwrap and,
 * just as importantly, every case in which it must not fire.
 */
import { describe, expect, it } from 'vitest';
import { lastValueFrom, Observable, of, toArray } from 'rxjs';

import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import { ModelRouteMissJournalService } from '@/modules/proxy-gateway/server/modules/shared/services/model-route-miss-journal.service';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import {
  applyOpenAIJsonObjectFence,
  unwrapJsonObjectFence,
} from '@/modules/proxy-gateway/server/modules/openai/chat/openai-json-object-fence';
import { attachModelRouteMetadata } from '@/modules/proxy-gateway/server/common/model-route-metadata';
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

const JSON_OBJECT_REQUEST: OpenAIChatRequest = {
  model: 'gemini-3-flash',
  messages: [{ role: 'user', content: 'return json' }],
  response_format: { type: 'json_object' },
};

function chatResponse(content: string | null): OpenAIChatResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gemini-3-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function unwrapNonStream(
  request: OpenAIChatRequest,
  content: string | null,
): string | null | undefined {
  const result = applyOpenAIJsonObjectFence(request, chatResponse(content), 'chat-completions');
  return (result as OpenAIChatResponse).choices[0].message.content;
}

function contentChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gemini-3-flash',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

const ROLE_CHUNK = `data: ${JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gemini-3-flash',
  choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
})}\n\n`;

const FINISH_CHUNK = `data: ${JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gemini-3-flash',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
})}\n\n`;

/** Text a client actually reassembles from the streamed content deltas. */
async function streamContent(
  request: OpenAIChatRequest,
  deltas: string[],
): Promise<{ frames: string[]; content: string }> {
  const source = of(ROLE_CHUNK, ...deltas.map(contentChunk), FINISH_CHUNK, 'data: [DONE]\n\n');
  const result = applyOpenAIJsonObjectFence(request, source, 'chat-completions');
  const frames = await lastValueFrom((result as Observable<string>).pipe(toArray()));
  const content = frames
    .filter((frame) => frame.startsWith('data: ') && !frame.startsWith('data: [DONE]'))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>)
    .flatMap((payload) => (payload.choices ?? []) as { delta?: { content?: unknown } }[])
    .map((choice) => (typeof choice.delta?.content === 'string' ? choice.delta.content : ''))
    .join('');
  return { frames, content };
}

describe('json_object fence unwrap (kanban #58)', () => {
  describe('unwrapJsonObjectFence', () => {
    it('unwraps a tagged fence holding nothing else', () => {
      expect(unwrapJsonObjectFence('```json\n{"city":"Paris"}\n```')).toBe('{"city":"Paris"}');
    });

    it('unwraps an untagged fence and a multi-line body verbatim', () => {
      expect(unwrapJsonObjectFence('```\n{\n  "a": 1\n}\n```')).toBe('{\n  "a": 1\n}');
    });

    it('tolerates surrounding whitespace and a longer backtick run', () => {
      expect(unwrapJsonObjectFence('\n````JSON \n[1,2]\n````  \n')).toBe('[1,2]');
    });

    it('leaves a fenced block with prose around it untouched', () => {
      expect(unwrapJsonObjectFence('Here you go:\n```json\n{"a":1}\n```')).toBeNull();
      expect(unwrapJsonObjectFence('```json\n{"a":1}\n```\nHope that helps.')).toBeNull();
    });

    it('leaves a fenced block whose body does not parse untouched', () => {
      expect(unwrapJsonObjectFence('```json\n{"a": 1,\n```')).toBeNull();
      expect(unwrapJsonObjectFence('```\nplain prose\n```')).toBeNull();
      expect(unwrapJsonObjectFence('```json\n\n```')).toBeNull();
    });

    it('leaves two fenced blocks untouched', () => {
      expect(unwrapJsonObjectFence('```json\n{"a":1}\n```\n```json\n{"b":2}\n```')).toBeNull();
    });

    it('leaves content that is already valid JSON untouched', () => {
      expect(unwrapJsonObjectFence('{"a":1}')).toBeNull();
    });
  });

  describe('non-streaming body', () => {
    it('unwraps the fence when the request asked for json_object', () => {
      expect(unwrapNonStream(JSON_OBJECT_REQUEST, '```json\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('never activates for json_schema, text, or an absent response_format', () => {
      const fenced = '```json\n{"a":1}\n```';
      const jsonSchema: OpenAIChatRequest = {
        ...JSON_OBJECT_REQUEST,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'city', schema: { type: 'object' } },
        },
      };
      expect(unwrapNonStream(jsonSchema, fenced)).toBe(fenced);
      expect(
        unwrapNonStream({ ...JSON_OBJECT_REQUEST, response_format: { type: 'text' } }, fenced),
      ).toBe(fenced);
      expect(unwrapNonStream({ ...JSON_OBJECT_REQUEST, response_format: undefined }, fenced)).toBe(
        fenced,
      );
    });

    it('leaves prose, unparseable bodies, plain JSON and tool-only choices alone', () => {
      const prose = 'Here you go:\n```json\n{"a":1}\n```';
      expect(unwrapNonStream(JSON_OBJECT_REQUEST, prose)).toBe(prose);
      expect(unwrapNonStream(JSON_OBJECT_REQUEST, '```json\n{"a": 1,\n```')).toBe(
        '```json\n{"a": 1,\n```',
      );
      expect(unwrapNonStream(JSON_OBJECT_REQUEST, '{"a":1}')).toBe('{"a":1}');
      expect(unwrapNonStream(JSON_OBJECT_REQUEST, null)).toBeNull();
    });

    it('keeps the model route metadata that drives the x-antigravity-* headers', () => {
      const response = attachModelRouteMetadata(chatResponse('```json\n{"a":1}\n```'), {
        requestedModel: 'gpt-4o',
        resolvedModel: 'gemini-3-flash',
        routeSource: 'alias',
      });
      const result = applyOpenAIJsonObjectFence(JSON_OBJECT_REQUEST, response, 'chat-completions');

      expect(result).toBe(response);
      expect((result as OpenAIChatResponse).choices[0].message.content).toBe('{"a":1}');
    });
  });

  describe('streaming path', () => {
    it('unwraps a fence split across deltas', async () => {
      const { content } = await streamContent(JSON_OBJECT_REQUEST, [
        '```js',
        'on\n{"ci',
        'ty":"Paris"}',
        '\n```',
      ]);

      expect(content).toBe('{"city":"Paris"}');
    });

    it('emits the withheld body before the finish chunk', async () => {
      const { frames } = await streamContent(JSON_OBJECT_REQUEST, ['```json\n{"a":1}\n```']);
      const payloads = frames
        .filter((frame) => frame.startsWith('data: ') && !frame.startsWith('data: [DONE]'))
        .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);

      expect(payloads.map((payload) => JSON.stringify(payload.choices))).toEqual([
        JSON.stringify([
          { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
        ]),
        JSON.stringify([{ index: 0, delta: { content: '{"a":1}' }, finish_reason: null }]),
        JSON.stringify([{ index: 0, delta: {}, finish_reason: 'stop' }]),
      ]);
      expect(frames.at(-1)).toBe('data: [DONE]\n\n');
    });

    it('passes an unfenced answer straight through after the first delta', async () => {
      const { content } = await streamContent(JSON_OBJECT_REQUEST, ['{"a"', ':1}']);

      expect(content).toBe('{"a":1}');
    });

    it('leaves a fenced block with prose around it byte-identical', async () => {
      const deltas = ['Here you go:\n', '```json\n', '{"a":1}\n', '```'];
      const { content } = await streamContent(JSON_OBJECT_REQUEST, deltas);

      expect(content).toBe(deltas.join(''));
    });

    it('leaves a fence whose body does not parse byte-identical', async () => {
      const deltas = ['```json\n', 'not json at all\n', '```'];
      const { content } = await streamContent(JSON_OBJECT_REQUEST, deltas);

      expect(content).toBe(deltas.join(''));
    });

    it('never activates for json_schema', async () => {
      const jsonSchema: OpenAIChatRequest = {
        ...JSON_OBJECT_REQUEST,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'city', schema: { type: 'object' } },
        },
      };
      const { frames } = await streamContent(jsonSchema, ['```json\n{"a":1}\n```']);

      expect(frames).toEqual([
        ROLE_CHUNK,
        contentChunk('```json\n{"a":1}\n```'),
        FINISH_CHUNK,
        'data: [DONE]\n\n',
      ]);
    });

    it('forwards heartbeats, the trace-id frame and reasoning deltas untouched', async () => {
      const reasoning = `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gemini-3-flash',
        choices: [
          { index: 0, delta: { content: null, reasoning_content: 'hmm' }, finish_reason: null },
        ],
      })}\n\n`;
      const trace = `data: ${JSON.stringify({ __cloudCodeMeta: { traceId: 't1' } })}\n\n`;
      const source = of(trace, ': ping\n\n', reasoning, contentChunk('{"a":1}'), FINISH_CHUNK);
      const result = applyOpenAIJsonObjectFence(JSON_OBJECT_REQUEST, source, 'chat-completions');

      await expect(lastValueFrom((result as Observable<string>).pipe(toArray()))).resolves.toEqual([
        trace,
        ': ping\n\n',
        reasoning,
        contentChunk('{"a":1}'),
        FINISH_CHUNK,
      ]);
    });

    it('gates each candidate independently', async () => {
      const candidateChunk = (index: number, content: string): string =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gemini-3-flash',
          choices: [{ index, delta: { content }, finish_reason: null }],
        })}\n\n`;
      const finish = (index: number): string =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gemini-3-flash',
          choices: [{ index, delta: {}, finish_reason: 'stop' }],
        })}\n\n`;
      const source = of(
        candidateChunk(0, '```json\n{"a":1}\n```'),
        candidateChunk(1, 'plain answer'),
        finish(0),
        finish(1),
      );
      const result = applyOpenAIJsonObjectFence(JSON_OBJECT_REQUEST, source, 'chat-completions');
      const frames = await lastValueFrom((result as Observable<string>).pipe(toArray()));
      const contents = frames
        .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>)
        .flatMap(
          (payload) =>
            (payload.choices ?? []) as { index: number; delta?: { content?: unknown } }[],
        )
        .filter((choice) => typeof choice.delta?.content === 'string')
        .map((choice) => [choice.index, choice.delta?.content]);

      expect(contents).toEqual([
        [1, 'plain answer'],
        [0, '{"a":1}'],
      ]);
    });

    it('leaves the /v1/responses event protocol alone', () => {
      const source = of('event: response.output_text.delta\ndata: {"delta":"```json"}\n\n');
      expect(applyOpenAIJsonObjectFence(JSON_OBJECT_REQUEST, source, 'responses')).toBe(source);
    });
  });

  describe('service wiring', () => {
    it('applies the unwrap to whatever the generation path returned', async () => {
      const service = new ProxyService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        new ModelRouteMissJournalService(),
        new SignatureStore(),
        {} as never,
      );
      Reflect.set(service, 'generateOpenAIChatCompletion', () =>
        Promise.resolve(chatResponse('```json\n{"a":1}\n```')),
      );

      const result = (await service.handleChatCompletions(
        JSON_OBJECT_REQUEST,
      )) as OpenAIChatResponse;

      expect(result.choices[0].message.content).toBe('{"a":1}');
    });
  });
});
