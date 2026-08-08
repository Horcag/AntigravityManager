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
import { SignatureStore } from '../antigravity/SignatureStore';

@Module({
  imports: [],
  controllers: [ProxyController, GeminiController],
  providers: [
    RateLimitTrackerService,
    ModelRoutingService,
    {
      provide: PROXY_MODEL_AVAILABILITY_PERSISTENCE,
      useValue: persistentAvailabilityAdapter,
    },
    ModelAvailabilityService,
    ModelRouteMissJournalService,
    AccountLeaseService,
    ProxyRetryService,
    GenerationConstraintsService,
    SignatureStore,
    ProxyService,
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
  ],
})
export class ProxyModule {}
