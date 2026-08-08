import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { AccountLeaseService } from './modules/account-lease/account-lease.service';
import { GeminiClient } from './modules/gemini/gemini-client.service';
import { GeminiController } from './modules/gemini/gemini.controller';
import { ProxyGuard } from './guards/proxy.guard';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { IMAGE_QUOTA_REFRESH } from './proxy.controller';
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

@Module({
  imports: [],
  controllers: [
    ProxyController,
    OpenAIResponsesStoreController,
    GeminiController,
    GeminiFilesController,
    ClientFilesController,
  ],
  providers: [
    {
      provide: FILE_STORE_OPTIONS,
      useFactory: resolveFileStoreOptions,
    },
    FileContentStore,
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
  ],
})
export class ProxyModule {}
