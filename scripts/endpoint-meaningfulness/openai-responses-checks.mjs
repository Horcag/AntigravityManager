/**
 * OpenAI Responses-surface meaningfulness checks.
 *
 * Separate from the Chat Completions checks because this is where the
 * stream/unary agreement is actually decidable: the terminal
 * `response.completed` event carries the whole response, so the concatenated
 * deltas can be compared against it exactly. That comparison is the one this
 * script exists for — the stream mapper and the response mapper in this
 * codebase have drifted apart before.
 */

import { NATURAL_PROMPT } from './fixtures.mjs';

const RESPONSES_PATH = '/v1/responses';

/** Walks the Responses `output` tree the way a client renders it. */
export function collectResponsesText(response) {
  if (!Array.isArray(response?.output)) {
    return '';
  }

  return response.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part) => part?.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');
}

export const OPENAI_RESPONSES_CHECKS = [
  {
    name: 'openai.responses.unary',
    surface: 'openai',
    endpoint: `POST ${RESPONSES_PATH}`,
    title: 'the Responses envelope is complete and its usage is internally consistent',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(RESPONSES_PATH, {
        body: { model: ctx.model, input: NATURAL_PROMPT, max_output_tokens: 256 },
      });
      t.equal(response.status, 200, 'HTTP status');

      const body = response.json;
      t.nonEmptyString(body?.id, 'id');
      t.equal(body?.object, 'response', 'object');
      t.positiveInteger(body?.created_at, 'created_at');
      t.nonEmptyString(body?.model, 'model');
      t.equal(body?.status, 'completed', 'status');
      t.nonEmptyArray(body?.output, 'output');
      t.nonEmptyString(collectResponsesText(body), 'the concatenated output_text');

      const usage = body?.usage;
      if (t.plainObject(usage, 'usage')) {
        t.positiveInteger(usage.input_tokens, 'usage.input_tokens');
        t.positiveInteger(usage.output_tokens, 'usage.output_tokens');
        t.equal(
          usage.total_tokens,
          (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          'usage.total_tokens === input_tokens + output_tokens',
        );
      }
    },
  },
  {
    name: 'openai.responses.stream-consistency',
    surface: 'openai',
    endpoint: `POST ${RESPONSES_PATH} (stream)`,
    title: 'concatenated output_text deltas equal the completed response',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.sse(RESPONSES_PATH, {
        body: {
          model: ctx.model,
          input: NATURAL_PROMPT,
          max_output_tokens: 256,
          stream: true,
        },
      });
      t.equal(response.status, 200, 'HTTP status');

      const events = response.events.filter((event) => event.json !== undefined);
      if (!t.nonEmptyArray(events, 'parsed stream events')) {
        return;
      }

      t.ok(
        events.every((event) => event.event === undefined || event.event === event.json.type),
        'every SSE event name matches the payload type',
        'event name === data.type',
        events
          .filter((event) => event.event !== undefined && event.event !== event.json.type)
          .map((event) => ({ event: event.event, type: event.json.type })),
      );

      const streamed = events
        .filter((event) => event.json.type === 'response.output_text.delta')
        .map((event) => event.json.delta ?? '')
        .join('');
      t.nonEmptyString(streamed, 'the concatenated output_text deltas');

      const completed = events.find((event) => event.json.type === 'response.completed');
      if (
        !t.ok(
          completed !== undefined,
          'a response.completed event arrives',
          'response.completed',
          events.map((event) => event.json.type),
        )
      ) {
        return;
      }

      const finalText = collectResponsesText(completed.json.response);
      t.equal(finalText, streamed, 'the completed response text equals the concatenated deltas');
      t.equal(
        completed.json.response?.status,
        'completed',
        'response.completed carries status=completed',
      );
      t.positiveInteger(
        completed.json.response?.usage?.output_tokens,
        'the terminal usage.output_tokens',
      );
    },
  },
];
