/**
 * OpenAI surface of the fake proxy: a conforming reference implementation the
 * meaningfulness checker is expected to pass against, plus the switches that
 * reintroduce known defects.
 */

import {
  JSON_ANSWER,
  TINY_PNG_BASE64,
  TRUNCATION_THRESHOLD,
  countTokens,
  isKnownModel,
  jsonReply,
  resolveAnswer,
  sseData,
  sseReply,
  type FakeProxyReply,
  type FakeProxyRequest,
  type SseFrame,
  FAKE_PROXY_MODELS,
  WEATHER_TOOL_ARGUMENTS,
} from './fake-proxy-shared';

/** The request fields this surface reads; the body arrives as parsed JSON. */
interface ChatBody {
  model?: string;
  messages?: { role?: string; content?: string }[];
  max_tokens?: number;
  max_output_tokens?: number;
  input?: string;
  stop?: string[];
  store?: boolean;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: { function?: { name?: string } }[];
  tool_choice?: string;
  response_format?: { type?: string; json_schema?: unknown };
}

const CHAT_ID = 'chatcmpl-fake-conformance';
const RESPONSE_ID = 'resp_fake_conformance';
const CREATED = 1_900_000_000;

function lastUserMessage(body: ChatBody): string {
  const message = [...(body.messages ?? [])].reverse().find((entry) => entry.role === 'user');
  return message?.content ?? body.input ?? '';
}

function usage(promptText: string, completionText: string, mismatched: boolean) {
  const promptTokens = countTokens(promptText);
  const completionTokens = countTokens(completionText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: mismatched ? promptTokens : promptTokens + completionTokens,
  };
}

