import type { CloudAccount } from '@/modules/cloud-account/types';
import { getPublicModelIdForDisplayName } from '../antigravity/ModelMapping';

export interface ProxyExampleModel {
  id: string;
  name: string;
}

type ProxyExampleAccount = Pick<CloudAccount, 'quota'>;

export function buildProxyExampleModels(
  accounts: readonly ProxyExampleAccount[],
): ProxyExampleModel[] {
  const modelsByNormalizedId = new Map<string, ProxyExampleModel>();

  for (const account of accounts) {
    for (const [rawModelId, info] of Object.entries(account.quota?.models ?? {})) {
      const modelId = rawModelId.replace(/^models\//i, '').trim();
      if (!modelId) {
        continue;
      }

      const displayName = info.display_name?.trim();
      const publicModelId = getPublicModelIdForDisplayName(displayName) ?? modelId;
      const normalizedId = publicModelId.toLowerCase();
      const current = modelsByNormalizedId.get(normalizedId);
      if (!current || displayName) {
        modelsByNormalizedId.set(normalizedId, {
          id: current?.id ?? publicModelId,
          name: displayName || current?.name || publicModelId,
        });
      }
    }
  }

  return [...modelsByNormalizedId.values()];
}

export function isImageProxyExampleModel(modelId: string): boolean {
  return modelId.toLowerCase().includes('image');
}
