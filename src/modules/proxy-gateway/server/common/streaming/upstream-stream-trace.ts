import { Logger } from '@nestjs/common';
import { isString } from 'lodash-es';
import { toRecord } from '../utils/json-record';

const logger = new Logger('UpstreamStreamTrace');

/**
 * Stamped on the upstream readable the moment the request is dispatched, so a trace created later
 * — at subscription time, once the SSE handshake has already been answered — can still tell
 * "upstream took this long to send its first frame" apart from "we took this long to start reading".
 */
const DISPATCH_MARK = Symbol.for('proxy-upstream-stream-dispatch');

interface DispatchMark {
  dispatchedAt: number;
  headersAt: number;
}

interface DispatchMarkedStream {
  [DISPATCH_MARK]?: DispatchMark;
}

let nextStreamId = 1;

/**
 * Upstream stream tracing is a diagnostic, not a feature: it is off unless `PROXY_STREAM_TRACE` is
 * `1` or `true`, and every call site guards on the returned trace being defined, so nothing is
 * computed — not even a byte count — while it is off.
 */
export function isUpstreamStreamTraceEnabled(): boolean {
  const flag = process.env.PROXY_STREAM_TRACE?.trim().toLowerCase();
  return flag === '1' || flag === 'true';
}

/** Records when the upstream request left, and when its response headers came back. */
export function markUpstreamStreamDispatch(
  upstreamStream: NodeJS.ReadableStream | undefined,
  dispatchedAt: number,
): void {
  if (!upstreamStream || !isUpstreamStreamTraceEnabled()) {
    return;
  }
  (upstreamStream as DispatchMarkedStream)[DISPATCH_MARK] = {
    dispatchedAt,
    headersAt: Date.now(),
  };
}

export interface UpstreamStreamTrace {
  /**
   * One upstream SSE frame as it arrived. `response` is the decoded payload when the frame carried
   * one; leave it undefined for frames that were ignored or malformed — their bytes still count.
   */
  recordFrame(rawFrame: string, response: unknown): void;
  /** Emits the per-stream summary. Idempotent, so every settle path may call it. */
  finish(outcome: string): void;
}

/**
 * Creates a per-stream trace of what upstream actually sent us, or `undefined` when tracing is off.
 *
 * Deliberately counts characters rather than logging them: a frame carries user content, and the
 * question this answers — how many frames, how big, how far apart, and how much of it was thinking
 * — needs only the shape.
 */
export function createUpstreamStreamTrace(
  surface: string,
  upstreamStream?: NodeJS.ReadableStream,
): UpstreamStreamTrace | undefined {
  if (!isUpstreamStreamTraceEnabled()) {
    return undefined;
  }
  return new UpstreamStreamTraceRecorder(
    surface,
    (upstreamStream as DispatchMarkedStream | undefined)?.[DISPATCH_MARK],
  );
}

interface FrameSummary {
  finishReason?: string;
  functionCalls: number;
  modelVersion?: string;
  textChars: number;
  thoughtChars: number;
}

