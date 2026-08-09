/**
 * Gemini-surface meaningfulness checks.
 *
 * The systemInstruction check is deliberately a token-count comparison rather
 * than a judgement about the answer's wording: a forwarded instruction must
 * move `promptTokenCount`, and that is a property a correct implementation
 * cannot fail, whereas "did the model obey" is a property it can.
 */

import {
  CITY_JSON_PROMPT,
  CITY_SCHEMA,
  COUNT_TOKENS_LONG,
  COUNT_TOKENS_SHORT,
  HEAVY_SYSTEM_INSTRUCTION,
  LONG_PROMPT,
  NATURAL_PROMPT,
  STOP_PROMPT,
  STOP_SEQUENCE,
  WEATHER_TOOL_NAME,
  WEATHER_TOOL_PROMPT,
  WEATHER_TOOL_SCHEMA,
  SCHEMA_MAX_OUTPUT_TOKENS,
  parseModelJson,
} from './fixtures.mjs';
import { validateAgainstSchema } from './schema.mjs';

function generatePath(ctx, action, query = '') {
  return `/v1beta/models/${encodeURIComponent(ctx.model)}:${action}${query}`;
}

function userContents(text) {
  return [{ role: 'user', parts: [{ text }] }];
}

function textOf(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  return (Array.isArray(parts) ? parts : [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

function assertCandidateEnvelope(t, body) {
  if (!t.nonEmptyArray(body?.candidates, 'candidates')) {
    return;
  }

  const candidate = body.candidates[0];
  t.equal(candidate?.index ?? 0, 0, 'candidates[0].index');
  t.equal(candidate?.content?.role, 'model', 'candidates[0].content.role');
  t.nonEmptyArray(candidate?.content?.parts, 'candidates[0].content.parts');
  t.nonEmptyString(body?.modelVersion, 'modelVersion');
}

/**
 * Gemini reports the components separately and the total once; a total that is
 * not the sum of the parts it reported is a mapper bug, not a provider detail.
 */
function assertUsageMetadata(t, usage) {
  if (!t.plainObject(usage, 'usageMetadata')) {
    return;
  }

  t.positiveInteger(usage.promptTokenCount, 'usageMetadata.promptTokenCount');
  t.positiveInteger(usage.candidatesTokenCount, 'usageMetadata.candidatesTokenCount');
  t.positiveInteger(usage.totalTokenCount, 'usageMetadata.totalTokenCount');

  const components =
    (usage.promptTokenCount ?? 0) +
    (usage.candidatesTokenCount ?? 0) +
    (usage.thoughtsTokenCount ?? 0) +
    (usage.toolUsePromptTokenCount ?? 0);
  t.equal(
    usage.totalTokenCount,
    components,
    'usageMetadata.totalTokenCount === the sum of its parts',
  );
}

function assertGeminiError(t, body, status) {
  if (!t.plainObject(body?.error, 'error')) {
    return;
  }

  t.equal(body.error.code, status, 'error.code mirrors the HTTP status');
  t.nonEmptyString(body.error.message, 'error.message');
  t.nonEmptyString(body.error.status, 'error.status');
  t.ok(
    typeof body.error.status === 'string' && /^[A-Z][A-Z_]*$/u.test(body.error.status),
    'error.status is a canonical google.rpc.Code name',
    'SCREAMING_SNAKE_CASE',
    body.error.status,
  );
}

export const GEMINI_CHECKS = [
  {
    name: 'gemini.models.catalog',
    surface: 'gemini',
    endpoint: 'GET /v1beta/models',
    title: 'the model list is a real catalogue and contains the model under test',
    upstreamCalls: 0,
    async run(ctx, t) {
      const response = await ctx.json('/v1beta/models', { countsAsUpstreamCall: false });
      t.equal(response.status, 200, 'HTTP status');
      if (!t.nonEmptyArray(response.json?.models, 'models')) {
        return;
      }

      for (const [index, entry] of response.json.models.entries()) {
        t.ok(
          typeof entry?.name === 'string' && entry.name.startsWith('models/'),
          `models[${index}].name`,
          'a name prefixed with models/',
          entry?.name,
        );
        t.nonEmptyString(entry?.displayName, `models[${index}].displayName`);
        t.nonEmptyArray(
          entry?.supportedGenerationMethods,
          `models[${index}].supportedGenerationMethods`,
        );
      }

      t.ok(
        response.json.models.some((entry) => entry?.name === `models/${ctx.model}`),
        'the model under test is advertised',
        `models[] contains models/${ctx.model}`,
        response.json.models.map((entry) => entry?.name),
      );
    },
  },
  {
    name: 'gemini.generate.natural-stop',
    surface: 'gemini',
    endpoint: 'POST /v1beta/models/{model}:generateContent',
    title: 'an untruncated answer reports finishReason=STOP with consistent usage metadata',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(generatePath(ctx, 'generateContent'), {
        body: {
          contents: userContents(NATURAL_PROMPT),
          generationConfig: { maxOutputTokens: 256 },
        },
      });
      t.equal(response.status, 200, 'HTTP status');
      assertCandidateEnvelope(t, response.json);
      t.equal(response.json?.candidates?.[0]?.finishReason, 'STOP', 'candidates[0].finishReason');
      t.nonEmptyString(textOf(response.json), 'the concatenated text parts');
      assertUsageMetadata(t, response.json?.usageMetadata);

      ctx.record('gemini.finishReason.natural', response.json?.candidates?.[0]?.finishReason);
      ctx.record('gemini.promptTokenCount.plain', response.json?.usageMetadata?.promptTokenCount);
    },
  },
  {
    name: 'gemini.generate.max-tokens',
    surface: 'gemini',
    endpoint: 'POST /v1beta/models/{model}:generateContent',
    title: 'maxOutputTokens truncates and is reported as finishReason=MAX_TOKENS',
    upstreamCalls: 1,
    async run(ctx, t) {
      const cap = 16;
      const response = await ctx.json(generatePath(ctx, 'generateContent'), {
        body: {
          contents: userContents(LONG_PROMPT),
          generationConfig: { maxOutputTokens: cap },
        },
      });
      t.equal(response.status, 200, 'HTTP status');
      t.equal(
        response.json?.candidates?.[0]?.finishReason,
        'MAX_TOKENS',
        'candidates[0].finishReason',
      );

      const natural = ctx.recall('gemini.finishReason.natural');
      if (natural === undefined) {
        t.note('finishReason discrimination not cross-checked: the natural-stop check did not run');
      } else {
        t.ok(
          natural !== response.json?.candidates?.[0]?.finishReason,
          'truncated and natural answers report different finishReason values',
          `something other than ${natural}`,
          response.json?.candidates?.[0]?.finishReason,
        );
      }
    },
  },
  {
    name: 'gemini.generate.stop-sequence',
    surface: 'gemini',
    endpoint: 'POST /v1beta/models/{model}:generateContent',
    title: 'a stopSequence is applied and never appears in the text',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(generatePath(ctx, 'generateContent'), {
        body: {
          contents: userContents(STOP_PROMPT),
          generationConfig: { maxOutputTokens: 128, stopSequences: [STOP_SEQUENCE] },
        },
      });
      t.equal(response.status, 200, 'HTTP status');

      const text = textOf(response.json);
      t.ok(
        !text.includes(STOP_SEQUENCE),
        'the stop sequence is excluded from the text',
        `text without ${JSON.stringify(STOP_SEQUENCE)}`,
        text,
      );
      t.oneOf(
        response.json?.candidates?.[0]?.finishReason,
        ['STOP', 'MAX_TOKENS'],
        'candidates[0].finishReason',
      );
    },
  },
  {
    name: 'gemini.generate.system-instruction',
    surface: 'gemini',
    endpoint: 'POST /v1beta/models/{model}:generateContent',
    title: 'systemInstruction reaches the provider instead of being silently dropped',
    upstreamCalls: 2,
    async run(ctx, t) {
      const plain = await ctx.json(generatePath(ctx, 'generateContent'), {
        body: {
          contents: userContents(NATURAL_PROMPT),
          generationConfig: { maxOutputTokens: 64 },
        },
      });
      t.equal(plain.status, 200, 'HTTP status (without systemInstruction)');

      const instructed = await ctx.json(generatePath(ctx, 'generateContent'), {
        body: {
          contents: userContents(NATURAL_PROMPT),
          systemInstruction: { parts: [{ text: HEAVY_SYSTEM_INSTRUCTION }] },
          generationConfig: { maxOutputTokens: 64 },
        },
      });
      t.equal(instructed.status, 200, 'HTTP status (with systemInstruction)');

      const without = plain.json?.usageMetadata?.promptTokenCount;
      const with_ = instructed.json?.usageMetadata?.promptTokenCount;
      t.ok(
        Number.isInteger(without) && Number.isInteger(with_) && with_ > without,
        'a forwarded systemInstruction increases promptTokenCount',
        `> ${without}`,
        with_,
      );
    },
  },
  {
    name: 'gemini.generate.function-call',
    surface: 'gemini',
    endpoint: 'POST /v1beta/models/{model}:generateContent',
    title: 'functionCallingConfig=ANY forces a call whose args match the declaration',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(generatePath(ctx, 'generateContent'), {
        body: {
          contents: userContents(WEATHER_TOOL_PROMPT),
          tools: [
            {
              functionDeclarations: [
                {
                  name: WEATHER_TOOL_NAME,
                  description: 'Look up the current weather for a city.',
                  parameters: WEATHER_TOOL_SCHEMA,
                },
              ],
            },
          ],
          toolConfig: { functionCallingConfig: { mode: 'ANY' } },
          generationConfig: { maxOutputTokens: 256 },
        },
      });
      t.equal(response.status, 200, 'HTTP status');

      const parts = response.json?.candidates?.[0]?.content?.parts ?? [];
      const call = parts.find((part) => part?.functionCall)?.functionCall;
      if (
        !t.ok(
          call !== undefined,
          'a functionCall part is returned',
          'a part carrying functionCall',
          parts,
        )
      ) {
        return;
      }

      t.equal(call.name, WEATHER_TOOL_NAME, 'functionCall.name');
      if (!t.plainObject(call.args, 'functionCall.args')) {
        return;
      }

      const violations = validateAgainstSchema(call.args, WEATHER_TOOL_SCHEMA, 'functionCall.args');
      t.ok(
        violations.length === 0,
        'functionCall.args matches the declared parameters schema',
        'no schema violations',
        violations,
      );
    },
  },
  {
    name: 'gemini.generate.json-schema',
    surface: 'gemini',
    endpoint: 'POST /v1beta/models/{model}:generateContent',
    title: 'responseSchema output parses and satisfies the schema that was sent',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(generatePath(ctx, 'generateContent'), {
        body: {
          contents: userContents(CITY_JSON_PROMPT),
          generationConfig: {
            maxOutputTokens: SCHEMA_MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
            responseSchema: CITY_SCHEMA,
          },
        },
      });
      t.equal(response.status, 200, 'HTTP status');

      const parsed = parseModelJson(textOf(response.json));
      const finishReason = response.json?.candidates?.[0]?.finishReason;
      const usage = response.json?.usageMetadata;
      if (parsed.error) {
        if (finishReason === 'MAX_TOKENS') {
          t.inconclusive(
            `responseSchema text was truncated: finishReason=MAX_TOKENS, ` +
              `usageMetadata.candidatesTokenCount=${String(usage?.candidatesTokenCount ?? 'unknown')}`,
          );
          return;
        }

        t.ok(false, 'the response text parses as JSON', 'valid JSON', parsed.error);
        return;
      }

      const violations = validateAgainstSchema(parsed.value, CITY_SCHEMA, 'response');
      t.ok(
        violations.length === 0,
        'the response satisfies the responseSchema that was sent',
        'no schema violations',
        violations,
      );
    },
  },
  {
    name: 'gemini.stream',
    surface: 'gemini',
    endpoint: 'POST /v1beta/models/{model}:streamGenerateContent?alt=sse',
    title: 'streamed chunks carry text, a terminal finishReason and usage metadata',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.sse(generatePath(ctx, 'streamGenerateContent', '?alt=sse'), {
        body: {
          contents: userContents(NATURAL_PROMPT),
          generationConfig: { maxOutputTokens: 256 },
        },
      });
      t.equal(response.status, 200, 'HTTP status');
      t.ok(
        response.contentType.includes('text/event-stream'),
        'content-type',
        'text/event-stream',
        response.contentType,
      );

      const chunks = response.events.filter((event) => event.json !== undefined);
      if (!t.nonEmptyArray(chunks, 'parsed stream chunks')) {
        return;
      }

      t.ok(
        chunks.every((chunk) => Array.isArray(chunk.json.candidates)),
        'every chunk carries a candidates array',
        'candidates[] on every chunk',
        chunks.map((chunk) => Object.keys(chunk.json)),
      );

      const streamed = chunks.map((chunk) => textOf(chunk.json)).join('');
      t.nonEmptyString(streamed, 'the concatenated text parts');

      const finishReasons = chunks
        .flatMap((chunk) => chunk.json.candidates ?? [])
        .map((candidate) => candidate.finishReason)
        .filter((reason) => reason !== undefined && reason !== null);
      t.equal(finishReasons.length, 1, 'exactly one chunk carries a finishReason');
      const natural = ctx.recall('gemini.finishReason.natural');
      const expectedFinishReason = natural ?? 'STOP';
      t.equal(finishReasons[0], expectedFinishReason, 'the terminal finishReason');
      if (natural !== undefined) {
        t.equal(finishReasons[0], natural, 'the streamed finishReason matches the unary one');
      }

      const lastUsage = chunks
        .map((chunk) => chunk.json.usageMetadata)
        .filter(Boolean)
        .at(-1);
      if (
        t.ok(
          lastUsage !== undefined,
          'the stream reports usageMetadata',
          'usageMetadata on a chunk',
          'none',
        )
      ) {
        assertUsageMetadata(t.at('POST /v1beta/models/{model}:streamGenerateContent'), lastUsage);
      }
    },
  },
  {
    name: 'gemini.count-tokens',
    surface: 'gemini',
    endpoint: 'POST /v1beta/models/{model}:countTokens',
    title: 'token counts are non-zero and grow with the prompt',
    upstreamCalls: 2,
    async run(ctx, t) {
      const short = await ctx.json(generatePath(ctx, 'countTokens'), {
        body: { contents: userContents(COUNT_TOKENS_SHORT) },
      });
      t.equal(short.status, 200, 'HTTP status (short prompt)');
      t.positiveInteger(short.json?.totalTokens, 'totalTokens (short prompt)');

      const long = await ctx.json(generatePath(ctx, 'countTokens'), {
        body: { contents: userContents(COUNT_TOKENS_LONG) },
      });
      t.equal(long.status, 200, 'HTTP status (long prompt)');
      t.ok(
        Number.isInteger(long.json?.totalTokens) &&
          long.json.totalTokens > (short.json?.totalTokens ?? 0),
        'a longer prompt counts strictly more tokens',
        `> ${short.json?.totalTokens}`,
        long.json?.totalTokens,
      );
    },
  },
  {
    name: 'gemini.rejects-unknown-model',
    surface: 'gemini',
    endpoint: 'POST /v1beta/models/{model}:generateContent',
    title: 'a caller mistake is rejected in the google.rpc error envelope, not as INTERNAL',
    upstreamCalls: 1,
    async run(ctx, t) {
      const response = await ctx.json(
        '/v1beta/models/model-that-does-not-exist-conformance:generateContent',
        { body: { contents: userContents(NATURAL_PROMPT) } },
      );
      t.ok(
        response.status >= 400 && response.status < 500,
        'HTTP status is a client error',
        '4xx',
        response.status,
      );
      assertGeminiError(t, response.json, response.status);
      t.ok(
        !['INTERNAL', 'UNKNOWN'].includes(response.json?.error?.status),
        'a client error is not typed as a server fault',
        'not INTERNAL or UNKNOWN',
        response.json?.error?.status,
      );
    },
  },
];
