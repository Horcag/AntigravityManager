import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { CloudAccount } from '@/modules/cloud-account/types';
import { RateLimitTrackerService } from '../shared/services/rate-limit-tracker.service';
import {
  ACCOUNT_LEASE_ACCOUNT_STORE,
  ACCOUNT_LEASE_UPSTREAM,
  type AccountLeaseAccountStore,
  type AccountLeaseUpstream,
  cloudAccountStoreAdapter,
  googleAccountLeaseUpstreamAdapter,
} from './interfaces/account-lease-adapters';
import { AccountLeaseQuotaRefreshPolicy } from './policies/account-lease-quota-refresh-policy';
import { AccountLeaseTokenCache } from './stores/account-lease-token-cache';
import { AccountLeaseHydrationPolicy } from './policies/account-lease-hydration-policy';
import { AccountLeaseFulfillmentPolicy } from './policies/account-lease-fulfillment-policy';
import { AccountLeaseSelectionPolicy } from './policies/account-lease-selection-policy';
import { AccountLeaseModelPolicy } from './policies/account-lease-model-policy';
import {
  type AccountLeaseTokenData,
  normalizeModelId,
} from './interfaces/account-lease-token-types';
import {
  AccountLeaseLimitPolicy,
  type AccountLeaseUpstreamErrorParams,
} from './policies/account-lease-limit-policy';
import { AccountLeaseConfigPolicy } from './policies/account-lease-config-policy';
import { ModelAvailabilityService } from '../shared/services/model-availability.service';
import type { CatalogModelRoleIndex } from '../../../antigravity/ModelMapping';

interface GetNextTokenOptions {
  sessionKey?: string;
  excludeAccountIds?: string[];
  model?: string;
}

type TokenData = AccountLeaseTokenData;
type TokenEntry = [string, TokenData];
export type ModelCatalogStatus = 'known' | 'unknown_model' | 'catalog_unavailable';
export interface ModelRouteAccountAvailability {
  accountId: string;
  exact: boolean;
  resolvedModel: string;
  status: 'unknown' | 'available' | 'unavailable';
}

@Injectable()
export class AccountLeaseService implements OnModuleInit {
  private readonly logger = new Logger(AccountLeaseService.name);
  private readonly stickySessionTtlMs = 10 * 60 * 1000;
  private readonly rateLimitCooldownMs = 5 * 60 * 1000;
  private readonly forbiddenCooldownMs = 30 * 60 * 1000;

  private tokens: Map<string, TokenData> = new Map();
  private readonly configPolicy = new AccountLeaseConfigPolicy();
  private readonly quotaRefreshPolicy: AccountLeaseQuotaRefreshPolicy;
  private readonly tokenCache: AccountLeaseTokenCache;
  private readonly selectionPolicy = new AccountLeaseSelectionPolicy();
  private readonly hydrationPolicy: AccountLeaseHydrationPolicy;
  private readonly fulfillmentPolicy: AccountLeaseFulfillmentPolicy;
  private readonly modelPolicy: AccountLeaseModelPolicy;
  private readonly limitPolicy: AccountLeaseLimitPolicy;

  private readonly rateLimitTracker: RateLimitTrackerService;
  private readonly accountStore: AccountLeaseAccountStore;
  private readonly upstream: AccountLeaseUpstream;
  private readonly modelAvailabilityStore?: ModelAvailabilityService;

