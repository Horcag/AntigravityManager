/**
 * Assertion and transport primitives for the endpoint meaningfulness checker.
 *
 * The checker asks a different question from the route-coverage matrix: not
 * "did the route answer", but "is the answer true". Every helper here therefore
 * records *what was expected and what actually came back*, so a failure line is
 * enough to open a card without re-running anything.
 */

/** Terminal outcomes a single check can reach. */
export const CHECK_OUTCOMES = {
  passed: 'passed',
  failed: 'failed',
  inconclusive: 'inconclusive',
  error: 'error',
};

/**
 * Collects assertions for one check.
 *
 * Assertions do not throw: a check runs every assertion it can so one upstream
 * call reports every defect it exposed, not just the first.
 */
export class CheckAssertions {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.failures = [];
    this.notes = [];
    this.inconclusiveReasons = [];
  }

  /** Endpoint later assertions attribute their failures to. */
  at(endpoint) {
    this.endpoint = endpoint;
    return this;
  }

  note(message) {
    this.notes.push(message);
  }

  /**
   * Marks the check as unable to decide. Used where a correct implementation
   * can legitimately produce either answer — a model that never emits the stop
   * text, for instance — so the run stays honest instead of flaky.
   */
  inconclusive(reason) {
    this.inconclusiveReasons.push(reason);
  }

  ok(condition, what, expected, actual) {
    if (condition) {
      return true;
    }

    this.failures.push({
      endpoint: this.endpoint,
      what,
      expected: describeValue(expected),
      actual: describeValue(actual),
    });
    return false;
  }

  equal(actual, expected, what) {
    return this.ok(Object.is(actual, expected), what, expected, actual);
  }

  oneOf(actual, expected, what) {
    return this.ok([...expected].includes(actual), what, `one of ${expected.join(', ')}`, actual);
  }

  nonEmptyString(value, what) {
    return this.ok(
      typeof value === 'string' && value.trim().length > 0,
      what,
      'a non-empty string',
      value,
    );
  }

  positiveInteger(value, what) {
    return this.ok(Number.isInteger(value) && value > 0, what, 'a positive integer', value);
  }

  nonEmptyArray(value, what) {
    return this.ok(Array.isArray(value) && value.length > 0, what, 'a non-empty array', value);
  }

  plainObject(value, what) {
    return this.ok(
      typeof value === 'object' && value !== null && !Array.isArray(value),
      what,
      'an object',
      value,
    );
  }

  get outcome() {
    if (this.failures.length > 0) {
      return CHECK_OUTCOMES.failed;
    }

    return this.inconclusiveReasons.length > 0
      ? CHECK_OUTCOMES.inconclusive
      : CHECK_OUTCOMES.passed;
  }
}

/** Truncates and stringifies so a failure line stays readable in a terminal. */
export function describeValue(value, limit = 300) {
  if (typeof value === 'string') {
    return value.length > limit
      ? `${JSON.stringify(value.slice(0, limit))}…`
      : JSON.stringify(value);
  }

  let rendered;
  try {
    rendered = JSON.stringify(value);
  } catch {
    rendered = String(value);
  }

  if (rendered === undefined) {
    return String(value);
  }

  return rendered.length > limit ? `${rendered.slice(0, limit)}…` : rendered;
}

/**
 * Shared state for one run: transport settings, the upstream-call tally the
 * report prints, and a scratchpad checks use to compare against each other
 * (`stop` vs `length`, for example, must differ within a single run).
 */
export class CheckContext {
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.model = options.model;
    this.imageModel = options.imageModel;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.upstreamCalls = 0;
    this.observations = new Map();
  }

  record(key, value) {
    this.observations.set(key, value);
  }

  recall(key) {
    return this.observations.get(key);
  }

  headers(extra) {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}`, 'x-api-key': this.apiKey } : {}),
      ...extra,
    };
  }

  /** POST/GET returning parsed JSON plus the raw text a parse failure needs. */
  async json(path, init = {}) {
    const response = await this.send(path, init);
    const text = await response.text();
    let parsed;
    let parseError;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    return {
      status: response.status,
      headers: response.headers,
      contentType: response.headers.get('content-type') ?? '',
      text,
      json: parsed,
      parseError,
    };
  }

  /** POST returning parsed SSE events in wire order. */
  async sse(path, init = {}) {
    const response = await this.send(path, {
      ...init,
      headers: { accept: 'text/event-stream', ...(init.headers ?? {}) },
    });
    const text = await response.text();

    return {
      status: response.status,
      headers: response.headers,
      contentType: response.headers.get('content-type') ?? '',
      text,
      events: parseSseStream(text),
    };
  }

  /** Sends one multipart file without setting a JSON content type over its boundary. */
  async multipart(path, { fields, file }) {
    const body = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      body.append(name, value);
    }
    body.append(file.field, new Blob([file.bytes], { type: file.mimeType }), file.filename);

    this.upstreamCalls += 1;
    const { 'content-type': _contentType, ...headers } = this.headers();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let json;
    let parseError;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    return {
      status: response.status,
      headers: response.headers,
      contentType: response.headers.get('content-type') ?? '',
      text,
      json,
      parseError,
    };
  }

  async send(path, init) {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    if (init.countsAsUpstreamCall !== false) {
      this.upstreamCalls += 1;
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: this.headers(init.headers),
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

/**
 * Parses an SSE body into `{ event, data, json }` records.
 *
 * Written against the wire text rather than a client library on purpose: a
 * mapper that emits a malformed frame must surface here as a parse failure,
 * not be quietly repaired by a tolerant parser.
 */
export function parseSseStream(text) {
  const events = [];

  for (const rawFrame of text.split(/\r?\n\r?\n/u)) {
    const frame = rawFrame.trim();
    if (frame.length === 0) {
      continue;
    }

    let eventName;
    const dataLines = [];
    for (const line of frame.split(/\r?\n/u)) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /u, ''));
      }
    }

    if (dataLines.length === 0) {
      events.push({ event: eventName, data: undefined, json: undefined });
      continue;
    }

    const data = dataLines.join('\n');
    let json;
    let parseError;
    if (data !== '[DONE]') {
      try {
        json = JSON.parse(data);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }

    events.push({ event: eventName, data, json, parseError });
  }

  return events;
}
