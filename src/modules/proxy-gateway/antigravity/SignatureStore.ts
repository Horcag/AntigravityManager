import { Injectable } from '@nestjs/common';

export interface SignatureContext {
  accountId: string;
  model: string;
}

export interface SignatureKey extends SignatureContext {
  toolCallId: string;
}

interface SignatureEntry {
  signature: string;
  storedAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Bounded thought-signature state owned by the proxy Nest container.
 *
 * A signature is reusable only for the exact account, effective upstream model and
 * client-visible tool-call id that produced it. There is deliberately no session-only or
 * process-global fallback.
 */
@Injectable()
export class SignatureStore {
  private readonly entries = new Map<string, SignatureEntry>();
  private ttlMs = DEFAULT_TTL_MS;
  private maxEntries = DEFAULT_MAX_ENTRIES;

  public store(key: SignatureKey, signature: string | null | undefined): void {
    const storageKey = this.toStorageKey(key);
    if (!storageKey || !isUsableSignature(signature)) {
      return;
    }

    const now = Date.now();
    this.evictExpired(now);
    this.entries.delete(storageKey);
    this.entries.set(storageKey, { signature, storedAt: now });
    this.evictOverflow();
  }

  public get(key: SignatureKey): string | null {
    const storageKey = this.toStorageKey(key);
    if (!storageKey) {
      return null;
    }

    this.evictExpired(Date.now());
    return this.entries.get(storageKey)?.signature ?? null;
  }

  public clear(): void {
    this.entries.clear();
  }

  public size(): number {
    this.evictExpired(Date.now());
    return this.entries.size;
  }

  /** Instance-local bounds used by focused tests. */
  public configure(options: { maxEntries?: number; ttlMs?: number }): void {
    if (typeof options.ttlMs === 'number' && options.ttlMs > 0) {
      this.ttlMs = options.ttlMs;
    }
    if (typeof options.maxEntries === 'number' && options.maxEntries > 0) {
      this.maxEntries = options.maxEntries;
    }
    this.evictExpired(Date.now());
    this.evictOverflow();
  }

  public resetConfig(): void {
    this.ttlMs = DEFAULT_TTL_MS;
    this.maxEntries = DEFAULT_MAX_ENTRIES;
  }

  private toStorageKey(key: SignatureKey): string | null {
    const accountId = key?.accountId?.trim();
    const model = key?.model?.trim();
    const toolCallId = key?.toolCallId?.trim();
    if (!accountId || !model || !toolCallId) {
      return null;
    }
    return JSON.stringify([accountId, model, toolCallId]);
  }

  private evictExpired(now: number): void {
    for (const [storageKey, entry] of this.entries) {
      if (now - entry.storedAt >= this.ttlMs) {
        this.entries.delete(storageKey);
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}

function isUsableSignature(signature: string | null | undefined): signature is string {
  return typeof signature === 'string' && signature.trim().length > 0;
}
