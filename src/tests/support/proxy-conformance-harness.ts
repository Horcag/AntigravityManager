import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';

import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';
import {
  IMAGE_QUOTA_REFRESH,
  OpenAIMediaController,
} from '@/modules/proxy-gateway/server/modules/openai/media/openai-media.controller';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/modules/shared/services/model-routing.service';
import { ModelAvailabilityService } from '@/modules/proxy-gateway/server/modules/shared/services/model-availability.service';
import {
  FILE_STORE_OPTIONS,
  FileContentStore,
} from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { GeminiFilesController } from '@/modules/proxy-gateway/server/modules/files/gemini-files.controller';
import { ClientFilesController } from '@/modules/proxy-gateway/server/modules/files/client-files.controller';
import { OpenAIResponsesStoreController } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-store.controller';
import { OpenAIResponsesSessionService } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesSessionStore } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';
import { OPENAI_MEDIA_MULTIPART_OPTIONS } from '@/modules/proxy-gateway/server/modules/openai/media/openai-media-request-contract';
import type { FileStoreOptions } from '@/modules/proxy-gateway/server/modules/files/file-store.types';
import { UnimplementedRouteFilter } from '@/modules/proxy-gateway/server/common/unimplemented-route.filter';
import {
  BATCH_RUNNER_OPTIONS,
  BatchRunnerService,
} from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import { OpenAIBatchesController } from '@/modules/proxy-gateway/server/modules/batch/openai-batches.controller';
import { AnthropicMessageBatchesController } from '@/modules/proxy-gateway/server/modules/batch/anthropic-message-batches.controller';
import { GeminiOperationsController } from '@/modules/proxy-gateway/server/modules/batch/gemini-operations.controller';
import { AnthropicCompleteController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic-complete.controller';
import { ClientModelsController } from '@/modules/proxy-gateway/server/modules/models/client-models.controller';
import type { BatchRunnerOptions } from '@/modules/proxy-gateway/server/modules/batch/batch-job.types';
import { registerProxyBodyParsers } from '@/server/proxy-body-parsers';

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
  /** Overrides for the local file store; a fresh temp directory by default. */
  fileStore?: FileStoreOptions;
  /** Overrides for the batch runner; in-memory with concurrency 2 by default. */
  batchRunner?: BatchRunnerOptions;
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
    getCatalogModelRoleIndex: () => undefined,
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

  const fileStoreOptions: FileStoreOptions = {
    rootDirectory: mkdtempSync(join(tmpdir(), 'agm-files-')),
    sweepIntervalMs: 0,
    ...options.fileStore,
  };

  @Module({
    controllers: [
      ProxyController,
      OpenAIMediaController,
      GeminiController,
      GeminiFilesController,
      ClientFilesController,
      OpenAIResponsesStoreController,
      OpenAIBatchesController,
      AnthropicMessageBatchesController,
      GeminiOperationsController,
      AnthropicCompleteController,
      ClientModelsController,
    ],
    providers: [
      // Registered exactly as ProxyModule does, so conformance tests see the
      // same answer for an unserved route the real server gives.
      { provide: APP_FILTER, useClass: UnimplementedRouteFilter },
      { provide: ProxyService, useValue: options.proxyService },
      // The in-memory store the controller already falls back to when no
      // durable service is bound, so behaviour is unchanged by binding it.
      { provide: OpenAIResponsesSessionService, useValue: OpenAIResponsesSessionStore },
      {
        provide: BATCH_RUNNER_OPTIONS,
        useValue: { maxConcurrency: 2, ...options.batchRunner },
      },
      BatchRunnerService,
      { provide: AccountLeaseService, useValue: accountLeaseService },
      { provide: ProxyGuard, useValue: { canActivate: () => true } },
      { provide: IMAGE_QUOTA_REFRESH, useValue: async () => undefined },
      { provide: ModelRoutingService, useValue: { getConfiguredRoutes: () => [] } },
      { provide: ModelAvailabilityService, useValue: { getSnapshot: () => [] } },
      { provide: FILE_STORE_OPTIONS, useValue: fileStoreOptions },
      FileContentStore,
    ],
  })
  class ProxyConformanceModule {}

  const adapter = new FastifyAdapter();

  const app = await NestFactory.create<NestFastifyApplication>(ProxyConformanceModule, adapter, {
    logger: false,
  });
  await app.register(fastifyMultipart, OPENAI_MEDIA_MULTIPART_OPTIONS);
  await app.init();
  // Same call `main.ts` makes at the same point in the boot sequence, so a
  // conformance test parses a request the way the shipped server does.
  registerProxyBodyParsers(adapter.getInstance());
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
