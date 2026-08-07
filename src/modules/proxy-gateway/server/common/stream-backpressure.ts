import type { Observable } from 'rxjs';

const UPSTREAM_CONTROL = Symbol('proxy-upstream-control');

interface PausableReadableStream {
  pause?: () => unknown;
  resume?: () => unknown;
}

interface UpstreamControlledObservable<T> extends Observable<T> {
  [UPSTREAM_CONTROL]?: {
    pause(): void;
    resume(): void;
  };
}

export function attachUpstreamBackpressure<T>(
  observable: Observable<T>,
  upstreamStream: NodeJS.ReadableStream,
): Observable<T> {
  const controlled = observable as UpstreamControlledObservable<T>;
  const readable = upstreamStream as PausableReadableStream;
  controlled[UPSTREAM_CONTROL] = {
    pause: () => readable.pause?.call(readable),
    resume: () => readable.resume?.call(readable),
  };
  return controlled;
}

export function inheritUpstreamBackpressure<T>(
  source: Observable<unknown>,
  target: Observable<T>,
): Observable<T> {
  const control = (source as UpstreamControlledObservable<unknown>)[UPSTREAM_CONTROL];
  if (control) {
    (target as UpstreamControlledObservable<T>)[UPSTREAM_CONTROL] = control;
  }
  return target;
}

export function pauseObservableUpstream(observable: Observable<unknown>): void {
  (observable as UpstreamControlledObservable<unknown>)[UPSTREAM_CONTROL]?.pause();
}

export function resumeObservableUpstream(observable: Observable<unknown>): void {
  (observable as UpstreamControlledObservable<unknown>)[UPSTREAM_CONTROL]?.resume();
}
