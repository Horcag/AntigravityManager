import { isObjectLike, isNumber, isString, isNil } from 'lodash-es';
import { HttpStatus } from '@nestjs/common';
import type { GeminiResponse } from '../../common/interfaces/request-interfaces';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request-exception';
import {
  classifyForbiddenUpstreamError,
  describeForbiddenUpstreamClassification,
} from '../../common/google-error-details';

/**
 * Sanitizes a Gemini response by stripping top-level transport metadata fields
 * (`traceId`, `metadata`, `__cloudCodeMeta`) while preserving ALL candidate fields
 * (including candidate `metadata`, `traceId`, or future unknown keys)
 * and ensuring each candidate has a numeric `index`.
 */
export function sanitizeGeminiResponse(response: GeminiResponse): GeminiResponse {
  if (!isObjectLike(response)) {
    return response;
  }

  const cleanResponse = { ...(response as Record<string, unknown>) };
  delete cleanResponse.traceId;
  delete cleanResponse.metadata;
  delete cleanResponse.__cloudCodeMeta;

  if (Array.isArray(cleanResponse.candidates)) {
    cleanResponse.candidates = cleanResponse.candidates.map((candidate, index) => {
      if (!isObjectLike(candidate)) {
        return candidate;
      }
      const cleanCandidate = { ...(candidate as Record<string, unknown>) };
      if (!isNumber(cleanCandidate.index)) {
        cleanCandidate.index = index;
      }
      return cleanCandidate;
    });
  }

  return cleanResponse as GeminiResponse;
}

/**
 * Validates systemInstruction according to the confirmed text-only provider contract.
 *
 * Requirements:
 * - Must be an object with a `parts` array containing at least 1 element.
 * - Every part MUST contain a non-empty string `text`.
 * - MUST NOT contain unsupported non-text part fields (e.g. `inlineData`, `fileData`, `functionCall`, `functionResponse`).
 */
export function validateGeminiSystemInstruction(systemInstruction: unknown): {
  valid: boolean;
  message?: string;
} {
  if (isNil(systemInstruction)) {
    return { valid: true };
  }

  if (!isObjectLike(systemInstruction) || Array.isArray(systemInstruction)) {
    return {
      valid: false,
      message: 'systemInstruction must be an object with a parts array',
    };
  }

  const obj = systemInstruction as Record<string, unknown>;
  const parts = obj.parts;

  if (!Array.isArray(parts) || parts.length === 0) {
    return {
      valid: false,
      message: 'systemInstruction.parts must be a non-empty array',
    };
  }

  for (const part of parts) {
    if (!isObjectLike(part) || Array.isArray(part)) {
      return {
        valid: false,
        message: 'systemInstruction parts must be objects with text content',
      };
    }
    const partObj = part as Record<string, unknown>;
    if (!isString(partObj.text) || partObj.text.trim().length === 0) {
      return {
        valid: false,
        message: 'systemInstruction parts must contain a non-empty text string',
      };
    }
    if (
      'inlineData' in partObj ||
      'fileData' in partObj ||
      'functionCall' in partObj ||
      'functionResponse' in partObj
    ) {
      return {
        valid: false,
        message: 'systemInstruction contains non-text fields unsupported by this provider',
      };
    }
  }

  return { valid: true };
}

/**
 * Redacts sensitive credentials, emails, project identifiers, and tokens from error messages.
 */
export function sanitizeErrorMessage(rawMessage: string): string {
  if (!rawMessage || typeof rawMessage !== 'string') {
    return 'Upstream request failed';
  }

  let sanitized = rawMessage;

  // Redact Email addresses
  sanitized = sanitized.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    '[REDACTED_EMAIL]',
  );

  // Redact OAuth / Bearer tokens, including base64 and URL-safe punctuation.
  sanitized = sanitized.replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [REDACTED_TOKEN]');
  sanitized = sanitized.replace(/\bya29\.[^\s,;]+/gi, '[REDACTED_TOKEN]');

  // Redact credential headers, JSON fields, and query parameters.
  sanitized = sanitized.replace(
    /((?:[?&]|\b)["']?(?:auth|authorization|token|access_token|refresh_token|secret|api[_-]?key|key|account_id|accountid|project_id)["']?\s*[:=]\s*["']?)[^"'\s,;&}]+/gi,
    '$1[REDACTED]',
  );

  // Redact account resource names and common human-readable account identifiers.
  sanitized = sanitized.replace(/\baccounts?\/[a-zA-Z0-9_.-]+/gi, 'accounts/[REDACTED]');
  sanitized = sanitized.replace(
    /\b(account(?:[_ -]?id)?)\s*(?:[:=]\s*|\s+)[a-zA-Z0-9_.-]{3,}/gi,
    '$1 [REDACTED]',
  );

  // Redact Project IDs and Project numbers
  sanitized = sanitized.replace(/projects?\/[a-zA-Z0-9_-]+/gi, 'projects/[REDACTED]');
  sanitized = sanitized.replace(/projects?\s+[a-zA-Z0-9_-]+/gi, 'project [REDACTED]');

  // Truncate overly long error messages
  if (sanitized.length > 500) {
    sanitized = sanitized.substring(0, 500) + '... [truncated]';
  }

  return sanitized;
}

