import { isObjectLike, isString } from 'lodash-es';

/**
 * The `v1internal` response envelope is `{response, traceId, consumedCredits, remainingCredits}`.
 * Unwrapping it to the bare Gemini response threw the other three away; this module keeps them and
 * carries them alongside the response object without polluting the wire payload.
 */

/** The only credit type this proxy ever enables (`enabledCreditTypes: ['GOOGLE_ONE_AI']`). */
export const GOOGLE_ONE_AI_CREDIT_TYPE = 'GOOGLE_ONE_AI';

const MAX_CREDIT_ENTRIES = 8;
const MAX_TRACE_ID_LENGTH = 128;

export interface UpstreamCredit {
  creditType?: string;
  /** int64 rendered as a string in proto3 JSON. */
  creditAmount?: string;
}

export interface UpstreamResponseMetadata {
  traceId?: string;
  consumedCredits?: UpstreamCredit[];
  remainingCredits?: UpstreamCredit[];
}

const UPSTREAM_RESPONSE_METADATA = Symbol('proxy-upstream-response-metadata');

type UpstreamResponseMetadataCarrier = object & {
  [UPSTREAM_RESPONSE_METADATA]?: Readonly<UpstreamResponseMetadata>;
};

function parseTraceId(value: unknown): string | undefined {
  if (!isString(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TRACE_ID_LENGTH) {
    return undefined;
  }
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : undefined;
}

function parseCredits(value: unknown): UpstreamCredit[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const credits = value.slice(0, MAX_CREDIT_ENTRIES).flatMap((entry): UpstreamCredit[] => {
    if (!isObjectLike(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const creditType = isString(record.creditType) ? record.creditType : undefined;
    const creditAmount = isString(record.creditAmount)
      ? record.creditAmount
      : typeof record.creditAmount === 'number'
        ? String(record.creditAmount)
        : undefined;
    return creditType === undefined && creditAmount === undefined
      ? []
      : [{ creditType, creditAmount }];
  });
  return credits.length > 0 ? credits : undefined;
}

/**
 * Reads the envelope fields off a raw upstream payload. Returns `undefined` when none are present,
 * so callers can skip the carrier entirely for the common case.
 */
export function parseUpstreamResponseMetadata(
  payload: unknown,
): UpstreamResponseMetadata | undefined {
  if (!isObjectLike(payload)) {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const metadata: UpstreamResponseMetadata = {
    traceId: parseTraceId(record.traceId),
    consumedCredits: parseCredits(record.consumedCredits),
    remainingCredits: parseCredits(record.remainingCredits),
  };

  const hasAnyField =
    metadata.traceId !== undefined ||
    metadata.consumedCredits !== undefined ||
    metadata.remainingCredits !== undefined;
  return hasAnyField ? metadata : undefined;
}

export function attachUpstreamResponseMetadata<T extends object>(
  value: T,
  metadata: UpstreamResponseMetadata,
): T {
  Object.defineProperty(value, UPSTREAM_RESPONSE_METADATA, {
    configurable: true,
    value: Object.freeze({ ...metadata }),
  });
  return value;
}

export function getUpstreamResponseMetadata(
  value: unknown,
): Readonly<UpstreamResponseMetadata> | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined;
  }
  return (value as UpstreamResponseMetadataCarrier)[UPSTREAM_RESPONSE_METADATA];
}

/**
 * Sums the `GOOGLE_ONE_AI` entries, matching how gemini-cli reads the same fields. Returns `null`
 * when the list carries no usable amount, so a missing balance is never mistaken for zero.
 */
export function sumGoogleOneAiCredits(credits: UpstreamCredit[] | undefined): number | null {
  if (!credits || credits.length === 0) {
    return null;
  }

  let total = 0;
  let matched = false;
  for (const credit of credits) {
    if (credit.creditType !== GOOGLE_ONE_AI_CREDIT_TYPE || credit.creditAmount === undefined) {
      continue;
    }
    const parsed = Number.parseInt(credit.creditAmount, 10);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    total += parsed;
    matched = true;
  }

  return matched ? total : null;
}

/**
 * `traceId` is what Google support asks for when correlating a request, so it goes out as a header
 * rather than into the response body (which must stay wire-compatible with the Gemini API).
 */
export function createUpstreamResponseHeaders(
  metadata: Readonly<UpstreamResponseMetadata> | undefined,
): Record<string, string> {
  return metadata?.traceId ? { 'x-antigravity-trace-id': metadata.traceId } : {};
}
