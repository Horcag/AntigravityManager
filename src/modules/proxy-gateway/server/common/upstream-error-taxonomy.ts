/**
 * Turns an upstream failure into the error taxonomy of the surface that is
 * answering.
 *
 * The signal this reads is the upstream HTTP status, not the sentence the
 * provider wrote. A 4xx below 500 is the provider saying the *request* was
 * wrong; answering that with `type: "server_error"` is self-contradictory, and
 * SDKs read `type` to decide whether a retry can ever succeed — so a
 * mis-typed 400 makes clients retry a request that is permanently rejected.
 *
 * When the rejected thing is a generation control this proxy put on the wire,
 * the offending client parameter is recovered as well, so the answer has the
 * same shape the request-contract layer already produces for parameters it
 * rejects locally (`prediction`, `modalities`).
 */

/** OpenAI's error `type` values, chosen by status the way OpenAI documents them. */
export function resolveOpenAIErrorType(status: number): string {
  if (status === 401) {
    return 'authentication_error';
  }
  if (status === 403) {
    return 'permission_error';
  }
  if (status === 404) {
    return 'not_found_error';
  }
  if (status === 429) {
    return 'rate_limit_error';
  }
  if (status >= 400 && status < 500) {
    return 'invalid_request_error';
  }
  return 'server_error';
}

export interface UpstreamParameterRejection {
  /** The client-facing parameter the upstream rejected. */
  param: string;
  /** OpenAI's error `code` for that rejection. */
  code: 'unsupported_parameter' | 'invalid_value';
}

/**
 * The generation controls this proxy can put on the wire, paired with the
 * client parameter each one is built from.
 *
 * The provider names the control it refused ("Logprobs is not enabled for this
 * model", "Multiple candidates is not enabled for this model"), so the offending
 * client parameter is recovered by recognising that control — one rule per
 * control we are able to send — rather than by matching whole sentences.
 */
const GENERATION_CONTROLS: readonly { readonly names: RegExp; readonly param: string }[] = [
  { names: /\b(?:multiple\s+candidates|candidate[\s_]?count|candidates)\b/iu, param: 'n' },
  { names: /\b(?:response[\s_]?)?logprobs\b/iu, param: 'logprobs' },
  {
    names: /\bresponse[\s_]?(?:schema|mime[\s_]?type|format|modalities)\b/iu,
    param: 'response_format',
  },
  { names: /\bstop[\s_]?sequences?\b/iu, param: 'stop' },
  { names: /\bmax[\s_]?(?:output[\s_]?)?tokens\b/iu, param: 'max_tokens' },
  { names: /\bthinking(?:[\s_]?(?:config|budget|level))?\b/iu, param: 'thinking' },
  { names: /\bpresence[\s_]?penalty\b/iu, param: 'presence_penalty' },
  { names: /\bfrequency[\s_]?penalty\b/iu, param: 'frequency_penalty' },
  { names: /\btemperature\b/iu, param: 'temperature' },
  { names: /\btop[\s_]?p\b/iu, param: 'top_p' },
  { names: /\btop[\s_]?k\b/iu, param: 'top_k' },
  { names: /\bseed\b/iu, param: 'seed' },
  { names: /\b(?:function[\s_]?declarations|tool[\s_]?config|tools?)\b/iu, param: 'tools' },
  { names: /\bsafety[\s_]?settings\b/iu, param: 'model' },
];

/** "not enabled", "not supported", "unavailable" — the capability is absent, not the value wrong. */
const CAPABILITY_ABSENT =
  /\b(?:not\s+(?:enabled|supported|available|implemented)|unsupported|unavailable|disabled)\b/iu;

/**
 * Recognises an upstream rejection of a request parameter.
 *
 * Returns null for anything that is not a client-side status, and for a client
 * status naming no control we recognise — the caller still types those as
 * `invalid_request_error`, just without a `param`.
 */
export function classifyUpstreamParameterRejection(
  status: number | undefined,
  message: string,
): UpstreamParameterRejection | null {
  if (status === undefined || status < 400 || status >= 500) {
    return null;
  }

  const control = GENERATION_CONTROLS.find((candidate) => candidate.names.test(message));
  if (!control) {
    return null;
  }

  return {
    param: control.param,
    code: CAPABILITY_ABSENT.test(message) ? 'unsupported_parameter' : 'invalid_value',
  };
}
