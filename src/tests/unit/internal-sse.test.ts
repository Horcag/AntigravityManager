import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { lastValueFrom, toArray } from 'rxjs';

import { decodeInternalSseData } from '@/modules/proxy-gateway/antigravity/internal-sse';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request-exception';
import {
  createGeminiSseObservable,
  type GeminiSseDiagnostics,
} from '@/modules/proxy-gateway/server/modules/gemini/gemini-sse-decoder';
import { sanitizeGeminiResponse } from '@/modules/proxy-gateway/server/modules/gemini/gemini-wire';

describe('decodeInternalSseData', () => {
  it('unwraps a v1internal-wrapped chunk so candidates/usage/model/id are reachable at the top level', () => {
    const raw = JSON.stringify({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'PONG' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
        modelVersion: 'gemini-3-flash',
        responseId: 'xmJrapmCPdC5vdIP1t_bwA8',
      },
      traceId: 'e75ed3b3774f95a3',
      metadata: {},
    });

    const result = decodeInternalSseData(raw);

    expect(result).toEqual({
      kind: 'response',
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'PONG' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
        modelVersion: 'gemini-3-flash',
        responseId: 'xmJrapmCPdC5vdIP1t_bwA8',
      },
    });
  });

  it('returns an already-bare chunk unchanged', () => {
    const bare = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 1 },
      modelVersion: 'gemini-3-pro',
      responseId: 'resp_1',
    };

    const result = decodeInternalSseData(JSON.stringify(bare));

    expect(result).toEqual({ kind: 'response', response: bare });
  });

  it('does not double-unwrap a payload carrying both response and top-level candidates', () => {
    const payload = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'top-level' }] } }],
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'nested' }] } }],
      },
    };

    const result = decodeInternalSseData(JSON.stringify(payload));

    expect(result).toEqual({ kind: 'response', response: payload });
  });

  it('keeps valid response metadata when a chunk has no candidates', () => {
    const payload = {
      usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
      modelVersion: 'gemini-3-flash',
      responseId: 'metadata-only',
    };

    expect(decodeInternalSseData(JSON.stringify(payload))).toEqual({
      kind: 'response',
      response: payload,
    });
  });

  it('ignores terminal markers and empty payloads', () => {
    expect(decodeInternalSseData('[DONE]')).toEqual({ kind: 'ignored' });
    expect(decodeInternalSseData('')).toEqual({ kind: 'ignored' });
    expect(decodeInternalSseData('   ')).toEqual({ kind: 'ignored' });
  });

  it('classifies malformed and non-object payloads as invalid without throwing', () => {
    expect(decodeInternalSseData('not json')).toEqual({ kind: 'invalid' });
    expect(decodeInternalSseData('null')).toEqual({ kind: 'invalid' });
    expect(decodeInternalSseData('42')).toEqual({ kind: 'invalid' });
    expect(decodeInternalSseData('[1,2,3]')).toEqual({ kind: 'invalid' });
  });
});

