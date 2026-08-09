/**
 * Anthropic surface of the fake proxy.
 *
 * The stop semantics are modelled faithfully — `stop_reason` and
 * `stop_sequence` move together — so the defect switches can break exactly one
 * of them and prove the checker notices.
 */

import {
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
  WEATHER_TOOL_ARGUMENTS,
} from './fake-proxy-shared';

interface MessagesBody {
  model?: string;
  max_tokens?: number;
  messages?: { role?: string; content?: string }[];
  stop_sequences?: string[];
  stream?: boolean;
  tools?: { name?: string; type?: string }[];
  tool_choice?: { type?: string };
}

const MESSAGE_ID = 'msg_fake_conformance';
const REQUEST_ID = 'req_fakeconformance0001';
const SEARCH_URL = 'https://example.invalid/antigravity-ide';

type ContentBlock = Record<string, unknown>;

function lastUserMessage(body: MessagesBody): string {
  return [...(body.messages ?? [])].reverse().find((entry) => entry.role === 'user')?.content ?? '';
}

function errorReply(status: number, type: string, message: string): FakeProxyReply {
  return jsonReply(
    status,
    { type: 'error', error: { type, message }, request_id: REQUEST_ID },
    { 'request-id': REQUEST_ID },
  );
}

export function handleAnthropic(request: FakeProxyRequest): FakeProxyReply | undefined {
  if (request.method !== 'POST') {
    return undefined;
  }

  const body = request.body as MessagesBody;

  if (request.path === '/v1/messages/count_tokens') {
    if (!isKnownModel(body.model)) {
      return errorReply(404, 'not_found_error', `model '${String(body.model)}' is not available`);
    }
    return jsonReply(200, { input_tokens: countTokens(lastUserMessage(body)) });
  }

  if (request.path !== '/v1/messages') {
    return undefined;
  }

  if (body.max_tokens === undefined) {
    return errorReply(400, 'invalid_request_error', 'max_tokens is a required parameter');
  }

  if (!isKnownModel(body.model)) {
    return errorReply(404, 'not_found_error', `model '${String(body.model)}' is not available`);
  }

  const prompt = lastUserMessage(body);
  const truncated = body.max_tokens <= TRUNCATION_THRESHOLD;
  const { text, firedStopSequence } = resolveAnswer(prompt, {
    stopSequences: body.stop_sequences,
    truncated,
  });

  if (body.tool_choice?.type === 'any') {
    return jsonReply(200, {
      id: MESSAGE_ID,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [
        {
          type: 'tool_use',
          id: 'toolu_fake_1',
          name: body.tools?.[0]?.name ?? 'get_weather',
          input: WEATHER_TOOL_ARGUMENTS,
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: countTokens(prompt), output_tokens: 12 },
    });
  }

  if (body.tools?.some((tool) => tool.type === 'web_search_20250305')) {
    return jsonReply(200, {
      id: MESSAGE_ID,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: webSearchBlocks(),
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: countTokens(prompt), output_tokens: 24 },
    });
  }

  const stopReason = resolveStopReason(request, truncated, firedStopSequence);
  const content: ContentBlock[] = [{ type: 'text', text }];
  if (request.defects.has('anthropic-empty-thinking-block')) {
    content.unshift({ type: 'thinking', thinking: '', signature: '' });
  }

  const outputTokens = truncated ? (body.max_tokens ?? 1) : countTokens(text);

  if (body.stream === true) {
    return streamMessage(body, text, stopReason, countTokens(prompt), outputTokens);
  }

  return jsonReply(200, {
    id: MESSAGE_ID,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: stopReason.reason,
    stop_sequence: stopReason.sequence,
    usage: { input_tokens: countTokens(prompt), output_tokens: outputTokens },
  });
}

function resolveStopReason(
  request: FakeProxyRequest,
  truncated: boolean,
  firedStopSequence: string | undefined,
): { reason: string; sequence: string | null } {
  if (truncated) {
    return { reason: 'max_tokens', sequence: null };
  }

  if (firedStopSequence === undefined) {
    return { reason: 'end_turn', sequence: null };
  }

  return request.defects.has('anthropic-stop-sequence-as-end-turn')
    ? { reason: 'end_turn', sequence: null }
    : { reason: 'stop_sequence', sequence: firedStopSequence };
}

function streamMessage(
  body: MessagesBody,
  text: string,
  stopReason: { reason: string; sequence: string | null },
  inputTokens: number,
  outputTokens: number,
): FakeProxyReply {
  const frames: SseFrame[] = [
    sseData(
      {
        type: 'message_start',
        message: {
          id: MESSAGE_ID,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      },
      'message_start',
    ),
    sseData(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'content_block_start',
    ),
  ];

  for (const piece of text.match(/\S+\s*/gu) ?? [text]) {
    frames.push(
      sseData(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
        'content_block_delta',
      ),
    );
  }

  frames.push(
    sseData({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
    sseData(
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason.reason, stop_sequence: stopReason.sequence },
        usage: { output_tokens: outputTokens },
      },
      'message_delta',
    ),
    sseData({ type: 'message_stop' }, 'message_stop'),
  );

  return sseReply(frames);
}

function webSearchBlocks(): ContentBlock[] {
  return [
    {
      type: 'server_tool_use',
      id: 'srvtoolu_fake_1',
      name: 'web_search',
      input: { query: 'Antigravity IDE' },
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_fake_1',
      content: [{ type: 'web_search_result', url: SEARCH_URL, title: 'Antigravity IDE' }],
    },
    {
      type: 'text',
      text: 'Antigravity is an IDE.',
      citations: [
        {
          type: 'web_search_result_location',
          url: SEARCH_URL,
          title: 'Antigravity IDE',
          cited_text: 'Antigravity is an IDE.',
        },
      ],
    },
  ];
}