function summarizeFrame(responseValue: unknown): FrameSummary {
  const summary: FrameSummary = { functionCalls: 0, textChars: 0, thoughtChars: 0 };
  const response = toRecord(responseValue);
  if (!response) {
    return summary;
  }
  if (isString(response.modelVersion) && response.modelVersion.trim()) {
    summary.modelVersion = response.modelVersion.trim();
  }

  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  for (const candidateValue of candidates) {
    const candidate = toRecord(candidateValue);
    if (!candidate) {
      continue;
    }
    if (isString(candidate.finishReason)) {
      summary.finishReason = candidate.finishReason;
    }
    const content = toRecord(candidate.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const partValue of parts) {
      const part = toRecord(partValue);
      if (!part) {
        continue;
      }
      if (isString(part.text)) {
        if (part.thought === true) {
          summary.thoughtChars += part.text.length;
        } else {
          summary.textChars += part.text.length;
        }
      }
      if (toRecord(part.functionCall)) {
        summary.functionCalls += 1;
      }
    }
  }
  return summary;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

class UpstreamStreamTraceRecorder implements UpstreamStreamTrace {
  private readonly streamId = nextStreamId++;
  private readonly subscribedAt = Date.now();
  /** Frame offsets are measured from dispatch when known, so they include upstream think time. */
  private readonly originAt: number;
  private readonly gaps: number[] = [];
  private finished = false;
  private frameCount = 0;
  private totalBytes = 0;
  private totalTextChars = 0;
  private totalThoughtChars = 0;
  private textFrames = 0;
  private thoughtFrames = 0;
  private functionCallFrames = 0;
  private lastFrameAt: number | undefined;
  private firstFrameMs: number | undefined;
  private firstTextFrameMs: number | undefined;
  private firstThoughtFrameMs: number | undefined;
  private lastFrameMs = 0;
  private servedModel = 'unknown';
  private finishReason = '-';

  constructor(
    private readonly surface: string,
    private readonly dispatch: DispatchMark | undefined,
  ) {
    this.originAt = dispatch?.dispatchedAt ?? this.subscribedAt;
  }

  recordFrame(rawFrame: string, response: unknown): void {
    const now = Date.now();
    const atMs = now - this.originAt;
    const gapMs = this.lastFrameAt === undefined ? atMs : now - this.lastFrameAt;
    this.lastFrameAt = now;
    if (this.frameCount > 0) {
      this.gaps.push(gapMs);
    }

    const bytes = Buffer.byteLength(rawFrame, 'utf8');
    const summary = summarizeFrame(response);
    this.frameCount += 1;
    this.totalBytes += bytes;
    this.totalTextChars += summary.textChars;
    this.totalThoughtChars += summary.thoughtChars;
    this.lastFrameMs = atMs;
    this.firstFrameMs ??= atMs;
    if (summary.textChars > 0) {
      this.textFrames += 1;
      this.firstTextFrameMs ??= atMs;
    }
    if (summary.thoughtChars > 0) {
      this.thoughtFrames += 1;
      this.firstThoughtFrameMs ??= atMs;
    }
    if (summary.functionCalls > 0) {
      this.functionCallFrames += 1;
    }
    if (summary.modelVersion) {
      this.servedModel = summary.modelVersion;
    }
    if (summary.finishReason) {
      this.finishReason = summary.finishReason;
    }

    logger.log(
      `${this.prefix()} frame=${this.frameCount - 1} atMs=${atMs} gapMs=${gapMs} bytes=${bytes} ` +
        `thoughtChars=${summary.thoughtChars} textChars=${summary.textChars} ` +
        `fnCalls=${summary.functionCalls} finish=${summary.finishReason ?? '-'}`,
    );
  }

  finish(outcome: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    logger.log(
      `${this.prefix()} SUMMARY outcome=${outcome} frames=${this.frameCount} bytes=${this.totalBytes} ` +
        `dispatchToHeadersMs=${this.dispatchToHeadersMs()} headersToFirstFrameMs=${this.headersToFirstFrameMs()} ` +
        `firstFrameMs=${this.firstFrameMs ?? -1} firstThoughtFrameMs=${this.firstThoughtFrameMs ?? -1} ` +
        `firstTextFrameMs=${this.firstTextFrameMs ?? -1} lastFrameMs=${this.lastFrameMs} ` +
        `totalMs=${Date.now() - this.originAt} thoughtFrames=${this.thoughtFrames} textFrames=${this.textFrames} ` +
        `fnCallFrames=${this.functionCallFrames} thoughtChars=${this.totalThoughtChars} ` +
        `textChars=${this.totalTextChars} meanBytesPerFrame=${this.meanBytesPerFrame()} ` +
        `maxGapMs=${this.gaps.length > 0 ? Math.max(...this.gaps) : 0} medianGapMs=${median(this.gaps)} ` +
        `finishReason=${this.finishReason}`,
    );
  }

  private prefix(): string {
    return `surface=${this.surface} stream=${this.streamId} model=${this.servedModel}`;
  }

  private dispatchToHeadersMs(): number {
    return this.dispatch ? this.dispatch.headersAt - this.dispatch.dispatchedAt : -1;
  }

  private headersToFirstFrameMs(): number {
    if (this.firstFrameMs === undefined) {
      return -1;
    }
    const headersAt = this.dispatch?.headersAt ?? this.subscribedAt;
    return this.originAt + this.firstFrameMs - headersAt;
  }

  private meanBytesPerFrame(): number {
    return this.frameCount === 0 ? 0 : Math.round(this.totalBytes / this.frameCount);
  }
}
