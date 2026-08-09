/**
 * OpenAI Chat Completions-surface meaningfulness checks, plus the model
 * catalogue, the explicit-rejection contract and the image payload.
 *
 * Every assertion here is about the *content* of a 200: the vendor field names,
 * the semantics of `finish_reason`, and whether a parameter actually took
 * effect. The Responses API lives in `openai-responses-checks.mjs`.
 */

import {
  CITY_JSON_PROMPT,
  CITY_SCHEMA,
  SCHEMA_MAX_OUTPUT_TOKENS,
  LONG_PROMPT,
  NATURAL_PROMPT,
  STOP_PROMPT,
  STOP_SEQUENCE,
  WEATHER_TOOL_NAME,
  WEATHER_TOOL_PROMPT,
  WEATHER_TOOL_SCHEMA,
  identifyImageBytes,
  parseModelJson,
} from './fixtures.mjs';
import { validateAgainstSchema } from './schema.mjs';

const CHAT_PATH = '/v1/chat/completions';

function chatBody(ctx, overrides) {
  return {
    model: ctx.model,
    messages: [{ role: 'user', content: NATURAL_PROMPT }],
    ...overrides,
  };
}

function firstChoice(body) {
  return Array.isArray(body?.choices) ? body.choices[0] : undefined;
}

/** Shared shape assertions so every chat check states the same expectations. */
function assertChatEnvelope(t, body) {
  t.nonEmptyString(body?.id, 'id');
  t.equal(body?.object, 'chat.completion', 'object');
  t.positiveInteger(body?.created, 'created');
  t.nonEmptyString(body?.model, 'model');
  t.nonEmptyArray(body?.choices, 'choices');

  const choice = firstChoice(body);
  t.equal(choice?.index, 0, 'choices[0].index');
  t.equal(choice?.message?.role, 'assistant', 'choices[0].message.role');
}

