/**
 * Shared vocabulary for the fake proxy the meaningfulness checker is tested
 * against.
 *
 * The fake is deliberately *correct* by default: the checker must pass against
 * a conforming server, or a green run would mean nothing. Each entry in
 * {@link FAKE_PROXY_DEFECTS} reintroduces one real defect class — the ones
 * kanban #50 fixed — so a test can prove the checker reports it instead of
 * passing silently.
 */

/** One deliberately wrong behaviour the fake proxy can be asked to exhibit. */
export type FakeProxyDefect =
  /** `json_object` content comes back wrapped in a markdown fence. */
  | 'openai-json-object-fence'
  /** The json_schema content is truncated before it can be completed. */
  | 'openai-json-schema-truncated'
  /** `usage.total_tokens` is not the sum of its parts. */
  | 'openai-usage-total-mismatch'
  /** The Responses stream deltas do not add up to the completed response. */
  | 'openai-responses-stream-drift'
  /** A caller mistake is typed as a server fault, so SDKs retry it. */
  | 'openai-client-error-typed-server-error'
  /** A fired stop sequence is reported as a natural ending. */
  | 'anthropic-stop-sequence-as-end-turn'
  /** An empty `thinking` block is appended to the content. */
  | 'anthropic-empty-thinking-block'
  /** A truncated answer claims it ended naturally. */
  | 'gemini-max-tokens-as-stop'
  /** A tool call's arguments contradict the schema that was declared. */
  | 'gemini-tool-args-violate-schema';

export const FAKE_PROXY_DEFECTS: readonly FakeProxyDefect[] = [
  'openai-json-object-fence',
  'openai-json-schema-truncated',
  'openai-usage-total-mismatch',
  'openai-responses-stream-drift',
  'openai-client-error-typed-server-error',
  'anthropic-stop-sequence-as-end-turn',
  'anthropic-empty-thinking-block',
  'gemini-max-tokens-as-stop',
  'gemini-tool-args-violate-schema',
];

export const FAKE_PROXY_MODEL = 'gemini-3-flash';

export const FAKE_PROXY_MODELS = [FAKE_PROXY_MODEL, 'gemini-3.1-flash-image'];

/** Below this, the fake treats a token budget as a truncation request. */
export const TRUNCATION_THRESHOLD = 32;

export const NATURAL_ANSWER = 'Blue is a primary colour.';

export const LIST_ANSWER = 'alpha bravo charlie delta echo foxtrot';

export const LONG_ANSWER = Array.from(
  { length: 40 },
  (_unused, index) => `${index + 1}. a prime, because it has exactly two divisors`,
).join('\n');

export const JSON_ANSWER = '{"city":"Paris","population":2100000}';

export const WEATHER_TOOL_ARGUMENTS = { city: 'Berlin', unit: 'celsius' };

/** The same object with a type the declared schema forbids. */
export const WEATHER_TOOL_ARGUMENTS_INVALID = { city: 42, unit: 'kelvin' };

export interface FakeProxyRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  defects: ReadonlySet<FakeProxyDefect>;
}

export interface FakeProxyReply {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

export function jsonReply(
  status: number,
  value: unknown,
  headers?: Record<string, string>,
): FakeProxyReply {
  return { status, contentType: 'application/json', body: JSON.stringify(value), headers };
}

export interface SseFrame {
  event?: string;
  data: string;
}

export function sseReply(frames: readonly SseFrame[]): FakeProxyReply {
  const body = frames
    .map((frame) => `${frame.event ? `event: ${frame.event}\n` : ''}data: ${frame.data}\n\n`)
    .join('');

  return { status: 200, contentType: 'text/event-stream', body };
}

export function sseData(payload: unknown, event?: string): SseFrame {
  return { event, data: JSON.stringify(payload) };
}

/** Word-count stand-in for a tokenizer: monotone in prompt length, which is all the checks assert. */
export function countTokens(text: string): number {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return Math.max(1, words.length);
}

export function isKnownModel(model: unknown): boolean {
  return typeof model === 'string' && FAKE_PROXY_MODELS.includes(model.replace(/^models\//u, ''));
}

/**
 * Picks the answer text from the prompt so every surface answers the same
 * question the same way, then applies the truncation and stop-sequence cuts a
 * real provider would apply.
 */
export function resolveAnswer(
  prompt: string,
  options: { json?: boolean; stopSequences?: readonly string[]; truncated?: boolean } = {},
): { text: string; firedStopSequence?: string } {
  let text = NATURAL_ANSWER;
  if (options.json) {
    text = JSON_ANSWER;
  } else if (prompt.includes('Repeat this list exactly')) {
    text = LIST_ANSWER;
  } else if (prompt.includes('forty prime numbers')) {
    text = LONG_ANSWER;
  }

  for (const stop of options.stopSequences ?? []) {
    const at = text.indexOf(stop);
    if (at >= 0) {
      return { text: text.slice(0, at), firedStopSequence: stop };
    }
  }

  if (options.truncated) {
    return { text: text.split(/\s+/u).slice(0, 8).join(' ') };
  }

  return { text };
}

/** A one-pixel PNG, so the image check has real bytes to decode. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