const GOOGLE_RPC_STATUSES = new Set([
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
]);

function normalizeGoogleRpcStatus(value: unknown): string | undefined {
  if (!isString(value)) {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  return GOOGLE_RPC_STATUSES.has(normalized) ? normalized : undefined;
}

/**
 * Converts HTTP status codes to standard Google RPC status strings.
 */
export function getGoogleStatusForHttpCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'INVALID_ARGUMENT';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'ALREADY_EXISTS';
    case 429:
      return 'RESOURCE_EXHAUSTED';
    case 499:
      return 'CANCELLED';
    case 501:
      return 'UNIMPLEMENTED';
    case 503:
      return 'UNAVAILABLE';
    case 504:
      return 'DEADLINE_EXCEEDED';
    default:
      return 'INTERNAL';
  }
}

/**
 * Validates and sanitizes a Retry-After header string.
 * Accepts only bounded positive integers (<= 86400 seconds) or valid HTTP dates, length <= 64, no newlines.
 */
export function sanitizeRetryAfterHeader(retryAfter?: string): string | undefined {
  if (!retryAfter || typeof retryAfter !== 'string') {
    return undefined;
  }
  const trimmed = retryAfter.trim();
  if (trimmed.length > 64 || /[\r\n]/.test(trimmed)) {
    return undefined;
  }

  // Integer seconds check
  if (/^\d{1,6}$/.test(trimmed)) {
    const val = parseInt(trimmed, 10);
    if (val >= 0 && val <= 86400) {
      return trimmed;
    }
    return undefined;
  }

  // HTTP Date check
  if (!isNaN(Date.parse(trimmed))) {
    return trimmed;
  }

  return undefined;
}

export interface SanitizedGoogleErrorResult {
  statusCode: number;
  googleStatus: string;
  message: string;
  retryAfter?: string;
  /** Set when a 403 is user-recoverable rather than a dead credential. */
  validationLink?: string;
  errorEnvelope: {
    error: {
      code: number;
      message: string;
      status: string;
    };
  };
}

/**
 * Parses and sanitizes an upstream error into a Google-shaped error response.
 */
export function sanitizeUpstreamError(error: unknown): SanitizedGoogleErrorResult {
  let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
  let rawMessage = error instanceof Error ? error.message : String(error);
  let googleStatus: string | undefined;
  let retryAfter: string | undefined;
  let recoverableSuffix: string | undefined;
  let validationLink: string | undefined;

  if (error instanceof UpstreamRequestError) {
    if (error.status && error.status >= 400 && error.status <= 599) {
      statusCode = error.status;
    }
    if (error.headers?.retryAfter) {
      retryAfter = sanitizeRetryAfterHeader(error.headers.retryAfter);
    }

    if (error.body) {
      try {
        const parsed = JSON.parse(error.body);
        if (isObjectLike(parsed) && isObjectLike((parsed as any).error)) {
          const errObj = (parsed as any).error;
          if (isString(errObj.message) && errObj.message.trim().length > 0) {
            rawMessage = errObj.message;
          }
          googleStatus = normalizeGoogleRpcStatus(errObj.status);
        }
      } catch {
        // Fall back to error.message
      }
    }

    if (statusCode === HttpStatus.FORBIDDEN) {
      const classification = classifyForbiddenUpstreamError({
        details: error.details,
        body: error.body,
        message: error.message,
      });
      // Appended after sanitizing: the verification URL is the whole point of the message and the
      // credential redactor would otherwise mangle its query string.
      recoverableSuffix = describeForbiddenUpstreamClassification(classification);
      validationLink = classification.validationLink;
    }
  }

  const sanitizedMessage = sanitizeErrorMessage(rawMessage);
  const message = recoverableSuffix ? `${sanitizedMessage} ${recoverableSuffix}` : sanitizedMessage;
  const finalGoogleStatus = googleStatus || getGoogleStatusForHttpCode(statusCode);

  return {
    statusCode,
    googleStatus: finalGoogleStatus,
    message,
    retryAfter,
    validationLink,
    errorEnvelope: {
      error: {
        code: statusCode,
        message,
        status: finalGoogleStatus,
      },
    },
  };
}