function modelNotFound(request: FakeProxyRequest, model: unknown): FakeProxyReply {
  return jsonReply(404, {
    error: {
      message: `model '${String(model)}' is not available`,
      type: request.defects.has('openai-client-error-typed-server-error')
        ? 'server_error'
        : 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  });
}

export function handleOpenAI(request: FakeProxyRequest): FakeProxyReply | undefined {
  if (request.method === 'GET' && request.path === '/v1/models') {
    return jsonReply(200, {
      object: 'list',
      data: FAKE_PROXY_MODELS.map((id) => ({
        id,
        object: 'model',
        created: 1_770_652_800,
        owned_by: 'antigravity',
      })),
    });
  }

  if (request.method === 'GET' && request.path.startsWith('/v1/chat/completions/')) {
    const completionId = decodeURIComponent(request.path.slice('/v1/chat/completions/'.length));
    const stored = request.storedChatCompletions.get(completionId);
    return stored
      ? jsonReply(200, stored)
      : jsonReply(404, {
          error: {
            message: `Chat completion with id '${completionId}' not found.`,
            type: 'invalid_request_error',
            param: 'id',
            code: 'chat_completion_not_found',
          },
        });
  }

  if (request.method !== 'POST') {
    return undefined;
  }

  // The body is JSON this fixture itself receives; narrowing it once here keeps
  // the per-endpoint code free of repeated casts.
  const body = request.body as ChatBody;

  switch (request.path) {
    case '/v1/chat/completions':
      return handleChatCompletions(request, body);
    case '/v1/responses':
      return handleResponses(request, body);
    case '/v1/images/generations':
      return jsonReply(200, {
        created: CREATED,
        data: [{ b64_json: TINY_PNG_BASE64 }],
      });
    default:
      return undefined;
  }
}

function handleChatCompletions(request: FakeProxyRequest, body: ChatBody): FakeProxyReply {
  if (body.store === true && body.stream === true) {
    return jsonReply(400, {
      error: {
        message:
          'store=true is unavailable for streamed Chat Completions because this proxy does not assemble stream chunks',
        type: 'invalid_request_error',
        param: 'store',
        code: 'unsupported_parameter',
      },
    });
  }

  if (!isKnownModel(body.model)) {
    return modelNotFound(request, body.model);
  }

  const prompt = lastUserMessage(body);
  const wantsJson = body.response_format?.type?.startsWith('json') ?? false;
  const wantsJsonSchema = Boolean(body.response_format?.json_schema);
  const truncated =
    (body.max_tokens ?? Number.MAX_SAFE_INTEGER) <= TRUNCATION_THRESHOLD ||
    (request.defects.has('openai-json-schema-truncated') && wantsJsonSchema);
  const { text } = resolveAnswer(prompt, {
    json: wantsJson,
    stopSequences: body.stop,
    truncated,
  });

  if (body.tool_choice === 'required') {
    return jsonReply(200, {
      id: CHAT_ID,
      object: 'chat.completion',
      created: CREATED,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_fake_1',
                type: 'function',
                function: {
                  name: body.tools?.[0]?.function?.name ?? 'get_weather',
                  arguments: JSON.stringify(WEATHER_TOOL_ARGUMENTS),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: usage(prompt, JSON.stringify(WEATHER_TOOL_ARGUMENTS), false),
    });
  }

  const content =
    wantsJson && request.defects.has('openai-json-object-fence')
      ? `\`\`\`json\n${JSON_ANSWER}\n\`\`\``
      : request.defects.has('openai-json-schema-truncated') && wantsJsonSchema
        ? '{"city":'
        : text;
  const finishReason = truncated ? 'length' : 'stop';
  const chatUsage = usage(prompt, content, request.defects.has('openai-usage-total-mismatch'));

  if (body.stream === true) {
    return streamChatCompletion(body, content, finishReason, chatUsage);
  }

  const completion = {
    id: CHAT_ID,
    object: 'chat.completion',
    created: CREATED,
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: chatUsage,
  };
  if (body.store === true) {
    request.storedChatCompletions.set(CHAT_ID, completion);
  }

  return jsonReply(200, completion);
}

function streamChatCompletion(
  body: ChatBody,
  content: string,
  finishReason: string,
  chatUsage: ReturnType<typeof usage>,
): FakeProxyReply {
  const base = {
    id: CHAT_ID,
    object: 'chat.completion.chunk',
    created: CREATED,
    model: body.model,
  };
  const frames: SseFrame[] = [
    sseData({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    }),
  ];

  for (const piece of content.match(/\S+\s*/gu) ?? [content]) {
    frames.push(
      sseData({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }),
    );
  }

  frames.push(
    sseData({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
  );

  if (body.stream_options?.include_usage) {
    frames.push(sseData({ ...base, choices: [], usage: chatUsage }));
  }

  frames.push({ data: '[DONE]' });
  return sseReply(frames);
}

function handleResponses(request: FakeProxyRequest, body: ChatBody): FakeProxyReply {
  if (!isKnownModel(body.model)) {
    return modelNotFound(request, body.model);
  }

  const prompt = lastUserMessage(body);
  const truncated = (body.max_output_tokens ?? Number.MAX_SAFE_INTEGER) <= TRUNCATION_THRESHOLD;
  const { text } = resolveAnswer(prompt, { truncated });
  const usageCounters = usage(prompt, text, false);
  const status = truncated ? 'incomplete' : 'completed';

  const completed = {
    id: RESPONSE_ID,
    object: 'response',
    created_at: CREATED,
    model: body.model,
    status,
    ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output: [
      {
        id: 'msg_fake_1',
        type: 'message',
        status,
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: usageCounters.prompt_tokens,
      output_tokens: usageCounters.completion_tokens,
      total_tokens: usageCounters.prompt_tokens + usageCounters.completion_tokens,
    },
  };

  if (body.stream !== true) {
    return jsonReply(200, completed);
  }

  const streamedText = request.defects.has('openai-responses-stream-drift')
    ? text.slice(0, Math.max(1, text.length - 5))
    : text;
  const frames: SseFrame[] = [
    sseData(
      { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
      'response.created',
    ),
  ];

  for (const piece of streamedText.match(/\S+\s*/gu) ?? [streamedText]) {
    frames.push(
      sseData(
        { type: 'response.output_text.delta', item_id: 'msg_fake_1', delta: piece },
        'response.output_text.delta',
      ),
    );
  }

  const terminalType = truncated ? 'response.incomplete' : 'response.completed';
  frames.push(sseData({ type: terminalType, response: completed }, terminalType));
  return sseReply(frames);
}