  constructor(
    @Inject(RateLimitTrackerService)
    rateLimitTracker: RateLimitTrackerService,
    @Optional()
    @Inject(ACCOUNT_LEASE_ACCOUNT_STORE)
    accountStore: AccountLeaseAccountStore = cloudAccountStoreAdapter,
    @Optional()
    @Inject(ACCOUNT_LEASE_UPSTREAM)
    upstream: AccountLeaseUpstream = googleAccountLeaseUpstreamAdapter,
    @Optional()
    @Inject(ModelAvailabilityService)
    modelAvailabilityStore?: ModelAvailabilityService,
  ) {
    this.rateLimitTracker = rateLimitTracker;
    this.accountStore = accountStore;
    this.upstream = upstream;
    this.modelAvailabilityStore = modelAvailabilityStore;

    this.quotaRefreshPolicy = new AccountLeaseQuotaRefreshPolicy({
      accountStore: this.accountStore,
      upstream: this.upstream,
      getTokenCache: () => this.tokens,
      setLockoutUntilIso: (accountId, resetTime, reason, model) =>
        this.rateLimitTracker.setLockoutUntilIso(accountId, resetTime, reason, model),
      clearRecoveredQuotaLocks: (accountId, recoveredModels, isAccountRecovered) =>
        this.limitPolicy.clearRecoveredQuotaLocks(accountId, recoveredModels, isAccountRecovered),
      logger: this.logger,
    });
    this.tokenCache = new AccountLeaseTokenCache({
      accountStore: this.accountStore,
      getTokenCache: () => this.tokens,
      logger: this.logger,
    });
    this.hydrationPolicy = new AccountLeaseHydrationPolicy({
      accountStore: this.accountStore,
      upstream: this.upstream,
      getTokenCache: () => this.tokens,
      logger: this.logger,
      persistTokenState: (accountId, tokenData) => this.persistTokenState(accountId, tokenData),
    });
    this.fulfillmentPolicy = new AccountLeaseFulfillmentPolicy({
      hydrationPolicy: this.hydrationPolicy,
      markRateLimitSuccess: (accountId) => this.rateLimitTracker.markSuccess(accountId),
      bindSession: (sessionKey, accountId, expiresAt) =>
        this.selectionPolicy.bindSession(sessionKey, accountId, expiresAt),
      stickySessionTtlMs: this.stickySessionTtlMs,
      resolveFallbackProjectId: () => this.configPolicy.resolveFallbackProjectId(),
      logger: this.logger,
    });
    this.modelPolicy = new AccountLeaseModelPolicy({
      getTokenCache: () => this.tokens,
      logger: this.logger,
    });
    this.limitPolicy = new AccountLeaseLimitPolicy({
      rateLimitTracker: this.rateLimitTracker,
      rateLimitCooldownMs: this.rateLimitCooldownMs,
      forbiddenCooldownMs: this.forbiddenCooldownMs,
      resolveAccountId: (accountIdOrEmail) => this.resolveAccountId(accountIdOrEmail),
      getCircuitBreakerBackoffSteps: () => this.configPolicy.getCircuitBreakerBackoffSteps(),
      refreshRealtimeQuotaAndReconcileLimit: (accountId, reason, model) =>
        this.quotaRefreshPolicy.refreshRealtimeQuotaAndReconcileLimit(accountId, reason, model),
      setPreciseLockoutFromCachedQuota: (accountId, reason, model) =>
        this.quotaRefreshPolicy.setPreciseLockoutFromCachedQuota(accountId, reason, model),
      logger: this.logger,
    });
  }

  private get accountCooldowns(): Map<string, number> {
    return this.limitPolicy.getAccountCooldowns();
  }

  public getRateLimitTracker(): RateLimitTrackerService {
    return this.rateLimitTracker;
  }

  private get shadowComparisonCount(): number {
    return this.selectionPolicy.getShadowComparisonCount();
  }

  private get noGoBlocked(): boolean {
    return this.selectionPolicy.isNoGoBlocked();
  }

  async onModuleInit() {
    await this.loadAccounts();
  }

  async loadAccounts(): Promise<number> {
    return this.tokenCache.loadAccounts();
  }

  async reloadAllAccounts(): Promise<number> {
    const count = await this.loadAccounts();
    this.clearAllRateLimits();
    this.clearAllSessions();
    return count;
  }

  async reloadAllAccountsOrThrow(): Promise<number> {
    const count = await this.tokenCache.loadAccountsOrThrow();
    this.clearAllRateLimits();
    this.clearAllSessions();
    return count;
  }

  clearAllSessions(): void {
    this.selectionPolicy.clearSessions();
  }

  clearAllRateLimits(): void {
    this.limitPolicy.clearAllRateLimits();
  }

  recordParityError(): void {
    this.selectionPolicy.recordParityError(this.configPolicy.getSelectionConfig(), this.logger);
  }

  setPreferredAccount(accountId?: string): void {
    this.configPolicy.setPreferredAccount(accountId);
  }

  isRateLimited(accountIdOrEmail: string, model?: string): boolean {
    return this.limitPolicy.isRateLimited(accountIdOrEmail, model);
  }

