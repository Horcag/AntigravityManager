/**
 * Anthropic-surface meaningfulness checks.
 *
 * `stop_reason` is the field this surface most often gets wrong — a fired stop
 * sequence reported as `end_turn`, an empty `thinking` block appended to the
 * content — so the stop semantics and the content-block inventory are asserted
 * separately rather than folded into one shape check.
 */

import {
  COUNT_TOKENS_LONG,
  COUNT_TOKENS_SHORT,
  LONG_PROMPT,
  NATURAL_PROMPT,
  STOP_PROMPT,
  STOP_SEQUENCE,
  WEATHER_TOOL_NAME,
  WEATHER_TOOL_PROMPT,
  WEATHER_TOOL_SCHEMA,
} from './fixtures.mjs';
import { validateAgainstSchema } from './schema.mjs';

const MESSAGES_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

const ANTHROPIC_VERSION_HEADER = { 'anthropic-version': '2023-06-01' };

function messagesBody(ctx, overrides) {
  return {
    model: ctx.model,
    max_tokens: 256,
    messages: [{ role: 'user', content: NATURAL_PROMPT }],
    ...overrides,
  };
}

function textOf(body) {
  return (Array.isArray(body?.content) ? body.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function assertMessageEnvelope(t, body) {
  t.ok(
    typeof body?.id === 'string' && body.id.startsWith('msg_'),
    'id',
    'a string starting with msg_',
    body?.id,
  );
  t.equal(body?.type, 'message', 'type');
  t.equal(body?.role, 'assistant', 'role');
  t.nonEmptyString(body?.model, 'model');
  t.nonEmptyArray(body?.content, 'content');

  for (const [index, block] of (body?.content ?? []).entries()) {
    t.nonEmptyString(block?.type, `content[${index}].type`);
    if (block?.type === 'text') {
      t.nonEmptyString(block.text, `content[${index}].text`);
    }
    // A placeholder thinking block is indistinguishable from a real one to a
    // client, which then renders an empty reasoning panel. It must not be sent.
    if (block?.type === 'thinking') {
      t.ok(
        typeof block.thinking === 'string' && block.thinking.trim().length > 0,
        `content[${index}].thinking is not an empty placeholder`,
        'non-empty reasoning text',
        block.thinking,
      );
    }
  }
}

function assertMessageUsage(t, usage) {
  if (!t.plainObject(usage, 'usage')) {
    return;
  }

  t.positiveInteger(usage.input_tokens, 'usage.input_tokens');
  t.positiveInteger(usage.output_tokens, 'usage.output_tokens');
}

export const ANTHROPIC_CHECKS = [
  {
    name: 'anthropic.messages.natural-stop',
    surface: 'anthropic',
    endpoint: `POST ${MESSAGES_PATH}`,
    title: 'an untruncated answer reports end_turn, real content blocks and non-zero usage',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(MESSAGES_PATH, {
        body: messagesBody(ctx),
        headers: ANTHROPIC_VERSION_HEADER,
      });
      t.equal(response.status, 200, 'HTTP status');
      assertMessageEnvelope(t, response.json);
      t.equal(response.json?.stop_reason, 'end_turn', 'stop_reason');
      t.equal(response.json?.stop_sequence, null, 'stop_sequence');
      t.nonEmptyString(textOf(response.json), 'the concatenated text blocks');
      assertMessageUsage(t, response.json?.usage);

      ctx.record('anthropic.stop_reason.natural', response.json?.stop_reason);
    },
  },
  {
    name: 'anthropic.messages.max-tokens',
    surface: 'anthropic',
    endpoint: `POST ${MESSAGES_PATH}`,
    title: 'max_tokens truncates and is reported as stop_reason=max_tokens',
    upstreamCalls: 1,
    async run(ctx, t) {
      const cap = 16;
      const response = await ctx.json(MESSAGES_PATH, {
        body: messagesBody(ctx, {
          max_tokens: cap,
          messages: [{ role: 'user', content: LONG_PROMPT }],
        }),
        headers: ANTHROPIC_VERSION_HEADER,
      });
      t.equal(response.status, 200, 'HTTP status');
      t.equal(response.json?.stop_reason, 'max_tokens', 'stop_reason');

      const outputTokens = response.json?.usage?.output_tokens;
      t.ok(
        Number.isInteger(outputTokens) && outputTokens > 0 && outputTokens <= cap,
        'usage.output_tokens respects max_tokens',
        `an integer in 1..${cap}`,
        outputTokens,
      );

      const natural = ctx.recall('anthropic.stop_reason.natural');
      if (natural === undefined) {
        t.note('stop_reason discrimination not cross-checked: the natural-stop check did not run');
      } else {
        t.ok(
          natural !== response.json?.stop_reason,
          'truncated and natural answers report different stop_reason values',
          `something other than ${natural}`,
          response.json?.stop_reason,
        );
      }
    },
  },
  {
    name: 'anthropic.messages.stop-sequence',
    surface: 'anthropic',
    endpoint: `POST ${MESSAGES_PATH}`,
    title: 'a fired stop sequence is reported as stop_sequence, not end_turn',
    upstreamCalls: 2,
    async run(ctx, t) {
      // The same prompt is asked twice: once unconstrained, to learn what the
      // model would have said, and once with the stop sequence. Only when the
      // constrained answer is the unconstrained one cut exactly at the stop
      // text is it *certain* the stop fired — and only then is the reason
      // asserted, so a correct implementation can never fail this check.
      const control = await ctx.json(MESSAGES_PATH, {
        body: messagesBody(ctx, { messages: [{ role: 'user', content: STOP_PROMPT }] }),
        headers: ANTHROPIC_VERSION_HEADER,
      });
      t.equal(control.status, 200, 'HTTP status (without stop_sequences)');

      const response = await ctx.json(MESSAGES_PATH, {
        body: messagesBody(ctx, {
          messages: [{ role: 'user', content: STOP_PROMPT }],
          stop_sequences: [STOP_SEQUENCE],
        }),
        headers: ANTHROPIC_VERSION_HEADER,
      });
      t.equal(response.status, 200, 'HTTP status (with stop_sequences)');

      const text = textOf(response.json);
      t.ok(
        !text.includes(STOP_SEQUENCE),
        'the stop sequence is excluded from the content',
        `text without ${JSON.stringify(STOP_SEQUENCE)}`,
        text,
      );

      const controlText = textOf(control.json);
      const cutExactlyAtStop =
        controlText.startsWith(text) && controlText.slice(text.length).startsWith(STOP_SEQUENCE);

      if (!cutExactlyAtStop) {
        t.inconclusive(
          'the unconstrained answer did not continue with the stop text, so the stop_sequence path was not proven to fire',
        );
        return;
      }

      t.equal(response.json?.stop_reason, 'stop_sequence', 'stop_reason');
      t.equal(response.json?.stop_sequence, STOP_SEQUENCE, 'stop_sequence');
    },
  },
  {
    name: 'anthropic.messages.tool-use',
    surface: 'anthropic',
    endpoint: `POST ${MESSAGES_PATH}`,
    title: 'tool_choice=any forces a tool_use block whose input matches the declared schema',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(MESSAGES_PATH, {
        body: messagesBody(ctx, {
          messages: [{ role: 'user', content: WEATHER_TOOL_PROMPT }],
          tools: [
            {
              name: WEATHER_TOOL_NAME,
              description: 'Look up the current weather for a city.',
              input_schema: WEATHER_TOOL_SCHEMA,
            },
          ],
          tool_choice: { type: 'any' },
        }),
        headers: ANTHROPIC_VERSION_HEADER,
      });
      t.equal(response.status, 200, 'HTTP status');
      t.equal(response.json?.stop_reason, 'tool_use', 'stop_reason');

      const toolUse = (Array.isArray(response.json?.content) ? response.json.content : []).find(
        (block) => block?.type === 'tool_use',
      );
      if (
        !t.ok(
          toolUse !== undefined,
          'the content carries a tool_use block',
          'a tool_use block',
          (response.json?.content ?? []).map((block) => block?.type),
        )
      ) {
        return;
      }

      t.nonEmptyString(toolUse.id, 'tool_use.id');
      t.equal(toolUse.name, WEATHER_TOOL_NAME, 'tool_use.name');
      if (!t.plainObject(toolUse.input, 'tool_use.input')) {
        return;
      }

      const violations = validateAgainstSchema(
        toolUse.input,
        WEATHER_TOOL_SCHEMA,
        'tool_use.input',
      );
      t.ok(
        violations.length === 0,
        'tool_use.input matches the declared input_schema',
        'no schema violations',
        violations,
      );
    },
  },
  {
    name: 'anthropic.messages.stream',
    surface: 'anthropic',
    endpoint: `POST ${MESSAGES_PATH} (stream)`,
    title: 'the event sequence is well formed and its terminal stop_reason matches the unary path',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.sse(MESSAGES_PATH, {
        body: messagesBody(ctx, { stream: true }),
        headers: ANTHROPIC_VERSION_HEADER,
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

      const types = events.map((event) => event.json.type);
      t.equal(types[0], 'message_start', 'the first event');
      t.equal(types.at(-1), 'message_stop', 'the last event');
      for (const required of [
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
      ]) {
        t.ok(types.includes(required), `the stream contains ${required}`, required, types);
      }

      const start = events.find((event) => event.json.type === 'message_start')?.json.message;
      t.ok(
        typeof start?.id === 'string' && start.id.startsWith('msg_'),
        'message_start.message.id',
        'a string starting with msg_',
        start?.id,
      );
      t.equal(start?.role, 'assistant', 'message_start.message.role');
      t.positiveInteger(start?.usage?.input_tokens, 'message_start.message.usage.input_tokens');

      const streamed = events
        .filter((event) => event.json.type === 'content_block_delta')
        .map((event) => event.json.delta?.text ?? '')
        .join('');
      t.nonEmptyString(streamed, 'the concatenated text deltas');

      const messageDelta = events.find((event) => event.json.type === 'message_delta')?.json;
      t.equal(messageDelta?.delta?.stop_reason, 'end_turn', 'message_delta.delta.stop_reason');
      t.positiveInteger(messageDelta?.usage?.output_tokens, 'message_delta.usage.output_tokens');

      const natural = ctx.recall('anthropic.stop_reason.natural');
      if (natural !== undefined) {
        t.equal(
          messageDelta?.delta?.stop_reason,
          natural,
          'the streamed stop_reason matches the unary one',
        );
      }
    },
  },
  {
    name: 'anthropic.count-tokens',
    surface: 'anthropic',
    endpoint: `POST ${COUNT_TOKENS_PATH}`,
    title: 'token counts are non-zero and grow with the prompt',
    upstreamCalls: 2,
    async run(ctx, t) {
      const short = await ctx.json(COUNT_TOKENS_PATH, {
        body: {
          model: ctx.model,
          messages: [{ role: 'user', content: COUNT_TOKENS_SHORT }],
        },
        headers: ANTHROPIC_VERSION_HEADER,
      });
      t.equal(short.status, 200, 'HTTP status (short prompt)');
      t.positiveInteger(short.json?.input_tokens, 'input_tokens (short prompt)');

      const long = await ctx.json(COUNT_TOKENS_PATH, {
        body: {
          model: ctx.model,
          messages: [{ role: 'user', content: COUNT_TOKENS_LONG }],
        },
        headers: ANTHROPIC_VERSION_HEADER,
      });
      t.equal(long.status, 200, 'HTTP status (long prompt)');
      t.ok(
        Number.isInteger(long.json?.input_tokens) &&
          long.json.input_tokens > (short.json?.input_tokens ?? 0),
        'a longer prompt counts strictly more tokens',
        `> ${short.json?.input_tokens}`,
        long.json?.input_tokens,
      );
    },
  },
  {
    name: 'anthropic.rejects-missing-parameter',
    surface: 'anthropic',
    endpoint: `POST ${MESSAGES_PATH}`,
    title: 'a missing required parameter is rejected in the Anthropic error envelope',
    upstreamCalls: 0,
    async run(ctx, t) {
      const response = await ctx.json(MESSAGES_PATH, {
        body: { model: ctx.model, messages: [{ role: 'user', content: NATURAL_PROMPT }] },
        headers: ANTHROPIC_VERSION_HEADER,
        countsAsUpstreamCall: false,
      });
      t.equal(response.status, 400, 'HTTP status');
      t.equal(response.json?.type, 'error', 'type');
      t.equal(response.json?.error?.type, 'invalid_request_error', 'error.type');
      t.nonEmptyString(response.json?.error?.message, 'error.message');
      t.nonEmptyString(response.json?.request_id, 'request_id');
      t.ok(
        typeof response.json?.error?.message === 'string' &&
          response.json.error.message.includes('max_tokens'),
        'the message names the offending parameter',
        'a message mentioning max_tokens',
        response.json?.error?.message,
      );
    },
  },
  {
    name: 'anthropic.rejects-unknown-model',
    surface: 'anthropic',
    endpoint: `POST ${MESSAGES_PATH}`,
    title: 'a caller mistake is not typed as a server fault',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(MESSAGES_PATH, {
        body: messagesBody(ctx, { model: 'model-that-does-not-exist-conformance' }),
        headers: ANTHROPIC_VERSION_HEADER,
      });
      t.ok(
        response.status >= 400 && response.status < 500,
        'HTTP status is a client error',
        '4xx',
        response.status,
      );
      t.equal(response.json?.type, 'error', 'type');
      t.ok(
        !['api_error', 'overloaded_error'].includes(response.json?.error?.type),
        'a client error is not typed as a server error',
        'not api_error or overloaded_error',
        response.json?.error?.type,
      );
    },
  },
  {
    name: 'anthropic.web-search.citations',
    surface: 'anthropic',
    endpoint: `POST ${MESSAGES_PATH}`,
    title: 'every citation points at a URL present in the same response result list',
    upstreamCalls: 1,
    optional: true,
    async run(ctx, t) {
      const response = await ctx.json(MESSAGES_PATH, {
        body: messagesBody(ctx, {
          max_tokens: 512,
          messages: [
            {
              role: 'user',
              content: 'Search the web and summarise, with citations, what the Antigravity IDE is.',
            },
          ],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        }),
        headers: ANTHROPIC_VERSION_HEADER,
      });
      t.equal(response.status, 200, 'HTTP status');

      const blocks = Array.isArray(response.json?.content) ? response.json.content : [];
      const resultUrls = new Set(
        blocks
          .filter((block) => block?.type === 'web_search_tool_result')
          .flatMap((block) => (Array.isArray(block.content) ? block.content : []))
          .map((result) => result?.url)
          .filter((url) => typeof url === 'string'),
      );

      const citations = blocks.flatMap((block) =>
        Array.isArray(block?.citations) ? block.citations : [],
      );

      if (citations.length === 0) {
        t.inconclusive('the model answered without searching, so no citation could be checked');
        return;
      }

      t.ok(
        resultUrls.size > 0,
        'a web_search_tool_result block accompanies the citations',
        'at least one result URL',
        0,
      );

      const dangling = citations
        .map((citation) => citation?.url)
        .filter((url) => typeof url !== 'string' || !resultUrls.has(url));
      t.ok(
        dangling.length === 0,
        'every citation URL appears in the response result list',
        'no dangling citations',
        dangling,
      );
    },
  },
];
