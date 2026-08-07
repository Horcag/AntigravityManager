import { Injectable } from '@nestjs/common';
import { getServerConfig } from '../../../../../../server/server-config';
import type { ProxyConfig } from '../../../../../config/types';

export type ModelRouteSource =
  | 'canonical'
  | 'configured'
  | 'disabled'
  | 'legacy-anthropic'
  | 'legacy-custom';

export interface ModelRouteResolution {
  requestedModel: string;
  normalizedModel: string;
  targetModel: string;
  source: ModelRouteSource;
  alias?: string;
  enabled: boolean;
  wildcard: boolean;
}

export interface ConfiguredModelRoute {
  alias: string;
  target: string;
  enabled: boolean;
  source: Extract<ModelRouteSource, 'configured' | 'legacy-anthropic' | 'legacy-custom'>;
  wildcard: boolean;
}

function normalizeModelId(model: string): string {
  return model.replace(/^models\//i, '').trim();
}

function toWildcardPattern(alias: string): RegExp | null {
  if (!alias.includes('*')) {
    return null;
  }
  const escaped = alias.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'iu');
}

function appendLegacyRoutes(
  routes: ConfiguredModelRoute[],
  seenAliases: Set<string>,
  mapping: Record<string, string>,
  source: 'legacy-anthropic' | 'legacy-custom',
): void {
  for (const [rawAlias, rawTarget] of Object.entries(mapping)) {
    const alias = normalizeModelId(rawAlias);
    const target = normalizeModelId(rawTarget);
    const key = alias.toLowerCase();
    if (!alias || !target || seenAliases.has(key)) {
      continue;
    }
    seenAliases.add(key);
    routes.push({ alias, target, enabled: true, source, wildcard: alias.includes('*') });
  }
}

export function getConfiguredModelRoutes(
  config:
    | Pick<ProxyConfig, 'anthropic_mapping' | 'custom_mapping' | 'model_aliases'>
    | null
    | undefined,
): ConfiguredModelRoute[] {
  const routes: ConfiguredModelRoute[] = [];
  const seenAliases = new Set<string>();

  for (const route of config?.model_aliases ?? []) {
    const alias = normalizeModelId(route.alias);
    const target = normalizeModelId(route.target);
    const key = alias.toLowerCase();
    if (!alias || !target || seenAliases.has(key)) {
      continue;
    }
    seenAliases.add(key);
    routes.push({
      alias,
      target,
      enabled: route.enabled,
      source: 'configured',
      wildcard: alias.includes('*'),
    });
  }

  appendLegacyRoutes(routes, seenAliases, config?.custom_mapping ?? {}, 'legacy-custom');
  appendLegacyRoutes(routes, seenAliases, config?.anthropic_mapping ?? {}, 'legacy-anthropic');
  return routes;
}

export function getEnabledModelAliasMap(
  config: ProxyConfig | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    getConfiguredModelRoutes(config)
      .filter((route) => route.enabled)
      .map((route) => [route.alias, route.target]),
  );
}

@Injectable()
export class ModelRoutingService {
  normalizeGeminiModel(model: string): string {
    return normalizeModelId(model);
  }

  resolveTargetModel(model: string): string {
    return this.resolveModelRoute(model).targetModel;
  }

  resolveModelRoute(model: string): ModelRouteResolution {
    const normalizedModel = normalizeModelId(model);
    for (const route of getConfiguredModelRoutes(getServerConfig())) {
      const matches = route.wildcard
        ? toWildcardPattern(route.alias)?.test(normalizedModel) === true
        : route.alias.toLowerCase() === normalizedModel.toLowerCase();
      if (!matches) {
        continue;
      }
      if (!route.enabled) {
        return {
          requestedModel: model,
          normalizedModel,
          targetModel: normalizedModel,
          source: 'disabled',
          alias: route.alias,
          enabled: false,
          wildcard: route.wildcard,
        };
      }
      return {
        requestedModel: model,
        normalizedModel,
        targetModel: route.target,
        source: route.source,
        alias: route.alias,
        enabled: true,
        wildcard: route.wildcard,
      };
    }

    return {
      requestedModel: model,
      normalizedModel,
      targetModel: normalizedModel,
      source: 'canonical',
      enabled: true,
      wildcard: false,
    };
  }

  getConfiguredRoutes(): ConfiguredModelRoute[] {
    return getConfiguredModelRoutes(getServerConfig());
  }

  createModelSpecificHeaders(model: string | undefined): Record<string, string> {
    if (!model) {
      return {};
    }

    if (model.toLowerCase().includes('claude')) {
      return {
        'anthropic-beta':
          'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
      };
    }

    return {};
  }
}