  markAsRateLimited(accountIdOrEmail: string) {
    this.limitPolicy.markAsRateLimited(accountIdOrEmail);
  }

  markAsForbidden(accountIdOrEmail: string) {
    this.limitPolicy.markAsForbidden(accountIdOrEmail);
  }

  markModelSuccess(accountIdOrEmail: string, model: string): void {
    this.limitPolicy.markModelSuccess(accountIdOrEmail, model);
  }

  getRemainingRateLimitWait(accountIdOrEmail: string, model?: string): number {
    const accountId = this.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
    return this.rateLimitTracker.getRemainingWaitSeconds(
      accountId,
      normalizeModelId(model) ?? model,
    );
  }

  async markFromUpstreamError(params: AccountLeaseUpstreamErrorParams): Promise<void> {
    await this.limitPolicy.markFromUpstreamError(params);
  }

  async getNextToken(options?: GetNextTokenOptions): Promise<CloudAccount | null> {
    try {
      if (this.tokens.size === 0) {
        await this.loadAccounts();
      }
      if (this.tokens.size === 0) {
        return null;
      }

      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);
      const sessionKey = options?.sessionKey?.trim();
      const model = options?.model;
      const excludedAccountIds = new Set(options?.excludeAccountIds ?? []);

      this.rateLimitTracker.cleanupExpired();

      const fullAccountPool = Array.from(this.tokens.entries());
      const modelCapableAccountPool = this.selectModelCapableAccounts(fullAccountPool, model);
      if (modelCapableAccountPool.length === 0) {
        this.logger.warn(`No account advertises requested model: ${model ?? 'unknown'}`);
        return null;
      }

      const filteredAccountPool = modelCapableAccountPool.filter(
        ([accountId]) => !excludedAccountIds.has(accountId),
      );
      if (filteredAccountPool.length === 0 && excludedAccountIds.size > 0) {
        this.logger.warn('Exclusion filter removed all accounts; retry pool is exhausted');
        return null;
      }

      const candidateAccountPool = filteredAccountPool;

      if (candidateAccountPool.length === 0) {
        this.logger.warn('No eligible account found after exclusion filtering');
        return null;
      }

      const selectedTokenEntry = await this.selectionPolicy.selectCandidate({
        allTokens: candidateAccountPool,
        sessionKey,
        model,
        now,
        accountCooldowns: this.accountCooldowns,
        rateLimitTracker: this.rateLimitTracker,
        config: this.configPolicy.getSelectionConfig(),
        logger: this.logger,
      });

      if (!selectedTokenEntry) {
        return null;
      }

      const [accountId, tokenData] = selectedTokenEntry;
      return this.finalizeSelectedToken(accountId, tokenData, nowSeconds, sessionKey);
    } catch (error) {
      this.logger.error('Failed to select the next account token', error);
      return null;
    }
  }

  private selectModelCapableAccounts(allTokens: TokenEntry[], model?: string): TokenEntry[] {
    if (!model) {
      return allTokens;
    }

    const exact: TokenEntry[] = [];
    const compatible: TokenEntry[] = [];
    for (const entry of allTokens) {
      const resolvedModel = this.modelPolicy.resolveDynamicModelForAccount(entry[0], model);
      const quotaPercentage = this.modelPolicy.getModelQuotaPercentageForAccount(
        entry[0],
        resolvedModel,
      );
      if (
        (quotaPercentage !== undefined && quotaPercentage <= 0) ||
        this.modelAvailabilityStore?.isUnavailable(entry[0], model) ||
        this.modelAvailabilityStore?.isUnavailable(entry[0], resolvedModel)
      ) {
        continue;
      }
      const exactAvailability = this.modelPolicy.getExactModelAvailabilityForAccount(
        entry[0],
        model,
      );
      if (exactAvailability === 'available') {
        exact.push(entry);
        continue;
      }

      const availability = this.modelPolicy.getModelAvailabilityForAccount(entry[0], model);
      if (availability === 'available') {
        compatible.push(entry);
      }
    }

    return [...exact, ...compatible];
  }

  public resetSelectionState(): void {
    this.selectionPolicy.resetSelectionState();
  }

  private async finalizeSelectedToken(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    return this.fulfillmentPolicy.finalizeSelectedToken({
      accountId,
      tokenData,
      nowSeconds,
      sessionKey,
    });
  }

  private async refreshSelectedTokenIfNeeded(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
  ): Promise<void> {
    await this.hydrationPolicy.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds);
  }

  private async refreshSelectedTokenLocked(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
  ): Promise<void> {
    await this.hydrationPolicy.refreshSelectedTokenLocked(accountId, tokenData, nowSeconds);
  }

  private async resolveProjectIdWithLock(
    accountId: string,
    tokenData: TokenData,
  ): Promise<string | undefined> {
    return this.hydrationPolicy.resolveProjectIdWithLock(accountId, tokenData);
  }

  private async runAccountLock<T>(
    locks: Map<string, Promise<T>>,
    accountId: string,
    createPromise: () => Promise<T>,
  ): Promise<T> {
    return this.hydrationPolicy.runAccountLock(locks, accountId, createPromise);
  }

  private syncTokenDataFromCache(accountId: string, tokenData: TokenData): void {
    this.hydrationPolicy.syncTokenDataFromCache(accountId, tokenData);
  }

  private async resolveProjectIdLocked(
    accountId: string,
    tokenData: TokenData,
  ): Promise<string | undefined> {
    return this.hydrationPolicy.resolveProjectIdLocked(accountId, tokenData);
  }

  private resolveAccountId(accountIdOrEmail: string): string | null {
    if (this.tokens.has(accountIdOrEmail)) {
      return accountIdOrEmail;
    }

    for (const [accountId, tokenData] of this.tokens.entries()) {
      if (tokenData.email === accountIdOrEmail) {
        return accountId;
      }
    }

    return null;
  }

  private async persistTokenState(accountId: string, tokenData: TokenData) {
    await this.hydrationPolicy.persistTokenState(accountId, tokenData);
  }

  getAccountCount(): number {
    return this.tokens.size;
  }

  private normalizeRefreshedOauthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return this.hydrationPolicy.normalizeRefreshedOauthClientKey(currentToken, refreshedClientKey);
  }

  getAllCollectedModels(): Set<string> {
    return this.modelPolicy.getAllCollectedModels();
  }

  getCatalogModelRoleIndex(): CatalogModelRoleIndex {
    return this.modelPolicy.getCatalogModelRoleIndex();
  }

  getModelCatalogStatus(model: string): ModelCatalogStatus {
    let hasCapabilityMetadata = false;
    for (const accountId of this.tokens.keys()) {
      const availability = this.modelPolicy.getModelAvailabilityForAccount(accountId, model);
      if (availability === 'available') {
        return 'known';
      }
      if (availability === 'unavailable') {
        hasCapabilityMetadata = true;
      }
    }
    return hasCapabilityMetadata ? 'unknown_model' : 'catalog_unavailable';
  }

  getModelRouteAvailability(model: string): ModelRouteAccountAvailability[] {
    return [...this.tokens.keys()].map((accountId) => {
      const resolvedModel = this.modelPolicy.resolveDynamicModelForAccount(accountId, model);
      const status = this.modelPolicy.getModelAvailabilityForAccount(accountId, model);
      const quotaPercentage = this.modelPolicy.getModelQuotaPercentageForAccount(
        accountId,
        resolvedModel,
      );
      return {
        accountId,
        exact:
          this.modelPolicy.getExactModelAvailabilityForAccount(accountId, model) === 'available',
        resolvedModel,
        status:
          status === 'available' &&
          ((quotaPercentage !== undefined && quotaPercentage <= 0) ||
            this.modelAvailabilityStore?.isUnavailable(accountId, model) ||
            this.modelAvailabilityStore?.isUnavailable(accountId, resolvedModel))
            ? 'unavailable'
            : status,
      };
    });
  }

  private getAvailableModelsFromToken(tokenData: TokenData): Set<string> {
    return this.modelPolicy.getAvailableModelsFromToken(tokenData);
  }

  resolveDynamicModelForAccount(accountId: string, mappedModel: string): string {
    return this.modelPolicy.resolveDynamicModelForAccount(accountId, mappedModel);
  }

  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined {
    return this.modelPolicy.getModelOutputLimitForAccount(accountId, modelName);
  }

  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined {
    return this.modelPolicy.getModelThinkingBudgetForAccount(accountId, modelName);
  }
}
