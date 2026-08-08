/**
 * The pieces of the proxy service the SSE translators need.
 *
 * They are handed over explicitly rather than reached for through `this` so the
 * translators stay plain functions: the service still owns the idle-timer
 * policy, the logger and the Cloud Code meta decision, and the translators own
 * only the wire format.
 */
export interface StreamIdleTimer {
  clear(): void;
  dispose(): void;
  reset(): void;
}

export interface ProxyStreamRuntime {
  logger: {
    warn(message: string, ...optionalParams: unknown[]): void;
    error(message: string, ...optionalParams: unknown[]): void;
  };
  createStreamIdleTimer(
    upstreamStream: NodeJS.ReadableStream,
    label: string,
    onIdle: () => void,
  ): StreamIdleTimer;
}

/** Extra hooks the chat-completions surface needs for its Cloud Code preamble. */
export interface CloudCodeMetaRuntime {
  shouldEmitCloudCodeMeta(): boolean;
  createCloudCodeMetaChunk(traceId: string): string;
  createCloudCodeTraceId(): string;
}
