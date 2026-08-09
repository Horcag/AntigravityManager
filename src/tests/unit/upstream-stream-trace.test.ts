import { Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processStreamResponse } from '@/modules/proxy-gateway/server/common/streaming/openai-chat-internal-stream';
import type { OpenAIChatStreamRuntime } from '@/modules/proxy-gateway/server/common/streaming/openai-chat-internal-stream';
import {
  createUpstreamStreamTrace,
  isUpstreamStreamTraceEnabled,
  markUpstreamStreamDispatch,
} from '@/modules/proxy-gateway/server/common/streaming/upstream-stream-trace';

const FLAG = 'PROXY_STREAM_TRACE';

function thoughtFrame(text: string): Record<string, unknown> {
  return {
    candidates: [{ content: { parts: [{ text, thought: true }] } }],
    modelVersion: 'gemini-3-flash',
  };
}

function textFrame(text: string, finishReason?: string): Record<string, unknown> {
  return {
    candidates: [
      {
        content: { parts: [{ text }] },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
    modelVersion: 'gemini-3-flash',
  };
}

describe('upstream stream trace', () => {
  let logged: string[];
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env[FLAG];
    logged = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFlag === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = originalFlag;
    }
  });

  it('stays off unless the env flag is explicitly enabled', () => {
    for (const value of [undefined, '', 'false', '0', 'no']) {
      if (value === undefined) {
        delete process.env[FLAG];
      } else {
        process.env[FLAG] = value;
      }
      expect(isUpstreamStreamTraceEnabled()).toBe(false);
      expect(createUpstreamStreamTrace('openai-chat')).toBeUndefined();
    }
    expect(logged).toEqual([]);
  });

  it('turns on for 1 and true, case- and whitespace-insensitively', () => {
    for (const value of ['1', 'true', ' TRUE ']) {
      process.env[FLAG] = value;
      expect(isUpstreamStreamTraceEnabled()).toBe(true);
      expect(createUpstreamStreamTrace('openai-chat')).toBeDefined();
    }
  });

  it('separates thinking characters from answer characters and reports both first-frame offsets', () => {
    process.env[FLAG] = '1';
    const trace = createUpstreamStreamTrace('openai-chat');

    trace?.recordFrame('data: {...}', thoughtFrame('weighing options'));
    trace?.recordFrame('data: {...}', textFrame('hello'));
    trace?.recordFrame('data: {...}', textFrame(' world', 'STOP'));
    trace?.finish('completed');

    const summary = logged.at(-1) ?? '';
    expect(summary).toContain('SUMMARY outcome=completed');
    expect(summary).toContain('frames=3');
    expect(summary).toContain('thoughtFrames=1');
    expect(summary).toContain('textFrames=2');
    expect(summary).toContain(`thoughtChars=${'weighing options'.length}`);
    expect(summary).toContain(`textChars=${'hello world'.length}`);
    expect(summary).toContain('finishReason=STOP');
    expect(summary).toContain('model=gemini-3-flash');
    // A thought frame arriving first is the whole question this instrument answers, so the two
    // offsets must be reported apart rather than collapsed into one "time to first frame".
    expect(summary).toMatch(/firstThoughtFrameMs=\d+/);
    expect(summary).toMatch(/firstTextFrameMs=\d+/);
  });

  it('counts the bytes of frames it could not decode without dropping them from the total', () => {
    process.env[FLAG] = 'true';
    const trace = createUpstreamStreamTrace('gemini-native');

    trace?.recordFrame('12345', undefined);
    trace?.finish('ended');

    const summary = logged.at(-1) ?? '';
    expect(summary).toContain('frames=1');
    expect(summary).toContain('bytes=5');
    expect(summary).toContain('meanBytesPerFrame=5');
    expect(summary).toContain('thoughtChars=0');
    expect(summary).toContain('textChars=0');
  });

  it('summarises once however many settle paths call finish', () => {
    process.env[FLAG] = '1';
    const trace = createUpstreamStreamTrace('openai-chat');

    trace?.recordFrame('data: {...}', textFrame('hi'));
    trace?.finish('completed');
    trace?.finish('unsubscribed');

    expect(logged.filter((line) => line.includes('SUMMARY'))).toHaveLength(1);
  });

  it('measures from dispatch when the client stamped the stream, so upstream silence is visible', () => {
    process.env[FLAG] = '1';
    const stream = Readable.from([]) as NodeJS.ReadableStream;
    markUpstreamStreamDispatch(stream, Date.now() - 2_400);

    const trace = createUpstreamStreamTrace('openai-chat', stream);
    trace?.recordFrame('data: {...}', textFrame('late'));
    trace?.finish('completed');

    const summary = logged.at(-1) ?? '';
    const firstFrameMs = Number(/firstFrameMs=(\d+)/.exec(summary)?.[1]);
    expect(firstFrameMs).toBeGreaterThanOrEqual(2_400);
    expect(Number(/dispatchToHeadersMs=(\d+)/.exec(summary)?.[1])).toBeGreaterThanOrEqual(2_400);
  });

  it('leaves no mark on the stream while the flag is off', () => {
    delete process.env[FLAG];
    const stream = Readable.from([]) as NodeJS.ReadableStream;
    markUpstreamStreamDispatch(stream, Date.now());

    process.env[FLAG] = '1';
    const trace = createUpstreamStreamTrace('openai-chat', stream);
    trace?.recordFrame('data: {...}', textFrame('hi'));
    trace?.finish('completed');

    expect(logged.at(-1) ?? '').toContain('dispatchToHeadersMs=-1');
  });
});

function chatStreamRuntime(): OpenAIChatStreamRuntime {
  return {
    logger: { error: () => {}, warn: () => {} },
    createStreamIdleTimer: () => ({ clear: () => {}, dispose: () => {}, reset: () => {} }),
    shouldEmitCloudCodeMeta: () => false,
    createCloudCodeMetaChunk: () => '',
    createCloudCodeTraceId: () => 'trace',
  };
}

function upstreamSse(...frames: Record<string, unknown>[]): NodeJS.ReadableStream {
  return Readable.from(
    frames.map((frame) => Buffer.from(`data: ${JSON.stringify({ response: frame })}\n\n`, 'utf8')),
  );
}

describe('chat-completions translator tracing', () => {
  let logged: string[];
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env[FLAG];
    logged = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFlag === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = originalFlag;
    }
  });

  it('traces every upstream frame the chat surface decodes', async () => {
    process.env[FLAG] = '1';
    const stream = upstreamSse(thoughtFrame('thinking'), textFrame('answer', 'STOP'));

    await lastValueFrom(
      processStreamResponse(chatStreamRuntime(), stream, { model: 'gemini-3-flash' }).pipe(
        toArray(),
      ),
    );

    const traced = logged.filter((line) => line.startsWith('surface=openai-chat'));
    expect(traced.filter((line) => line.includes('SUMMARY'))).toHaveLength(1);
    const summary = traced.at(-1) ?? '';
    expect(summary).toContain('frames=2');
    expect(summary).toContain('thoughtFrames=1');
    expect(summary).toContain('textFrames=1');
  });

  it('stays silent on the same stream while the flag is off', async () => {
    delete process.env[FLAG];
    const stream = upstreamSse(thoughtFrame('thinking'), textFrame('answer', 'STOP'));

    await lastValueFrom(
      processStreamResponse(chatStreamRuntime(), stream, { model: 'gemini-3-flash' }).pipe(
        toArray(),
      ),
    );

    expect(logged.filter((line) => line.startsWith('surface='))).toEqual([]);
  });
});
