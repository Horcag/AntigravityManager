import { logger } from '@/shared/logging/logger';
import type { CloudQuotaData } from '@/modules/cloud-account/types';

export type QuotaRefreshListener = (accountId: string, quota: CloudQuotaData) => void;

const listeners = new Set<QuotaRefreshListener>();

/**
 * Subscribes to "this account's quota was just refreshed from the provider".
 *
 * The proxy's account-lease cache copies `account.quota` when it loads accounts
 * and is rebuilt only on an explicit reload, while the quota poller writes its
 * refreshes to the account store. Without this hand-off the proxy keeps serving
 * the snapshot that was persisted when it started, so provider facts a newer
 * build learned to parse never reach the model policy — kanban-40: the
 * `ModelDetails` markers shipped with the completion-model rule stayed missing
 * for a whole session while the older `model_roles` in the same snapshot were
 * there, which read as "the rule never fires".
 *
 * @returns an unsubscribe function.
 */
export function onQuotaRefreshed(listener: QuotaRefreshListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announces a freshly fetched quota. Listeners are best-effort: quota
 * persistence must not fail because a subscriber threw.
 */
export function notifyQuotaRefreshed(accountId: string, quota: CloudQuotaData): void {
  for (const listener of [...listeners]) {
    try {
      listener(accountId, quota);
    } catch (error) {
      logger.warn(`Quota refresh listener failed for account ${accountId}`, error);
    }
  }
}
