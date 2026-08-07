import { describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';

vi.mock('ps-list', () => ({
  default: vi.fn().mockResolvedValue([]),
}));
import { ProxyModule } from '@/modules/proxy-gateway/server/proxy.module';
import {
  RateLimitTrackerService,
  RateLimitReason,
} from '@/modules/proxy-gateway/server/modules/shared/services/rate-limit-tracker.service';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { ModelAvailabilityService } from '@/modules/proxy-gateway/server/modules/shared/services/model-availability.service';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/modules/shared/services/proxy-retry.service';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/modules/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/modules/shared/services/model-routing.service';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request-exception';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

describe('Nest DI Proxy Foundation & State Ownership', () => {
  it('resolves singleton instances from Nest ProxyModule DI container', async () => {
    const appContext = await NestFactory.createApplicationContext(ProxyModule, {
      logger: false,
    });

    const rateLimitTracker1 = appContext.get(RateLimitTrackerService);
    const rateLimitTracker2 = appContext.get(RateLimitTrackerService);
    const accountLeaseService = appContext.get(AccountLeaseService);
    const modelAvailabilityService1 = appContext.get(ModelAvailabilityService);
    const modelAvailabilityService2 = appContext.get(ModelAvailabilityService);
    const proxyRetryService = appContext.get(ProxyRetryService);
    const generationConstraints = appContext.get(GenerationConstraintsService);
    const modelRoutingService = appContext.get(ModelRoutingService);
    const signatureStore1 = appContext.get(SignatureStore);
    const signatureStore2 = appContext.get(SignatureStore);
    const proxyService = appContext.get(ProxyService);

    expect(rateLimitTracker1).toBeDefined();
    expect(rateLimitTracker1).toBe(rateLimitTracker2);
    expect(modelAvailabilityService1).toBe(modelAvailabilityService2);
    expect(accountLeaseService.getRateLimitTracker()).toBe(rateLimitTracker1);
    expect(proxyService.accountLeaseService).toBe(accountLeaseService);
    expect(proxyService.generationConstraintsService).toBe(generationConstraints);
    expect(proxyService.proxyRetryService).toBe(proxyRetryService);
    expect(proxyService.customModelRoutingService).toBe(modelRoutingService);
    expect(signatureStore1).toBe(signatureStore2);
    expect(proxyService.signatureStore).toBe(signatureStore1);
    expect(proxyRetryService.getModelAvailabilityStore()).toBe(modelAvailabilityService1);

    await appContext.close();
  });

  it('demonstrates cross-service visibility between RateLimitTrackerService and AccountLeaseService', async () => {
    const appContext = await NestFactory.createApplicationContext(ProxyModule, {
      logger: false,
    });

    const rateLimitTracker = appContext.get(RateLimitTrackerService);
    const accountLeaseService = appContext.get(AccountLeaseService);

    const testAccountId = 'acc-di-test-1';
    const testModel = 'gemini-3.1-pro';

    expect(accountLeaseService.isRateLimited(testAccountId, testModel)).toBe(false);

    rateLimitTracker.setLockoutUntilIso(
      testAccountId,
      new Date(Date.now() + 60000).toISOString(),
      RateLimitReason.QuotaExhausted,
      testModel,
    );

    expect(accountLeaseService.isRateLimited(testAccountId, testModel)).toBe(true);

    rateLimitTracker.markModelSuccess(testAccountId, testModel);
    expect(accountLeaseService.isRateLimited(testAccountId, testModel)).toBe(false);

    await appContext.close();
  });

  it('demonstrates cross-service visibility between ProxyRetryService and ModelAvailabilityService', async () => {
    const appContext = await NestFactory.createApplicationContext(ProxyModule, {
      logger: false,
    });

    const proxyRetryService = appContext.get(ProxyRetryService);
    const modelAvailabilityService = appContext.get(ModelAvailabilityService);

    const testAccountId = 'acc-di-test-2';
    const imageModel = 'gemini-3-pro-image';

    await proxyRetryService.applyUpstreamPenalty(
      testAccountId,
      imageModel,
      new UpstreamRequestError({ status: 404, message: 'Requested model not found' }),
    );

    const snapshot = modelAvailabilityService.getSnapshot();
    const entry = snapshot.find(
      (e) => e.accountId === testAccountId && e.modelId === 'gemini-3-pro-image',
    );

    expect(entry).toBeDefined();
    expect(entry?.reason).toBe('model_not_supported');

    proxyRetryService.markUpstreamSuccess(testAccountId, imageModel);

    const clearedSnapshot = modelAvailabilityService.getSnapshot();
    const clearedEntry = clearedSnapshot.find(
      (e) => e.accountId === testAccountId && e.modelId === 'gemini-3-pro-image',
    );
    expect(clearedEntry).toBeUndefined();

    await appContext.close();
  });
});