/** `total` must be the sum the vendor documents, not an independent guess. */
function assertChatUsage(t, usage) {
  if (!t.plainObject(usage, 'usage')) {
    return;
  }

  t.positiveInteger(usage.prompt_tokens, 'usage.prompt_tokens');
  t.positiveInteger(usage.completion_tokens, 'usage.completion_tokens');
  t.positiveInteger(usage.total_tokens, 'usage.total_tokens');
  t.equal(
    usage.total_tokens,
    (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    'usage.total_tokens === prompt_tokens + completion_tokens',
  );
}

function assertErrorEnvelope(t, body, { expectedCode, expectedParam } = {}) {
  if (!t.plainObject(body?.error, 'error')) {
    return;
  }

  t.nonEmptyString(body.error.message, 'error.message');
  t.nonEmptyString(body.error.type, 'error.type');
  if (expectedCode !== undefined) {
    t.equal(body.error.code, expectedCode, 'error.code');
  }
  if (expectedParam !== undefined) {
    t.equal(body.error.param, expectedParam, 'error.param');
  }
}

async function multipartPart(ctx, path, bytes) {
  const form = new FormData();
  form.set('data', new Blob([bytes], { type: 'application/octet-stream' }), 'part.bin');
  const headers = ctx.headers();
  delete headers['content-type'];
  const response = await ctx.fetchImpl(`${ctx.baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(ctx.timeoutMs),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

function markTruncatedJsonFailure(t, parsed, finishReason, usage, endpointLabel) {
  if (!parsed.error) {
    return false;
  }

  if (finishReason === 'length') {
    const completionTokens = usage?.completion_tokens;
    t.inconclusive(
      `${endpointLabel} was truncated: finish_reason=length, ` +
        `usage.completion_tokens=${String(completionTokens ?? 'unknown')}`,
    );
    return true;
  }

  t.ok(false, `${endpointLabel} parses as JSON`, 'valid JSON', parsed.error);
  return true;
}

export const OPENAI_CHECKS = [
  {
    name: 'openai.uploads.round-trip',
    surface: 'openai',
    endpoint: 'POST /v1/uploads, POST /v1/uploads/{id}/parts, POST /v1/uploads/{id}/complete',
    title: 'two parts complete into a Files API handle with byte-identical content',
    upstreamCalls: 0,
    async run(ctx, t) {
      const source = Buffer.from('upload parts retain their requested order', 'utf8');
      const splitAt = 13;
      const first = source.subarray(0, splitAt);
      const second = source.subarray(splitAt);
      const created = await ctx.json('/v1/uploads', {
        body: {
          bytes: source.length,
          filename: 'meaningfulness-upload.txt',
          purpose: 'user_data',
          mime_type: 'text/plain',
        },
        countsAsUpstreamCall: false,
      });
      t.equal(created.status, 200, 'create HTTP status');
      t.nonEmptyString(created.json?.id, 'upload id');
      t.ok(
        /^upload_[0-9a-f]{32}$/u.test(created.json?.id ?? ''),
        'upload id prefix',
        'upload_…',
        created.json?.id,
      );
      t.equal(created.json?.status, 'pending', 'upload status');
      t.positiveInteger(created.json?.expires_at, 'upload expires_at');

      const secondPart = await multipartPart(ctx, `/v1/uploads/${created.json?.id}/parts`, second);
      const firstPart = await multipartPart(ctx, `/v1/uploads/${created.json?.id}/parts`, first);
      t.equal(secondPart.status, 200, 'second part HTTP status');
      t.equal(firstPart.status, 200, 'first part HTTP status');
      t.equal(secondPart.json?.object, 'upload.part', 'second part object');
      t.nonEmptyString(firstPart.json?.id, 'first part id');

      const completed = await ctx.json(`/v1/uploads/${created.json?.id}/complete`, {
        body: { part_ids: [firstPart.json?.id, secondPart.json?.id] },
        countsAsUpstreamCall: false,
      });
      t.equal(completed.status, 200, 'complete HTTP status');
      t.equal(completed.json?.object, 'file', 'completed object');
      t.equal(completed.json?.bytes, source.length, 'completed bytes');

      const contentResponse = await ctx.fetchImpl(
        `${ctx.baseUrl}/v1/files/${completed.json?.id}/content`,
        { headers: ctx.headers(), signal: AbortSignal.timeout(ctx.timeoutMs) },
      );
      const content = Buffer.from(await contentResponse.arrayBuffer());
      t.equal(contentResponse.status, 200, 'file content HTTP status');
      t.equal(content.equals(source), true, 'completed content matches source');

      const mismatched = await ctx.json('/v1/uploads', {
        body: {
          bytes: source.length + 1,
          filename: 'wrong-length.txt',
          purpose: 'user_data',
          mime_type: 'text/plain',
        },
        countsAsUpstreamCall: false,
      });
      const mismatchPart = await multipartPart(
        ctx,
        `/v1/uploads/${mismatched.json?.id}/parts`,
        source,
      );
      const rejected = await ctx.json(`/v1/uploads/${mismatched.json?.id}/complete`, {
        body: { part_ids: [mismatchPart.json?.id] },
        countsAsUpstreamCall: false,
      });
      t.equal(rejected.status, 400, 'wrong bytes HTTP status');
      assertErrorEnvelope(t, rejected.json, {
        expectedCode: 'byte_count_mismatch',
        expectedParam: 'bytes',
      });
    },
  },
  {
    name: 'openai.models.catalog',
    surface: 'openai',
    endpoint: `GET /v1/models`,
    title: 'the model list is a real catalogue and contains the model under test',
    upstreamCalls: 0,
    async run(ctx, t) {
      const response = await ctx.json('/v1/models', { countsAsUpstreamCall: false });
      t.equal(response.status, 200, 'HTTP status');
      const body = response.json;
      t.equal(body?.object, 'list', 'object');
      if (!t.nonEmptyArray(body?.data, 'data')) {
        return;
      }

      for (const [index, entry] of body.data.entries()) {
        t.nonEmptyString(entry?.id, `data[${index}].id`);
        t.equal(entry?.object, 'model', `data[${index}].object`);
        t.positiveInteger(entry?.created, `data[${index}].created`);
        t.nonEmptyString(entry?.owned_by, `data[${index}].owned_by`);
      }

      t.ok(
        body.data.some((entry) => entry?.id === ctx.model),
        `the model under test is advertised`,
        `data[] contains ${ctx.model}`,
        body.data.map((entry) => entry?.id),
      );
    },
  },
  {
    name: 'openai.chat.natural-stop',
    surface: 'openai',
    endpoint: `POST ${CHAT_PATH}`,
    title: 'an untruncated answer reports finish_reason=stop with consistent usage',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(CHAT_PATH, { body: chatBody(ctx, { max_tokens: 256 }) });
      t.equal(response.status, 200, 'HTTP status');
      assertChatEnvelope(t, response.json);

      const choice = firstChoice(response.json);
      t.nonEmptyString(choice?.message?.content, 'choices[0].message.content');
      t.equal(choice?.finish_reason, 'stop', 'choices[0].finish_reason');
      assertChatUsage(t, response.json?.usage);

      ctx.record('openai.finish_reason.natural', choice?.finish_reason);
    },
  },
  {
    name: 'openai.chat.max-tokens',
    surface: 'openai',
    endpoint: `POST ${CHAT_PATH}`,
    title: 'max_tokens truncates and is reported as finish_reason=length',
    upstreamCalls: 1,
    async run(ctx, t) {
      const cap = 16;
      const response = await ctx.json(CHAT_PATH, {
        body: chatBody(ctx, {
          messages: [{ role: 'user', content: LONG_PROMPT }],
          max_tokens: cap,
        }),
      });
      t.equal(response.status, 200, 'HTTP status');

      const choice = firstChoice(response.json);
      t.equal(choice?.finish_reason, 'length', 'choices[0].finish_reason');
      const completionTokens = response.json?.usage?.completion_tokens;
      t.ok(
        Number.isInteger(completionTokens) && completionTokens > 0 && completionTokens <= cap,
        'usage.completion_tokens respects max_tokens',
        `an integer in 1..${cap}`,
        completionTokens,
      );

      const natural = ctx.recall('openai.finish_reason.natural');
      if (natural === undefined) {
        t.note(
          'finish_reason discrimination not cross-checked: the natural-stop check did not run',
        );
      } else {
        t.ok(
          natural !== choice?.finish_reason,
          'truncated and natural answers report different finish_reason values',
          `something other than ${natural}`,
          choice?.finish_reason,
        );
      }
    },
  },
  {
    name: 'openai.chat.stop-sequence',
    surface: 'openai',
    endpoint: `POST ${CHAT_PATH}`,
    title: 'a stop sequence is applied and never appears in the content',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(CHAT_PATH, {
        body: chatBody(ctx, {
          messages: [{ role: 'user', content: STOP_PROMPT }],
          stop: [STOP_SEQUENCE],
          max_tokens: 128,
        }),
      });
      t.equal(response.status, 200, 'HTTP status');

      const choice = firstChoice(response.json);
      const content = choice?.message?.content ?? '';
      t.ok(
        !content.includes(STOP_SEQUENCE),
        'the stop sequence is excluded from the content',
        `content without ${JSON.stringify(STOP_SEQUENCE)}`,
        content,
      );
      t.oneOf(choice?.finish_reason, ['stop', 'length'], 'choices[0].finish_reason');

      if (content.length === 0) {
        t.inconclusive('the model produced no text before the stop sequence');
      }
    },
  },
  {
    name: 'openai.chat.tool-call',
    surface: 'openai',
    endpoint: `POST ${CHAT_PATH}`,
    title: 'tool_choice=required forces a call whose arguments parse and match the schema',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(CHAT_PATH, {
        body: chatBody(ctx, {
          messages: [{ role: 'user', content: WEATHER_TOOL_PROMPT }],
          tools: [
            {
              type: 'function',
              function: {
                name: WEATHER_TOOL_NAME,
                description: 'Look up the current weather for a city.',
                parameters: WEATHER_TOOL_SCHEMA,
              },
            },
          ],
          tool_choice: 'required',
          max_tokens: 256,
        }),
      });
      t.equal(response.status, 200, 'HTTP status');

      const choice = firstChoice(response.json);
      t.equal(choice?.finish_reason, 'tool_calls', 'choices[0].finish_reason');
      if (!t.nonEmptyArray(choice?.message?.tool_calls, 'choices[0].message.tool_calls')) {
        return;
      }

      const call = choice.message.tool_calls[0];
      t.nonEmptyString(call?.id, 'tool_calls[0].id');
      t.equal(call?.type, 'function', 'tool_calls[0].type');
      t.equal(call?.function?.name, WEATHER_TOOL_NAME, 'tool_calls[0].function.name');

      const parsed = parseModelJson(call?.function?.arguments);
      if (
        markTruncatedJsonFailure(
          t,
          parsed,
          choice?.finish_reason,
          response.json?.usage,
          'tool call arguments',
        )
      ) {
        return;
      }

      const violations = validateAgainstSchema(parsed.value, WEATHER_TOOL_SCHEMA, 'arguments');
      t.ok(
        violations.length === 0,
        'tool_calls[0].function.arguments matches the declared schema',
        'no schema violations',
        violations,
      );
    },
  },
  {
    name: 'openai.chat.json-object',
    surface: 'openai',
    endpoint: `POST ${CHAT_PATH}`,
    title: 'response_format=json_object returns content that parses as JSON',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(CHAT_PATH, {
        body: chatBody(ctx, {
          messages: [{ role: 'user', content: CITY_JSON_PROMPT }],
          response_format: { type: 'json_object' },
          max_tokens: SCHEMA_MAX_OUTPUT_TOKENS,
        }),
      });
      t.equal(response.status, 200, 'HTTP status');

      const content = firstChoice(response.json)?.message?.content;
      const parsed = parseModelJson(content);
      if (
        markTruncatedJsonFailure(
          t,
          parsed,
          firstChoice(response.json)?.finish_reason,
          response.json?.usage,
          'json_object content',
        )
      ) {
        return;
      }

      t.ok(!parsed.error, 'choices[0].message.content parses as JSON', 'valid JSON', parsed.error);
      if (!parsed.error) {
        t.plainObject(parsed.value, 'the parsed json_object content');
      }
    },
  },
  {
    name: 'openai.chat.json-schema',
    surface: 'openai',
    endpoint: `POST ${CHAT_PATH}`,
    title: 'response_format=json_schema returns content satisfying the schema that was sent',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(CHAT_PATH, {
        body: chatBody(ctx, {
          messages: [{ role: 'user', content: CITY_JSON_PROMPT }],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'city_population', strict: true, schema: CITY_SCHEMA },
          },
          max_tokens: SCHEMA_MAX_OUTPUT_TOKENS,
        }),
      });
      t.equal(response.status, 200, 'HTTP status');

      const content = firstChoice(response.json)?.message?.content;
      const parsed = parseModelJson(content);
      if (
        markTruncatedJsonFailure(
          t,
          parsed,
          firstChoice(response.json)?.finish_reason,
          response.json?.usage,
          'json_schema content',
        )
      ) {
        return;
      }

      const violations = validateAgainstSchema(parsed.value, CITY_SCHEMA, 'content');
      t.ok(
        violations.length === 0,
        'the content satisfies the json_schema that was sent',
        'no schema violations',
        violations,
      );
    },
  },
  {
    name: 'openai.chat.stream',
    surface: 'openai',
    endpoint: `POST ${CHAT_PATH} (stream)`,
    title: 'streamed chunks are well formed, terminate once, and carry the requested usage',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.sse(CHAT_PATH, {
        body: chatBody(ctx, {
          max_tokens: 256,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      t.equal(response.status, 200, 'HTTP status');
      t.ok(
        response.contentType.includes('text/event-stream'),
        'content-type',
        'text/event-stream',
        response.contentType,
      );

      const frames = response.events;
      t.ok(
        frames.at(-1)?.data === '[DONE]',
        'the stream terminates with [DONE]',
        'data: [DONE]',
        frames.at(-1)?.data,
      );

      const chunks = frames.filter((frame) => frame.json !== undefined);
      if (!t.nonEmptyArray(chunks, 'parsed stream chunks')) {
        return;
      }

      const badFrames = frames.filter((frame) => frame.parseError);
      t.ok(badFrames.length === 0, 'every data frame is JSON', 'no parse errors', badFrames);

      const ids = new Set(chunks.map((chunk) => chunk.json.id));
      t.equal(ids.size, 1, 'every chunk shares one id');
      t.ok(
        chunks.every((chunk) => chunk.json.object === 'chat.completion.chunk'),
        'every chunk is a chat.completion.chunk',
        'chat.completion.chunk',
        [...new Set(chunks.map((chunk) => chunk.json.object))],
      );

      const text = chunks.map((chunk) => chunk.json.choices?.[0]?.delta?.content ?? '').join('');
      t.nonEmptyString(text, 'the concatenated content deltas');

      const finishReasons = chunks
        .flatMap((chunk) => chunk.json.choices ?? [])
        .map((choice) => choice.finish_reason)
        .filter((reason) => reason !== null && reason !== undefined);
      t.equal(finishReasons.length, 1, 'exactly one chunk carries a finish_reason');
      const natural = ctx.recall('openai.finish_reason.natural');
      const expectedFinishReason = natural ?? 'stop';
      t.equal(finishReasons[0], expectedFinishReason, 'the terminal finish_reason');
      if (natural !== undefined) {
        t.equal(finishReasons[0], natural, 'the streamed finish_reason matches the unary one');
      }

      const usageChunk = chunks.find((chunk) => chunk.json.usage);
      if (
        !t.ok(
          usageChunk !== undefined,
          'a usage chunk arrives when include_usage was asked for',
          'a chunk carrying usage',
          'none',
        )
      ) {
        return;
      }

      assertChatUsage(t, usageChunk.json.usage);
      t.ok(
        Array.isArray(usageChunk.json.choices) && usageChunk.json.choices.length === 0,
        'the usage chunk carries an empty choices array',
        '[]',
        usageChunk.json.choices,
      );
    },
  },
  {
    name: 'openai.rejects-unsupported-parameter',
    surface: 'openai',
    endpoint: `POST ${CHAT_PATH}`,
    title: 'an unsupported parameter is rejected explicitly with param and code',
    upstreamCalls: 0,
    async run(ctx, t) {
      const response = await ctx.json(CHAT_PATH, {
        body: chatBody(ctx, { store: true }),
        countsAsUpstreamCall: false,
      });
      t.equal(response.status, 400, 'HTTP status');
      assertErrorEnvelope(t, response.json, {
        expectedCode: 'unsupported_parameter',
        expectedParam: 'store',
      });
      t.equal(response.json?.error?.type, 'invalid_request_error', 'error.type');
    },
  },
  {
    name: 'openai.rejects-unknown-model',
    surface: 'openai',
    endpoint: `POST ${CHAT_PATH}`,
    title: 'a caller mistake is not typed as a server fault',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(CHAT_PATH, {
        body: chatBody(ctx, { model: 'model-that-does-not-exist-conformance' }),
      });
      t.ok(
        response.status >= 400 && response.status < 500,
        'HTTP status is a client error',
        '4xx',
        response.status,
      );
      assertErrorEnvelope(t, response.json);
      t.ok(
        !['server_error', 'api_error'].includes(response.json?.error?.type),
        'a client error is not typed as a server error',
        'not server_error or api_error',
        response.json?.error?.type,
      );
    },
  },
  {
    name: 'openai.images.decodes',
    surface: 'openai',
    endpoint: 'POST /v1/images/generations',
    title: 'an image response decodes to real bytes',
    upstreamCalls: 1,
    optional: true,
    async run(ctx, t) {
      const response = await ctx.json('/v1/images/generations', {
        body: {
          ...(ctx.imageModel ? { model: ctx.imageModel } : {}),
          prompt: 'A plain flat blue square on a white background.',
          n: 1,
          response_format: 'b64_json',
        },
      });
      t.equal(response.status, 200, 'HTTP status');
      t.positiveInteger(response.json?.created, 'created');
      if (!t.nonEmptyArray(response.json?.data, 'data')) {
        return;
      }

      const identified = identifyImageBytes(response.json.data[0]?.b64_json);
      t.ok(
        identified.error === undefined,
        'data[0].b64_json decodes to a recognisable image',
        'PNG, JPEG, GIF or WEBP bytes',
        identified.error ?? identified,
      );
    },
  },
];
