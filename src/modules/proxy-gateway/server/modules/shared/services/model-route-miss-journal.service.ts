import { Injectable } from '@nestjs/common';

export interface ModelRouteMissJournalEntry {
  model: string;
  count: number;
  lastSeen: number;
}

export const MODEL_ROUTE_MISS_JOURNAL_MAX_ENTRIES = 50;
const MODEL_ROUTE_ID_NORMALIZATION = /^models\//i;

function normalizeModelId(value: string): string {
  return value.replace(MODEL_ROUTE_ID_NORMALIZATION, '').trim().toLowerCase();
}

@Injectable()
export class ModelRouteMissJournalService {
  private readonly entries = new Map<string, ModelRouteMissJournalEntry>();

  record(model: string): void {
    const normalizedModel = normalizeModelId(model);
    if (!normalizedModel) {
      return;
    }

    const now = Date.now();
    const existing = this.entries.get(normalizedModel);
    if (existing) {
      this.entries.set(normalizedModel, {
        ...existing,
        count: existing.count + 1,
        lastSeen: now,
      });
      return;
    }

    if (this.entries.size >= MODEL_ROUTE_MISS_JOURNAL_MAX_ENTRIES) {
      this.evictOldest();
    }

    this.entries.set(normalizedModel, {
      model: normalizedModel,
      count: 1,
      lastSeen: now,
    });
  }

  clear(): void {
    this.entries.clear();
  }

  getSnapshot(): ModelRouteMissJournalEntry[] {
    return [...this.entries.values()].sort((left, right) => right.lastSeen - left.lastSeen);
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestSeen = Number.MAX_SAFE_INTEGER;

    for (const [key, entry] of this.entries) {
      if (entry.lastSeen < oldestSeen) {
        oldestSeen = entry.lastSeen;
        oldestKey = key;
      }
    }

    if (oldestKey === undefined) {
      return;
    }

    this.entries.delete(oldestKey);
  }
}
