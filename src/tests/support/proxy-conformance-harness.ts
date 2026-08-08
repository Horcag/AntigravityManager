import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import {
  ProxyController,
  IMAGE_QUOTA_REFRESH,
} from '@/modules/proxy-gateway/server/proxy.controller';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/modules/shared/services/model-routing.service';
import { ModelAvailabilityService } from '@/modules/proxy-gateway/server/modules/shared/services/model-availability.service';

export interface ProxyConformanceService {
  handleAnthropicCountTokens(request: unknown): unknown;
  handleAnthropicMessages(request: unknown): unknown;
  handleChatCompletions(request: unknown, outputProtocol?: string): unknown;
  handleGeminiCountTokens(model: string, contents: unknown): unknown;
  handleGeminiGenerateContent(model: string, request: unknown): unknown;
  handleGeminiStreamGenerateContent(model: string, request: unknown): unknown;
}

export interface ProxyConformanceAppOptions {
  proxyService: ProxyConformanceService;
  accountTokens?: AccountLeaseTokenData[];
}

export function createAccountLeaseTokenFixture(
  overrides: Partial<AccountLeaseTokenData> = {},
): AccountLeaseTokenData {
  return {
    account_id: 'conformance-account',
    email: 'conformance@example.com',
    access_token: 'conformance-access-token',
    refresh_token: 'conformance-refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: 1_900_000_000,
    model_quotas: {
      'conformance-model': 100,
    },
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    ...overrides,
  };
}

function normalizeModelId(model: string): string {
  return model
    .replace(/^models\//iu, '')
    .trim()
    .toLowerCase();
}

export function createAccountLeaseServiceFixture(tokens: AccountLeaseTokenData[]) {
  const collectedModels = new Set(
    tokens.flatMap((token) => [
      ...Object.keys(token.model_quotas ?? {}),
      ...Object.keys(token.quota?.models ?? {}),
    ]),
  );

  return {
    getAllCollectedModels: () => new Set(collectedModels),
    getModelCatalogStatus: (model: string) =>
      [...collectedModels].some(
        (candidate) => normalizeModelId(candidate) === normalizeModelId(model),
      )
        ? 'known'
        : 'unknown_model',
    getModelRouteAvailability: (model: string) =>
      tokens.map((token) => {
        const normalizedModel = normalizeModelId(model);
        const advertised = [
          ...Object.keys(token.model_quotas ?? {}),
          ...Object.keys(token.quota?.models ?? {}),
        ]
          .map(normalizeModelId)
          .includes(normalizedModel);
        return {
          accountId: token.account_id,
          exact: advertised,
          quotaPercentage: advertised ? (token.model_quotas?.[model] ?? 100) : undefined,
          resolvedModel: model,
          status: advertised ? 'available' : 'unavailable',
        };
      }),
  };
}

export async function createProxyConformanceApp(
  options: ProxyConformanceAppOptions,
): Promise<NestFastifyApplication> {
  const accountLeaseService = createAccountLeaseServiceFixture(
    options.accountTokens ?? [createAccountLeaseTokenFixture()],
  );

  @Module({
    controllers: [ProxyController, GeminiController],
    providers: [
      { provide: ProxyService, useValue: options.proxyService },
      { provide: AccountLeaseService, useValue: accountLeaseService },
      { provide: ProxyGuard, useValue: { canActivate: () => true } },
      { provide: IMAGE_QUOTA_REFRESH, useValue: async () => undefined },
      { provide: ModelRoutingService, useValue: { getConfiguredRoutes: () => [] } },
      { provide: ModelAvailabilityService, useValue: { getSnapshot: () => [] } },
    ],
  })
  class ProxyConformanceModule {}

  const app = await NestFactory.create<NestFastifyApplication>(
    ProxyConformanceModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
