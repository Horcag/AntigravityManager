import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { AccountLeaseService } from './modules/account-lease/account-lease.service';
import { GeminiClient } from './modules/gemini/gemini-client.service';
import { GeminiController } from './modules/gemini/gemini.controller';
import { ProxyGuard } from './guards/proxy.guard';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import {
  IMAGE_QUOTA_REFRESH,
  OpenAIMediaController,
} from './modules/openai/media/openai-media.controller';
import { RateLimitTrackerService } from './modules/shared/services/rate-limit-tracker.service';
import { ModelRoutingService } from './modules/shared/services/model-routing.service';
import { ModelRouteMissJournalService } from './modules/shared/services/model-route-miss-journal.service';
import {
  ModelAvailabilityService,
  PROXY_MODEL_AVAILABILITY_PERSISTENCE,
  persistentAvailabilityAdapter,
} from './modules/shared/services/model-availability.service';
import { ProxyRetryService } from './modules/shared/services/proxy-retry.service';
import { GenerationConstraintsService } from './modules/shared/services/generation-constraints.service';
import { CountTokensService } from './modules/shared/services/count-tokens.service';
import { OpenAIResponsesSessionService } from './modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesStoreController } from './modules/openai/responses/openai-responses-store.controller';
import { SignatureStore } from '../antigravity/SignatureStore';
import { FILE_STORE_OPTIONS, FileContentStore } from './modules/files/file-content-store.service';
import { resolveFileStoreOptions } from './modules/files/file-store-location';
import { GeminiFilesController } from './modules/files/gemini-files.controller';
import { ClientFilesController } from './modules/files/client-files.controller';
import { UnimplementedRouteFilter } from './common/unimplemented-route.filter';
import { BATCH_RUNNER_OPTIONS, BatchRunnerService } from './modules/batch/batch-runner.service';
import { resolveBatchRunnerOptions } from './modules/batch/batch-store-location';
import { OpenAIBatchesController } from './modules/batch/openai-batches.controller';
import { AnthropicMessageBatchesController } from './modules/batch/anthropic-message-batches.controller';
import { GeminiOperationsController } from './modules/batch/gemini-operations.controller';
import { AnthropicCompleteController } from './modules/anthropic/anthropic-complete.controller';
import { ClientModelsController } from './modules/models/client-models.controller';

@Module({
  imports: [],
  controllers: [
    ProxyController,
    OpenAIMediaController,
    OpenAIResponsesStoreController,
    GeminiController,
    GeminiFilesController,
    ClientFilesController,
    OpenAIBatchesController,
    AnthropicMessageBatchesController,
    GeminiOperationsController,
    AnthropicCompleteController,
    ClientModelsController,
  ],
  providers: [
    // Answers an unrouted `/v1...` or `/v1beta...` request in the error shape of
    // the surface it was addressed to, instead of the framework's own 404.
    {
      provide: APP_FILTER,
      useClass: UnimplementedRouteFilter,
    },
    {
      provide: FILE_STORE_OPTIONS,
      useFactory: resolveFileStoreOptions,
    },
    FileContentStore,
    {
      provide: BATCH_RUNNER_OPTIONS,
      useFactory: resolveBatchRunnerOptions,
    },
    BatchRunnerService,
    RateLimitTrackerService,
    ModelRoutingService,
    {
      provide: PROXY_MODEL_AVAILABILITY_PERSISTENCE,
      useValue: persistentAvailabilityAdapter,
    },
    ModelAvailabilityService,
    ModelRouteMissJournalService,
    OpenAIResponsesSessionService,
    AccountLeaseService,
    ProxyRetryService,
    GenerationConstraintsService,
    SignatureStore,
    ProxyService,
    CountTokensService,
    GeminiClient,
    ProxyGuard,
    {
      provide: IMAGE_QUOTA_REFRESH,
      useValue: () => CloudMonitorService.poll(),
    },
  ],
  exports: [
    AccountLeaseService,
    RateLimitTrackerService,
    ModelRoutingService,
    ModelAvailabilityService,
    ProxyRetryService,
    GenerationConstraintsService,
    SignatureStore,
    ProxyService,
    CountTokensService,
    OpenAIResponsesSessionService,
    FileContentStore,
    BatchRunnerService,
  ],
})
export class ProxyModule {}
