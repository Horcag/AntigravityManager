/**
 * Keyed thought_signature storage.
 *
 * Signatures are captured per upstream tool call and replayed only for the exact same
 * (account, effective upstream model, tool call id) triple. There is no unkeyed global
 * fallback: a signature captured for one call/session/account/model is never injected
 * into another one.
 *
 * State is bounded by both a TTL and a maximum entry count, with deterministic lazy
 * cleanup performed on every read/write.
 */
import { logger } from '@/shared/logging/logger';

/**
 * Per-request correlation context: which account and which effective upstream model
 * produced (or will consume) a signature.
 */
export interface SignatureContext {
  accountId: string;
  model: string;
}

/**
 * Full storage key: request context plus the stable tool-call/tool-use id.
 */
export interface SignatureKey extends SignatureContext {
  toolCallId: string;
}

interface SignatureEntry {
  signature: string;
  storedAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

class KeyedSignatureStore {
  private static instance: KeyedSignatureStore;
  /** Insertion-ordered: the oldest write is always the first entry. */
  private readonly entries = new Map<string, SignatureEntry>();
  private ttlMs = DEFAULT_TTL_MS;
  private maxEntries = DEFAULT_MAX_ENTRIES;

  private constructor() {}

  public static getInstance(): KeyedSignatureStore {
    if (!KeyedSignatureStore.instance) {
      KeyedSignatureStore.instance = new KeyedSignatureStore();
    }
    return KeyedSignatureStore.instance;
  }

  /**
   * Store the signature for its exact key. The most recent write always wins;
   * signature length is never used as a freshness or validity heuristic.
   */
  public store(key: SignatureKey, signature: string | null | undefined): void {
    const storageKey = this.toStorageKey(key);
    if (!storageKey || !isUsableSignature(signature)) {
      return;
    }

    const now = Date.now();
    this.evictExpired(now);

    // Re-insert so the entry moves to the most-recent position.
    this.entries.delete(storageKey);
    this.entries.set(storageKey, { signature: signature as string, storedAt: now });
    this.evictOverflow();

    logger.debug(
      `[ThoughtSig] Stored signature for tool call ${key.toolCallId} (account=${key.accountId}, model=${key.model})`,
    );
  }

  /**
   * Get the signature stored for the exact key, or null when absent or expired.
   */
  public get(key: SignatureKey): string | null {
    const storageKey = this.toStorageKey(key);
    if (!storageKey) {
      return null;
    }

    const now = Date.now();
    this.evictExpired(now);

    const entry = this.entries.get(storageKey);
    if (!entry) {
      return null;
    }
    return entry.signature;
  }

  /**
   * Remove every stored signature. Used by tests and on explicit resets.
   */
  public clear(): void {
    this.entries.clear();
  }

  /**
   * Current number of live (not yet lazily evicted) entries.
   */
  public size(): number {
    return this.entries.size;
  }

  /**
   * Adjust the bounds. Intended for tests; production uses the defaults.
   */
  public configure(options: { maxEntries?: number; ttlMs?: number }): void {
    if (typeof options.ttlMs === 'number' && options.ttlMs > 0) {
      this.ttlMs = options.ttlMs;
    }
    if (typeof options.maxEntries === 'number' && options.maxEntries > 0) {
      this.maxEntries = options.maxEntries;
    }
  }

  /**
   * Restore the production bounds.
   */
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

function isUsableSignature(signature: string | null | undefined): boolean {
  return typeof signature === 'string' && signature.trim().length > 0;
}

export const SignatureStore = KeyedSignatureStore.getInstance();
