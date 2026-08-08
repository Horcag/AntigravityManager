import type { ModelAliasRoute, ProxyConfig } from '@/modules/config/types';

function normalizeRoutePart(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function appendRoute(
  routes: ModelAliasRoute[],
  seenAliases: Set<string>,
  aliasValue: unknown,
  targetValue: unknown,
  enabled: boolean,
): void {
  const alias = normalizeRoutePart(aliasValue);
  const target = normalizeRoutePart(targetValue);
  const key = alias.toLowerCase();
  if (!alias || !target || seenAliases.has(key)) {
    return;
  }
  seenAliases.add(key);
  routes.push({ alias, target, enabled });
}

function legacyEntries(value: unknown): Array<[string, unknown]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value);
}

/**
 * Whether the legacy mapping tables still carry routes.
 *
 * This is the only condition under which the migration changes anything, so it
 * is also the only condition under which the file on disk should be rewritten:
 * a configuration already in the new shape must be left exactly as the user
 * wrote it.
 */
export function hasLegacyModelAliasMappings(proxy: ProxyConfig): boolean {
  return (
    legacyEntries(proxy.custom_mapping).length > 0 ||
    legacyEntries(proxy.anthropic_mapping).length > 0
  );
}

export function migrateLegacyModelAliases(proxy: ProxyConfig): ProxyConfig {
  const routes: ModelAliasRoute[] = [];
  const seenAliases = new Set<string>();

  if (Array.isArray(proxy.model_aliases)) {
    for (const route of proxy.model_aliases) {
      appendRoute(routes, seenAliases, route?.alias, route?.target, route?.enabled !== false);
    }
  }
  for (const [alias, target] of legacyEntries(proxy.custom_mapping)) {
    appendRoute(routes, seenAliases, alias, target, true);
  }
  for (const [alias, target] of legacyEntries(proxy.anthropic_mapping)) {
    appendRoute(routes, seenAliases, alias, target, true);
  }

  return {
    ...proxy,
    model_aliases: routes,
    custom_mapping: {},
    anthropic_mapping: {},
  };
}