describe('createGeminiSseObservable', () => {
  it('unwraps v1internal wrapped SSE chunks into bare Gemini data events', async () => {
    const upstreamStream = Readable.from([
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]}}],"modelVersion":"gemini-3-flash"},"traceId":"t123","metadata":{}}\n\n',
      ),
    ]);

    const chunks = await lastValueFrom(createGeminiSseObservable(upstreamStream).pipe(toArray()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('data: {');
    const parsed = JSON.parse(chunks[0].replace(/^data: /, '').trim());

    expect(parsed).toEqual({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hello' }] },
          index: 0,
        },
      ],
      modelVersion: 'gemini-3-flash',
    });
    expect(parsed).not.toHaveProperty('traceId');
    expect(parsed).not.toHaveProperty('metadata');
  });

  it('handles split SSE frames across chunks and split UTF-8 characters', async () => {
    const unicodeChar = '👋'; // UTF-8: 4 bytes [0xF0, 0x9F, 0x90, 0x9B]
    const fullJson = JSON.stringify({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: unicodeChar }] } }],
      },
    });
    const fullText = `data: ${fullJson}\n\n`;
    const buf = Buffer.from(fullText, 'utf-8');

    const chunk1 = buf.subarray(0, 15);
    const chunk2 = buf.subarray(15);

    const upstreamStream = Readable.from([chunk1, chunk2]);
    const chunks = await lastValueFrom(createGeminiSseObservable(upstreamStream).pipe(toArray()));

    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0].replace(/^data: /, '').trim());
    expect(parsed.candidates[0].content.parts[0].text).toBe(unicodeChar);
  });

  it('handles multiline data and CRLF line endings', async () => {
    const streamContent =
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":\r\n' +
      'data: "multiline text"}]}}]}}\r\n\r\n';

    const upstreamStream = Readable.from([Buffer.from(streamContent)]);
    const chunks = await lastValueFrom(createGeminiSseObservable(upstreamStream).pipe(toArray()));

    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0].replace(/^data: /, '').trim());
    expect(parsed.candidates[0].content.parts[0].text).toBe('multiline text');
  });

  it('handles multiple events per chunk', async () => {
    const chunk =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"first"}]}}]}}\n\n' +
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"second"}]}}]}}\n\n';

    const upstreamStream = Readable.from([Buffer.from(chunk)]);
    const chunks = await lastValueFrom(createGeminiSseObservable(upstreamStream).pipe(toArray()));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('first');
    expect(chunks[1]).toContain('second');
  });

  it('handles final unterminated event on stream end', async () => {
    const chunk =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"final event without blank line"}]}}]}}';

    const upstreamStream = Readable.from([Buffer.from(chunk)]);
    const chunks = await lastValueFrom(createGeminiSseObservable(upstreamStream).pipe(toArray()));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('final event without blank line');
  });

  it('preserves candidate unknown fields while removing top-level private fields', () => {
    const input = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'part' }] },
          metadata: { candidateMeta: 'keep' },
          traceId: 'cand_trace',
          customField: 42,
        },
      ],
      traceId: 'top_trace',
      metadata: { top: true },
    };

    const sanitized = sanitizeGeminiResponse(input as any);
    expect(sanitized).not.toHaveProperty('traceId');
    expect(sanitized).not.toHaveProperty('metadata');

    const candidate = sanitized.candidates?.[0] as Record<string, unknown>;
    expect(candidate.metadata).toEqual({ candidateMeta: 'keep' });
    expect(candidate.traceId).toBe('cand_trace');
    expect(candidate.customField).toBe(42);
  });

  it('skips a malformed frame and still completes the response', async () => {
    const streamContent =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"valid"}]}}]}}\n\n' +
      'data: {malformed json\n\n' +
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"after"}]}}]}}\n\n';

    const upstreamStream = Readable.from([Buffer.from(streamContent)]);
    const diagnostics: GeminiSseDiagnostics[] = [];

    const chunks = await lastValueFrom(
      createGeminiSseObservable(upstreamStream, 300000, {
        onDiagnostics: (entry) => diagnostics.push(entry),
      }).pipe(toArray()),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('valid');
    expect(chunks[1]).toContain('after');
    expect(diagnostics).toEqual([{ skippedFrames: 1 }]);
  });

  it('fails only when every frame was malformed, reporting the skipped count', async () => {
    const upstreamStream = Readable.from([
      Buffer.from('data: {malformed json\n\ndata: also not json\n\n'),
    ]);
    const diagnostics: GeminiSseDiagnostics[] = [];
    let caughtError: unknown = null;

    await new Promise<void>((resolve) => {
      createGeminiSseObservable(upstreamStream, 300000, {
        onDiagnostics: (entry) => diagnostics.push(entry),
      }).subscribe({
        error: (error) => {
          caughtError = error;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    expect((caughtError as Error).message).toBe(
      'Empty response stream (2 malformed frame(s) skipped)',
    );
    expect(diagnostics).toEqual([{ skippedFrames: 2 }]);
  });

  it('destroys the exact upstream stream on unsubscribe', () => {
    const upstreamStream = new Readable({
      read() {
        // Keeps stream open
      },
    });

    const destroySpy = vi.spyOn(upstreamStream, 'destroy');

    const subscription = createGeminiSseObservable(upstreamStream, 50).subscribe();

    subscription.unsubscribe();
    expect(destroySpy).toHaveBeenCalled();
  });

  it('fails and destroys the upstream stream on idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const upstreamStream = new Readable({
        read() {
          // Keeps stream open without producing bytes.
        },
      });
      const destroySpy = vi.spyOn(upstreamStream, 'destroy');
      let caughtError: unknown;

      createGeminiSseObservable(upstreamStream, 50).subscribe({
        error: (error) => {
          caughtError = error;
        },
      });

      await vi.advanceTimersByTimeAsync(51);

      expect(destroySpy).toHaveBeenCalled();
      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toContain('idle timeout');
      expect((caughtError as UpstreamRequestError).status).toBe(504);
    } finally {
      vi.useRealTimers();
    }
  });
});
