import { describe, expect, it } from 'vitest';
import {
  sanitizeGeminiResponse,
  validateGeminiSystemInstruction,
  sanitizeErrorMessage,
  sanitizeRetryAfterHeader,
  sanitizeUpstreamError,
  getGoogleStatusForHttpCode,
} from '../../modules/proxy-gateway/server/modules/gemini/gemini-wire';
import { UpstreamRequestError } from '../../modules/proxy-gateway/server/common/exceptions/upstream-request-exception';

describe('gemini-wire pure helpers', () => {
  describe('sanitizeGeminiResponse', () => {
    it('strips top-level private fields traceId, metadata, __cloudCodeMeta while preserving candidate metadata and unknown fields', () => {
      const response = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'hello' }] },
            finishReason: 'STOP',
            metadata: { customCandidateMeta: true },
            traceId: 'cand_trace',
            __cloudCodeMeta: { internal: 1 },
            unknownCandidateField: 'keep_me',
          },
        ],
        usageMetadata: { promptTokenCount: 10 },
        modelVersion: 'gemini-3-flash',
        traceId: 'private_top_trace',
        metadata: { privateTopMeta: 123 },
        __cloudCodeMeta: { topCloud: true },
        topUnknownField: 'preserve_top_unknown',
      };

      const sanitized = sanitizeGeminiResponse(response as any);

      // Top level
      expect(sanitized).not.toHaveProperty('traceId');
      expect(sanitized).not.toHaveProperty('metadata');
      expect(sanitized).not.toHaveProperty('__cloudCodeMeta');
      expect(sanitized).toHaveProperty('topUnknownField', 'preserve_top_unknown');
      expect(sanitized).toHaveProperty('modelVersion', 'gemini-3-flash');

      // Candidate level: candidate metadata and unknown candidate fields MUST be preserved!
      const candidate = sanitized.candidates?.[0] as Record<string, unknown>;
      expect(candidate).toBeDefined();
      expect(candidate.index).toBe(0);
      expect(candidate.metadata).toEqual({ customCandidateMeta: true });
      expect(candidate.traceId).toBe('cand_trace');
      expect(candidate.__cloudCodeMeta).toEqual({ internal: 1 });
      expect(candidate.unknownCandidateField).toBe('keep_me');
    });

    it('adds index to candidates only when index is missing or not a number', () => {
      const response = {
        candidates: [
          { content: { parts: [{ text: 'a' }] }, index: 5 },
          { content: { parts: [{ text: 'b' }] } },
        ],
      };

      const sanitized = sanitizeGeminiResponse(response as any);
      expect(sanitized.candidates?.[0].index).toBe(5);
      expect(sanitized.candidates?.[1].index).toBe(1);
    });
  });

  describe('validateGeminiSystemInstruction', () => {
    it('allows undefined / null systemInstruction', () => {
      expect(validateGeminiSystemInstruction(undefined)).toEqual({ valid: true });
      expect(validateGeminiSystemInstruction(null)).toEqual({ valid: true });
    });

    it('accepts valid text-only system instruction parts', () => {
      const validInst = {
        parts: [{ text: 'You are a helpful coding assistant.' }],
      };
      expect(validateGeminiSystemInstruction(validInst)).toEqual({ valid: true });
    });

    it('rejects empty or non-array parts', () => {
      expect(validateGeminiSystemInstruction({ parts: [] })).toEqual({
        valid: false,
        message: 'systemInstruction.parts must be a non-empty array',
      });
      expect(validateGeminiSystemInstruction({ parts: 'not an array' })).toEqual({
        valid: false,
        message: 'systemInstruction.parts must be a non-empty array',
      });
    });

    it('rejects parts containing non-text fields (e.g. inlineData)', () => {
      const invalidInst = {
        parts: [{ text: 'valid text', inlineData: { mimeType: 'image/png', data: 'xyz' } }],
      };
      const res = validateGeminiSystemInstruction(invalidInst);
      expect(res.valid).toBe(false);
      expect(res.message).toContain('non-text fields');
    });

    it('rejects parts with empty or whitespace-only text', () => {
      const emptyInst = {
        parts: [{ text: '   ' }],
      };
      const res = validateGeminiSystemInstruction(emptyInst);
      expect(res.valid).toBe(false);
      expect(res.message).toContain('non-empty text string');
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('redacts project IDs and numbers', () => {
      const msg = 'Quota exceeded for project 123456789 in region us-central1';
      const sanitized = sanitizeErrorMessage(msg);
      expect(sanitized).not.toContain('123456789');
      expect(sanitized).toContain('project [REDACTED]');
    });

    it('redacts emails and authorization tokens', () => {
      const msg = 'User user@example.com with Bearer ya29.a0AfH6SM... failed auth';
      const sanitized = sanitizeErrorMessage(msg);
      expect(sanitized).not.toContain('user@example.com');
      expect(sanitized).not.toContain('ya29.a0AfH6SM');
      expect(sanitized).toContain('[REDACTED_EMAIL]');
      expect(sanitized).toContain('[REDACTED_TOKEN]');
    });
  });

  describe('sanitizeRetryAfterHeader', () => {
    it('accepts valid integer seconds under 86400', () => {
      expect(sanitizeRetryAfterHeader('30')).toBe('30');
      expect(sanitizeRetryAfterHeader('120')).toBe('120');
    });

    it('rejects non-numeric unsafe or oversized retry-after strings', () => {
      expect(sanitizeRetryAfterHeader('999999999')).toBeUndefined();
      expect(sanitizeRetryAfterHeader('invalid_header\r\nInjected: header')).toBeUndefined();
    });
  });

  describe('sanitizeUpstreamError', () => {
    it('parses valid upstream Google JSON error body', () => {
      const err = new UpstreamRequestError({
        message: 'Raw message',
        status: 429,
        body: JSON.stringify({
          error: {
            code: 429,
            message: 'Quota exceeded for project 98765',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
      });

      const sanitized = sanitizeUpstreamError(err);
      expect(sanitized.statusCode).toBe(429);
      expect(sanitized.googleStatus).toBe('RESOURCE_EXHAUSTED');
      expect(sanitized.message).not.toContain('98765');
      expect(sanitized.errorEnvelope.error.message).toContain('project [REDACTED]');
    });

    it('falls back to 500 for invalid HTTP status code', () => {
      const err = new UpstreamRequestError({
        message: 'Custom internal error',
        status: 999 as any,
      });

      const sanitized = sanitizeUpstreamError(err);
      expect(sanitized.statusCode).toBe(500);
      expect(sanitized.googleStatus).toBe('INTERNAL');
    });
  });

  describe('getGoogleStatusForHttpCode', () => {
    it('maps standard HTTP codes to Google RPC status strings', () => {
      expect(getGoogleStatusForHttpCode(400)).toBe('INVALID_ARGUMENT');
      expect(getGoogleStatusForHttpCode(401)).toBe('UNAUTHENTICATED');
      expect(getGoogleStatusForHttpCode(403)).toBe('PERMISSION_DENIED');
      expect(getGoogleStatusForHttpCode(404)).toBe('NOT_FOUND');
      expect(getGoogleStatusForHttpCode(429)).toBe('RESOURCE_EXHAUSTED');
      expect(getGoogleStatusForHttpCode(501)).toBe('UNIMPLEMENTED');
      expect(getGoogleStatusForHttpCode(503)).toBe('UNAVAILABLE');
    });
  });
});
