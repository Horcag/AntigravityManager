import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { RateLimitTrackerService } from '@/modules/proxy-gateway/server/modules/shared/services/rate-limit-tracker.service';
import {
  createUpstreamResponseHeaders,
  getUpstreamResponseMetadata,
  parseUpstreamResponseMetadata,
  sumGoogleOneAiCredits,
} from '@/modules/proxy-gateway/server/common/upstream-response-metadata';

const ENVELOPE = {
  response: { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }] },
  traceId: 'trace-abc123',
  consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '12' }],
  remainingCredits: [
    { creditType: 'GOOGLE_ONE_AI', creditAmount: '400' },
    { creditType: 'GOOGLE_ONE_AI', creditAmount: '88' },
    { creditType: 'CREDIT_TYPE_UNSPECIFIED', creditAmount: '9999' },
  ],
};

describe('upstream response metadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses the v1internal envelope fields and ignores payloads without them', () => {
    expect(parseUpstreamResponseMetadata(ENVELOPE)).toEqual({
      traceId: 'trace-abc123',
      consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '12' }],
      remainingCredits: [
        { creditType: 'GOOGLE_ONE_AI', creditAmount: '400' },
        { creditType: 'GOOGLE_ONE_AI', creditAmount: '88' },
        { creditType: 'CREDIT_TYPE_UNSPECIFIED', creditAmount: '9999' },
      ],
    });
    expect(parseUpstreamResponseMetadata({ response: { candidates: [] } })).toBeUndefined();
    expect(parseUpstreamResponseMetadata('nope')).toBeUndefined();
  });

  it('sums only GOOGLE_ONE_AI credits and reports a missing balance as null', () => {
    expect(sumGoogleOneAiCredits(ENVELOPE.remainingCredits)).toBe(488);
    expect(
      sumGoogleOneAiCredits([{ creditType: 'CREDIT_TYPE_UNSPECIFIED', creditAmount: '5' }]),
    ).toBeNull();
    expect(sumGoogleOneAiCredits(undefined)).toBeNull();
  });

  it('emits traceId as a response header only when present', () => {
    expect(createUpstreamResponseHeaders({ traceId: 'trace-abc123' })).toEqual({
      'x-antigravity-trace-id': 'trace-abc123',
    });
    expect(createUpstreamResponseHeaders({ remainingCredits: [] })).toEqual({});
    expect(createUpstreamResponseHeaders(undefined)).toEqual({});
  });

  it('keeps the envelope fields on the unwrapped non-stream response', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: ENVELOPE } as never);

    const client = new GeminiClient();
    const response = await client.generateInternal(
      {
        model: 'gemini-3-flash',
        requestId: 'request-a',
        requestType: 'generate-content',
        userAgent: 'test-agent',
        request: { contents: [{ parts: [{ text: 'hi' }], role: 'user' }] },
      },
      'access-token',
    );

    expect(response).toEqual(ENVELOPE.response);
    expect(response).not.toHaveProperty('traceId');
    expect(getUpstreamResponseMetadata(response)?.traceId).toBe('trace-abc123');
    expect(createUpstreamResponseHeaders(getUpstreamResponseMetadata(response))).toEqual({
      'x-antigravity-trace-id': 'trace-abc123',
    });
  });

  it('folds the remaining credit balance into the cached account quota', () => {
    const service = new AccountLeaseService(new RateLimitTrackerService());
    const tokens = (service as unknown as { tokens: Map<string, Record<string, unknown>> }).tokens;
    tokens.set('acc-1', {
      account_id: 'acc-1',
      email: 'acc-1@example.com',
      quota: { models: {}, ai_credits: { credits: 1000, expiryDate: '2099-01-01' } },
    });

    service.recordUpstreamCredits('acc-1@example.com', {
      remainingCredits: ENVELOPE.remainingCredits,
    });

    expect(tokens.get('acc-1')?.quota).toEqual({
      models: {},
      ai_credits: { credits: 488, expiryDate: '2099-01-01' },
    });
  });

  it('leaves the cached balance alone when no GOOGLE_ONE_AI amount was reported', () => {
    const service = new AccountLeaseService(new RateLimitTrackerService());
    const tokens = (service as unknown as { tokens: Map<string, Record<string, unknown>> }).tokens;
    tokens.set('acc-2', {
      account_id: 'acc-2',
      email: 'acc-2@example.com',
      quota: { models: {}, ai_credits: { credits: 1000, expiryDate: '2099-01-01' } },
    });

    service.recordUpstreamCredits('acc-2', { traceId: 'trace-only' });

    expect(tokens.get('acc-2')?.quota).toEqual({
      models: {},
      ai_credits: { credits: 1000, expiryDate: '2099-01-01' },
    });
  });
});
