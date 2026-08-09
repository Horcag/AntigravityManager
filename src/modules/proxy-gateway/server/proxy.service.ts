import { Inject, Injectable } from '@nestjs/common';
import { isString } from 'lodash-es';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from './modules/account-lease/account-lease.service';
import { GeminiClient } from './modules/gemini/gemini-client.service';
import { GenerationConstraintsService } from './modules/shared/services/generation-constraints.service';
import { ProxyRetryService } from './modules/shared/services/proxy-retry.service';
import { ModelRoutingService } from './modules/shared/services/model-routing.service';
import { ModelRouteMissJournalService } from './modules/shared/services/model-route-miss-journal.service';
import {
  CountTokensService,
  type GeminiCountTokensResult,
} from './modules/shared/services/count-tokens.service';
import { Observable } from 'rxjs';
import {
  createGeminiSseObservable,
  type GeminiSseDiagnostics,
} from './modules/gemini/gemini-sse-decoder';
import {
  attachUpstreamResponseMetadata,
  getUpstreamResponseMetadata,
} from './common/upstream-response-metadata';
import { sanitizeGeminiResponse } from './modules/gemini/gemini-wire';
import { transformClaudeRequestIn } from '../antigravity/ClaudeRequestMapper';
import { requestsWebSearch } from '../antigravity/claude-request-web-search';
import {
  WEB_SEARCH_ROLE,
  runWebSearchSubCall,
  withWebSearchContext,
} from './modules/gemini/web-search-sub-call';
import { transformResponse } from '../antigravity/ClaudeResponseMapper';
import { type StreamingSignatureState } from '../antigravity/ClaudeStreamingMapper';
import {
  ClaudeRequest,
  ClaudeResponse,
  type GeminiContent,
  GeminiInternalRequest,
  type GeminiPart,
} from '../antigravity/types';
import { applyOpenAIJsonObjectFence } from './modules/openai/chat/openai-json-object-fence';
import { SignatureStore } from '../antigravity/SignatureStore';
import {
  AnthropicChatRequest,
  AnthropicChatResponse,
  AnthropicCountTokensRequest,
  AnthropicCountTokensResponse,
  GeminiRequest,
  GeminiResponse,
  OpenAIChatRequest,
  OpenAIChatResponse,
} from './common/interfaces/request-interfaces';
import { resolveRequestUserAgent } from './common/utils/request-user-agent';
import {
  applyAnthropicModelVariant,
  applyOpenAIModelVariant,
  rebindAnthropicModelVariant,
  rebindOpenAIModelVariant,
} from './modules/shared/services/model-variant-request.service';
import { safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';
import { BaseProxyService } from '@/modules/proxy-gateway/server/common/base-proxy.service';
import { ModelRouteError } from './common/exceptions/model-route-exception';
import { createNoAvailableAccountError } from './common/model-route-errors';
import { attachModelRouteMetadata } from './common/model-route-metadata';
import { executeProjectContextFallback } from './common/project-context-fallback';
import {
  processAnthropicInternalStream,
  type AnthropicInternalStreamRuntime,
} from './common/streaming/anthropic-internal-stream';
import {
  processStreamResponse,
  type OpenAIChatStreamRuntime,
  type OpenAIStreamContract,
} from './common/streaming/openai-chat-internal-stream';
import { processResponsesStreamResponse } from './common/streaming/openai-responses-internal-stream';
import {
  createSyntheticOpenAIStream,
  createSyntheticResponsesStream,
} from './common/streaming/synthetic-openai-streams';
import {
  extractAnthropicSessionKey,
  toAnthropicChatResponse,
  toClaudeRequest,
} from './modules/anthropic/anthropic-message-conversion';
import {
  convertOpenAIToClaude,
  extractOpenAISessionKey,
  extractOpenAIToolNames,
} from './modules/openai/chat/openai-claude-conversion';
import {
  convertClaudeToOpenAIResponse,
  convertGeminiToOpenAIResponse,
} from './modules/openai/chat/openai-chat-response-conversion';
import {
  createGeminiInternalRequest,
  toInternalGeminiRequest,
} from './modules/gemini/gemini-internal-request';

type OpenAIOutputProtocol = 'chat-completions' | 'responses';

interface WebSearchSubCallResult {
  request: ClaudeRequest;
  /** Set only when a separate search call actually ran. */
  webSearchModel?: string;
}

@Injectable()
export class ProxyService extends BaseProxyService {
  constructor(
    @Inject(AccountLeaseService) readonly accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) readonly geminiClient: GeminiClient,
    @Inject(GenerationConstraintsService)
    readonly generationConstraintsService: GenerationConstraintsService,
    @Inject(ProxyRetryService) readonly proxyRetryService: ProxyRetryService,
    @Inject(ModelRoutingService) readonly customModelRoutingService: ModelRoutingService,
    @Inject(ModelRouteMissJournalService)
    readonly modelRouteMissJournalService: ModelRouteMissJournalService,
    @Inject(SignatureStore) readonly signatureStore: SignatureStore,
    @Inject(CountTokensService) readonly countTokensService: CountTokensService,
  ) {
    super(
      accountLeaseService,
      geminiClient,
      generationConstraintsService,
      proxyRetryService,
      customModelRoutingService,
    );
  }

  private createNoAvailableAccountError(model: string): ModelRouteError {
    return createNoAvailableAccountError({
      accountLeaseService: this.accountLeaseService,
      missJournal: this.modelRouteMissJournalService,
      model,
    });
  }

  /**
   * Serves a request that asks for web search *and* client tools.
   *
   * `v1internal` rejects both in one `generateContent`, so the search runs as
   * its own unary call against a model from the provider's `web_search` role
   * and its grounded answer is folded into the request that follows. Requests
   * that do not hit that combination are returned untouched; a request that
   * does hit it and cannot be served fails loudly instead of losing the search.
   */
  private async applyWebSearchSubCall(
    claudeRequest: ClaudeRequest,
    servedModel: string,
    token: CloudAccount,
    deadlineAt: number,
    projectId: string,
    userAgent: string,
  ): Promise<WebSearchSubCallResult> {
    const outcome = await runWebSearchSubCall({
      claudeRequest,
      servedModel,
      getRoleModelIds: () => this.accountLeaseService.getModelIdsForRole?.(WEB_SEARCH_ROLE) ?? [],
      projectId,
      userAgent,
      generate: (body) =>
        this.geminiClient.generateInternal(
          body,
          token.token.access_token,
          token.token.upstream_proxy_url,
          this.createModelSpecificHeaders(body.model),
          deadlineAt,
        ),
    });

    if (!outcome) {
      return { request: claudeRequest };
    }

    this.logger.log(
      `[Web-Search] separate search call model=${outcome.model} grounded=${outcome.context !== null}`,
    );
    return {
      request: outcome.context
        ? withWebSearchContext(claudeRequest, outcome.context)
        : claudeRequest,
      // Reported through x-antigravity-web-search-model so the caller can see
      // which model actually ran the search, like every other resolution here.
      webSearchModel: outcome.model,
    };
  }

  private attachRouteMetadata<T extends object>(
    value: T,
    requestedModel: string,
    resolvedModel: string,
    servedModel: string | undefined,
    routeSource: string,
    webSearchModel?: string,
  ): T {
    return attachModelRouteMetadata(value, {
      requestedModel,
      resolvedModel,
      servedModel,
      routeSource,
      webSearchModel,
    });
  }

  // --- Token Counting Handlers ---

  handleGeminiCountTokens(
    model: string,
    contents: GeminiContent[],
  ): Promise<GeminiCountTokensResult> {
    return this.countTokensService.countGeminiTokens(model, contents);
  }

  handleAnthropicCountTokens(
    request: AnthropicCountTokensRequest,
  ): Promise<AnthropicCountTokensResponse> {
    return this.countTokensService.countAnthropicTokens(request);
  }

  // --- Anthropic Handlers ---

  async handleAnthropicMessages(
    request: AnthropicChatRequest,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    const route = this.modelRoutingPolicy.resolveModelRoute(request.model);
    const appliedVariantRequest = applyAnthropicModelVariant({
      ...request,
      model: route.targetModel,
    });
    const routedRequest = appliedVariantRequest.request;
    const sessionKey = extractAnthropicSessionKey(request);
    const deadlineAt = this.createRequestDeadline();

    const targetModel = routedRequest.model;
    const extraHeaders = this.createModelSpecificHeaders(targetModel);
    this.logger.log(
      `Anthropic request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}`,
    );

    // Retry loop
    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(
        i,
        maxRetries,
        'Anthropic',
        retryState.graceRetryToken !== null,
        deadlineAt,
      );

      const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
      if (!token) {
        throw this.createNoAvailableAccountError(targetModel);
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );
      const effectiveVariantRequest = rebindAnthropicModelVariant(
        appliedVariantRequest,
        effectiveTargetModel,
      );
      const accountRequest = effectiveVariantRequest.request;
      const accountTargetModel = effectiveVariantRequest.variant
        ? accountRequest.model
        : effectiveTargetModel;
      const baseClaudeRequest = this.toClaudeRequest(accountRequest, sessionKey);
      const webSearch = requestsWebSearch(baseClaudeRequest);
      let claudeRequest: ClaudeRequest | null = null;
      let webSearchModel: string | undefined;

      try {
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        // Reused by the project-context fallback below so the search runs once.
        const searched = await this.applyWebSearchSubCall(
          baseClaudeRequest,
          accountTargetModel,
          token,
          deadlineAt,
          projectId,
          requestUserAgent,
        );
        claudeRequest = searched.request;
        webSearchModel = searched.webSearchModel;
        const geminiBody = transformClaudeRequestIn(
          claudeRequest,
          projectId,
          requestUserAgent,
          accountTargetModel,
          { accountId: token.id, store: this.signatureStore },
        );
        this.applyInternalGenerationConstraints(
          geminiBody,
          geminiBody.model,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
        );

        if (request.stream) {
          const stream = await this.geminiClient.streamGenerateInternal(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
            deadlineAt,
          );
          this.markUpstreamSuccess(token.id, geminiBody.model);
          return this.attachRouteMetadata(
            this.processAnthropicInternalStream(
              stream,
              this.createSignatureState(token.id, geminiBody.model),
              geminiBody.model,
              webSearch,
              claudeRequest.stop_sequences,
            ),
            request.model,
            targetModel,
            geminiBody.model,
            route.source,
            webSearchModel,
          );
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
            deadlineAt,
          );
          this.markUpstreamSuccess(token.id, geminiBody.model);
          const anthropicResponse = this.toAnthropicChatResponse(
            transformResponse(response, this.createSignatureState(token.id, geminiBody.model), {
              webSearch,
              stopSequences: claudeRequest.stop_sequences,
            }),
            geminiBody.model,
          );
          return this.attachRouteMetadata(
            anthropicResponse,
            request.model,
            targetModel,
            anthropicResponse.model,
            route.source,
            webSearchModel,
          );
        }
      } catch (error) {
        const fallbackResult = await executeProjectContextFallback({
          error,
          token,
          retryState,
          model: accountTargetModel,
          isProjectContextError: (errorMessage) => this.isProjectContextError(errorMessage),
          onProjectContextError: (errorMessage) =>
            this.logger.warn(
              `Anthropic request hit project context issue, retrying without project: ${errorMessage}`,
            ),
          prepareGraceRetry: (retryError) =>
            appliedVariantRequest.variant
              ? Promise.resolve(false)
              : this.prepareGraceRetry(retryState, token, retryError, 'Anthropic'),
          applyUpstreamPenalty: (accountId, model, retryError) =>
            this.applyUpstreamPenalty(accountId, model, retryError),
          onFallback: async () => {
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(
              claudeRequest ?? baseClaudeRequest,
              '',
              requestUserAgent,
              accountTargetModel,
              { accountId: token.id, store: this.signatureStore },
            );
            this.applyInternalGenerationConstraints(
              fallbackBody,
              fallbackBody.model,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
            );
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
                deadlineAt,
              );
              this.markUpstreamSuccess(token.id, fallbackBody.model);
              return this.attachRouteMetadata(
                this.processAnthropicInternalStream(
                  stream,
                  this.createSignatureState(token.id, fallbackBody.model),
                  fallbackBody.model,
                  webSearch,
                  (claudeRequest ?? baseClaudeRequest).stop_sequences,
                ),
                request.model,
                targetModel,
                fallbackBody.model,
                route.source,
                webSearchModel,
              );
            }

            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              deadlineAt,
            );
            this.markUpstreamSuccess(token.id, fallbackBody.model);
            const anthropicResponse = this.toAnthropicChatResponse(
              transformResponse(response, this.createSignatureState(token.id, fallbackBody.model), {
                webSearch,
                stopSequences: (claudeRequest ?? baseClaudeRequest).stop_sequences,
              }),
              fallbackBody.model,
            );
            return this.attachRouteMetadata(
              anthropicResponse,
              request.model,
              targetModel,
              anthropicResponse.model,
              route.source,
              webSearchModel,
            );
          },
        });
        if (fallbackResult.status === 'returned') {
          return fallbackResult.value;
        }
        lastError = fallbackResult.lastError;
        if (fallbackResult.shouldRetry) {
          continue;
        }
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private processAnthropicInternalStream(
    upstreamStream: NodeJS.ReadableStream,
    signatureState: StreamingSignatureState,
    fallbackModel: string,
    webSearch = false,
    stopSequences?: readonly string[],
  ): Observable<string> {
    return processAnthropicInternalStream(this.streamRuntime(), upstreamStream, {
      fallbackModel,
      signatureState,
      stopSequences,
      webSearch,
    });
  }

  /**
   * The service capabilities the SSE translators borrow.
   *
   * Built per stream so the translators stay plain functions while the idle
   * timeout policy, logging and Cloud Code preamble decision keep living here.
   */
  private streamRuntime(): OpenAIChatStreamRuntime & AnthropicInternalStreamRuntime {
    return {
      logger: this.logger,
      createStreamIdleTimer: (upstreamStream, label, onIdle) =>
        this.createStreamIdleTimer(upstreamStream, label, onIdle),
      isGeminiPart: (value): value is GeminiPart => this.isGeminiPart(value),
      shouldEmitCloudCodeMeta: () => this.shouldEmitCloudCodeMeta(),
      createCloudCodeMetaChunk: (traceId) => this.createCloudCodeMetaChunk(traceId),
      createCloudCodeTraceId: () => this.createCloudCodeTraceId(),
    };
  }

  // --- OpenAI / Universal Handlers ---
  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
  ): Promise<GeminiResponse> {
    const normalizedModel = this.normalizeGeminiModel(model);
    const deadlineAt = this.createRequestDeadline();
    const route = this.modelRoutingPolicy.resolveModelRoute(normalizedModel);
    const targetModel = route.targetModel;
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log(
      `Gemini generate request received: model=${normalizedModel}, mappedModel=${targetModel}`,
    );

    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(
        i,
        maxRetries,
        'Gemini',
        retryState.graceRetryToken !== null,
        deadlineAt,
      );

      const token = await this.selectRetryToken(retryState, targetModel);
      if (!token) {
        throw this.createNoAvailableAccountError(targetModel);
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );

      try {
        const requestUserAgent = await resolveRequestUserAgent();
        const internalBody = this.createGeminiInternalRequest(
          effectiveTargetModel,
          request,
          token.token.project_id ?? '',
          'generate-content',
          requestUserAgent,
        );
        this.applyInternalGenerationConstraints(internalBody, effectiveTargetModel, token.id);

        const response = await this.generateInternalWithStreamFallback(
          internalBody,
          token.token.access_token,
          token.token.upstream_proxy_url,
          extraHeaders,
          deadlineAt,
        );

        this.markUpstreamSuccess(token.id, effectiveTargetModel);
        const normalizedResponse = this.normalizeGeminiGenerateResponse(
          token.id,
          response,
          effectiveTargetModel,
        );
        return this.attachRouteMetadata(
          normalizedResponse,
          model,
          targetModel,
          isString(normalizedResponse.modelVersion)
            ? normalizedResponse.modelVersion
            : effectiveTargetModel,
          route.source,
        );
      } catch (err) {
        const fallbackResult = await executeProjectContextFallback({
          error: err,
          token,
          retryState,
          model: effectiveTargetModel,
          isProjectContextError: (errorMessage) => this.isProjectContextError(errorMessage),
          onProjectContextError: (errorMessage) =>
            this.logger.warn(
              `Gemini request hit project context issue, retrying without project: ${errorMessage}`,
            ),
          prepareGraceRetry: (retryError) =>
            this.prepareGraceRetry(retryState, token, retryError, 'Gemini'),
          applyUpstreamPenalty: (accountId, model, retryError) =>
            this.applyUpstreamPenalty(accountId, model, retryError),
          onFallback: async () => {
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = this.createGeminiInternalRequest(
              effectiveTargetModel,
              request,
              '',
              'generate-content',
              requestUserAgent,
            );
            this.applyInternalGenerationConstraints(fallbackBody, effectiveTargetModel, token.id);
            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              deadlineAt,
            );
            this.markUpstreamSuccess(token.id, effectiveTargetModel);
            const normalizedResponse = this.normalizeGeminiGenerateResponse(
              token.id,
              response,
              effectiveTargetModel,
            );
            return this.attachRouteMetadata(
              normalizedResponse,
              model,
              targetModel,
              isString(normalizedResponse.modelVersion)
                ? normalizedResponse.modelVersion
                : effectiveTargetModel,
              route.source,
            );
          },
        });
        if (fallbackResult.status === 'returned') {
          return fallbackResult.value;
        }
        lastError = fallbackResult.lastError;
        if (fallbackResult.shouldRetry) {
          continue;
        }
      }
    }

    throw lastError || new Error('Gemini request failed after retries');
  }

  async handleGeminiStreamGenerateContent(
    model: string,
    request: GeminiRequest,
  ): Promise<Observable<string>> {
    const normalizedModel = this.normalizeGeminiModel(model);
    const deadlineAt = this.createRequestDeadline();
    const route = this.modelRoutingPolicy.resolveModelRoute(normalizedModel);
    const targetModel = route.targetModel;
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log(
      `Gemini stream request received: model=${normalizedModel}, mappedModel=${targetModel}`,
    );

    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(
        i,
        maxRetries,
        'Gemini stream',
        retryState.graceRetryToken !== null,
        deadlineAt,
      );

      const token = await this.selectRetryToken(retryState, targetModel);
      if (!token) {
        throw this.createNoAvailableAccountError(targetModel);
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );

      try {
        const requestUserAgent = await resolveRequestUserAgent();
        const internalBody = this.createGeminiInternalRequest(
          effectiveTargetModel,
          request,
          token.token.project_id ?? '',
          'generate-content',
          requestUserAgent,
        );
        this.applyInternalGenerationConstraints(internalBody, effectiveTargetModel, token.id);

        const stream = await this.geminiClient.streamGenerateInternal(
          internalBody,
          token.token.access_token,
          token.token.upstream_proxy_url,
          extraHeaders,
          deadlineAt,
        );
        this.markUpstreamSuccess(token.id, effectiveTargetModel);
        return this.attachRouteMetadata(
          this.passthroughSseStream(stream, token.id),
          model,
          targetModel,
          effectiveTargetModel,
          route.source,
        );
      } catch (err) {
        const fallbackResult = await executeProjectContextFallback({
          error: err,
          token,
          retryState,
          model: effectiveTargetModel,
          isProjectContextError: (errorMessage) => this.isProjectContextError(errorMessage),
          onProjectContextError: (errorMessage) =>
            this.logger.warn(
              `Gemini stream request hit project context issue, retrying without project: ${errorMessage}`,
            ),
          prepareGraceRetry: (retryError) =>
            this.prepareGraceRetry(retryState, token, retryError, 'Gemini stream'),
          applyUpstreamPenalty: (accountId, model, retryError) =>
            this.applyUpstreamPenalty(accountId, model, retryError),
          onFallback: async () => {
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = this.createGeminiInternalRequest(
              effectiveTargetModel,
              request,
              '',
              'generate-content',
              requestUserAgent,
            );
            this.applyInternalGenerationConstraints(fallbackBody, effectiveTargetModel, token.id);
            const stream = await this.geminiClient.streamGenerateInternal(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              deadlineAt,
            );
            this.markUpstreamSuccess(token.id, effectiveTargetModel);
            return this.attachRouteMetadata(
              this.passthroughSseStream(stream, token.id),
              model,
              targetModel,
              effectiveTargetModel,
              route.source,
            );
          },
        });
        if (fallbackResult.status === 'returned') {
          return fallbackResult.value;
        }
        lastError = fallbackResult.lastError;
        if (fallbackResult.shouldRetry) {
          continue;
        }
      }
    }

    throw lastError || new Error('Gemini stream request failed after retries');
  }

  private passthroughSseStream(
    upstreamStream: NodeJS.ReadableStream,
    accountId?: string,
  ): Observable<string> {
    return createGeminiSseObservable(upstreamStream, undefined, {
      onDiagnostics: (diagnostics) => this.recordGeminiStreamDiagnostics(accountId, diagnostics),
    });
  }

  /**
   * The response headers are already on the wire by the time a stream ends, so the streamed
   * `traceId` goes to the log instead and the credit fields go where quota lives.
   */
  private recordGeminiStreamDiagnostics(
    accountId: string | undefined,
    diagnostics: GeminiSseDiagnostics,
  ): void {
    const upstreamMetadata = diagnostics.upstreamMetadata;
    if (!upstreamMetadata) {
      return;
    }

    if (accountId) {
      this.accountLeaseService.recordUpstreamCredits(accountId, upstreamMetadata);
    }
    if (upstreamMetadata.traceId) {
      this.logger.debug(
        `Gemini stream upstream traceId=${upstreamMetadata.traceId}, skippedFrames=${diagnostics.skippedFrames}`,
      );
    }
  }

  private normalizeGeminiModel(model: string): string {
    return this.modelRoutingPolicy.normalizeGeminiModel(model);
  }

  private createGeminiInternalRequest(
    model: string,
    request: GeminiRequest,
    projectId: string | undefined,
    requestType: string,
    requestUserAgent: string,
  ): GeminiInternalRequest {
    return createGeminiInternalRequest({
      requestId: this.createOfficialRequestId(),
      model,
      request,
      projectId,
      requestType,
      requestUserAgent,
    });
  }

  /**
   * Strips transport metadata from the wire payload but keeps the `v1internal` envelope fields on
   * the carrier, so the controller can still emit `traceId` and the account's credit balance stays
   * current between quota refreshes.
   */
  private normalizeGeminiGenerateResponse(
    accountId: string,
    response: GeminiResponse,
    fallbackModelVersion: string,
  ): GeminiResponse {
    const upstreamMetadata = getUpstreamResponseMetadata(response);
    const normalized = sanitizeGeminiResponse({
      ...response,
      modelVersion: response.modelVersion ?? fallbackModelVersion,
    });
    if (!upstreamMetadata) {
      return normalized;
    }

    this.accountLeaseService.recordUpstreamCredits(accountId, upstreamMetadata);
    return attachUpstreamResponseMetadata(normalized, upstreamMetadata);
  }

  /**
   * `response_format: {"type":"json_object"}` reaches upstream as
   * `responseMimeType: "application/json"`, which still answers inside a
   * markdown fence. The fence is removed on the way out, under the proof
   * obligation documented in `openai-json-object-fence.ts`; every other request
   * is returned exactly as generated.
   */
  async handleChatCompletions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const result = await this.generateOpenAIChatCompletion(request, outputProtocol);
    return applyOpenAIJsonObjectFence(request, result, outputProtocol);
  }

  private async generateOpenAIChatCompletion(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol,
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const route = this.modelRoutingPolicy.resolveModelRoute(request.model);
    const appliedVariantRequest = applyOpenAIModelVariant({
      ...request,
      model: route.targetModel,
    });
    const routedRequest = appliedVariantRequest.request;
    const sessionKey = extractOpenAISessionKey(request);
    const clientToolNames = extractOpenAIToolNames(routedRequest.tools);
    const deadlineAt = this.createRequestDeadline();

    const targetModel = routedRequest.model;
    let webSearchModel: string | undefined;
    const attachRoute = <T extends object>(value: T, servedModel: string | undefined): T =>
      this.attachRouteMetadata(
        value,
        request.model,
        targetModel,
        servedModel,
        route.source,
        webSearchModel,
      );
    const extraHeaders = this.createModelSpecificHeaders(targetModel);
    this.logger.log(
      `OpenAI-compatible request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}`,
    );

    // Retry loop for account selection
    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(
        i,
        maxRetries,
        'OpenAI-compatible',
        retryState.graceRetryToken !== null,
        deadlineAt,
      );

      // 1. Get Token
      const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
      if (!token) {
        throw this.createNoAvailableAccountError(targetModel);
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );
      const effectiveVariantRequest = rebindOpenAIModelVariant(
        appliedVariantRequest,
        effectiveTargetModel,
      );
      const accountRequest = effectiveVariantRequest.request;
      const accountTargetModel = effectiveVariantRequest.variant
        ? accountRequest.model
        : effectiveTargetModel;
      const baseClaudeRequest = this.convertOpenAIToClaude(accountRequest, sessionKey);
      const webSearch = requestsWebSearch(baseClaudeRequest);
      let searchedClaudeRequest: ClaudeRequest | null = null;

      try {
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        // Reused by the project-context fallback below so the search runs once.
        const searched = await this.applyWebSearchSubCall(
          baseClaudeRequest,
          accountTargetModel,
          token,
          deadlineAt,
          projectId,
          requestUserAgent,
        );
        searchedClaudeRequest = searched.request;
        webSearchModel = searched.webSearchModel;
        const claudeRequest = searchedClaudeRequest;
        const geminiBody = transformClaudeRequestIn(
          claudeRequest,
          projectId,
          requestUserAgent,
          accountTargetModel,
          { accountId: token.id, store: this.signatureStore },
        );
        this.applyInternalGenerationConstraints(
          geminiBody,
          geminiBody.model,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
        );

        // Use v1internal API (same as Anthropic handler)
        if (request.stream) {
          try {
            const stream = await this.geminiClient.streamGenerateInternal(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              deadlineAt,
            );
            this.markUpstreamSuccess(token.id, geminiBody.model);
            return attachRoute(
              this.createOpenAIProtocolStream(
                stream,
                geminiBody.model,
                outputProtocol,
                clientToolNames,
                this.createSignatureState(token.id, geminiBody.model),
                this.createOpenAIStreamContract(request, webSearch),
              ),
              geminiBody.model,
            );
          } catch (streamError) {
            this.logger.warn(
              `Stream path failed for model=${request.model}; falling back to non-stream generation: ${
                streamError instanceof Error ? streamError.message : String(streamError)
              }`,
            );

            const response = await this.generateInternalWithStreamFallback(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              deadlineAt,
            );
            this.markUpstreamSuccess(token.id, geminiBody.model);
            this.logger.log(
              `Upstream response snippet after stream fallback: ${safeStringifyPacket(response).substring(0, 500)}`,
            );
            const openaiResponse = this.convertGeminiToOpenAIResponse(
              response,
              isString(response.modelVersion) ? response.modelVersion : geminiBody.model,
              clientToolNames,
              this.createSignatureState(token.id, geminiBody.model),
              this.resolveOpenAIServiceTier(request.service_tier),
              request.top_logprobs,
              webSearch,
            );
            const syntheticStream =
              outputProtocol === 'responses'
                ? this.createSyntheticResponsesStream(openaiResponse, clientToolNames)
                : this.createSyntheticOpenAIStream(
                    openaiResponse,
                    this.createOpenAIStreamContract(request, webSearch),
                  );
            return attachRoute(syntheticStream, openaiResponse.model);
          }
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
            deadlineAt,
          );
          this.markUpstreamSuccess(token.id, geminiBody.model);
          this.logger.log(
            `Upstream response snippet (non-stream): ${safeStringifyPacket(response).substring(0, 500)}`,
          );
          const openaiResponse = this.convertGeminiToOpenAIResponse(
            response,
            isString(response.modelVersion) ? response.modelVersion : geminiBody.model,
            clientToolNames,
            this.createSignatureState(token.id, geminiBody.model),
            this.resolveOpenAIServiceTier(request.service_tier),
            request.top_logprobs,
            webSearch,
          );
          return attachRoute(openaiResponse, openaiResponse.model);
        }
      } catch (err) {
        const fallbackResult = await executeProjectContextFallback({
          error: err,
          token,
          retryState,
          model: accountTargetModel,
          isProjectContextError: (errorMessage) => this.isProjectContextError(errorMessage),
          onProjectContextError: (errorMessage) =>
            this.logger.warn(
              `OpenAI compatibility request hit project context issue, retrying without project: ${errorMessage}`,
            ),
          prepareGraceRetry: (retryError) =>
            appliedVariantRequest.variant
              ? Promise.resolve(false)
              : this.prepareGraceRetry(retryState, token, retryError, 'OpenAI-compatible'),
          applyUpstreamPenalty: (accountId, model, retryError) =>
            this.applyUpstreamPenalty(accountId, model, retryError),
          onFallback: async () => {
            const claudeRequest = searchedClaudeRequest ?? baseClaudeRequest;
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(
              claudeRequest,
              '',
              requestUserAgent,
              accountTargetModel,
              { accountId: token.id, store: this.signatureStore },
            );
            this.applyInternalGenerationConstraints(
              fallbackBody,
              fallbackBody.model,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
            );
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
                deadlineAt,
              );
              this.markUpstreamSuccess(token.id, fallbackBody.model);
              return attachRoute(
                this.createOpenAIProtocolStream(
                  stream,
                  fallbackBody.model,
                  outputProtocol,
                  clientToolNames,
                  this.createSignatureState(token.id, fallbackBody.model),
                  this.createOpenAIStreamContract(request, webSearch),
                ),
                fallbackBody.model,
              );
            }

            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              deadlineAt,
            );
            this.markUpstreamSuccess(token.id, fallbackBody.model);
            const openaiResponse = this.convertGeminiToOpenAIResponse(
              response,
              isString(response.modelVersion) ? response.modelVersion : fallbackBody.model,
              clientToolNames,
              this.createSignatureState(token.id, fallbackBody.model),
              this.resolveOpenAIServiceTier(request.service_tier),
              request.top_logprobs,
              webSearch,
            );
            return attachRoute(openaiResponse, openaiResponse.model);
          },
        });
        if (fallbackResult.status === 'returned') {
          return fallbackResult.value;
        }
        lastError = fallbackResult.lastError;
        if (fallbackResult.shouldRetry) {
          continue;
        }
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private createOpenAIProtocolStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    outputProtocol: OpenAIOutputProtocol,
    clientToolNames?: ReadonlySet<string>,
    signatureState?: StreamingSignatureState,
    streamContract?: OpenAIStreamContract,
  ): Observable<string> {
    if (outputProtocol === 'responses') {
      return this.processResponsesStreamResponse(
        upstreamStream,
        model,
        clientToolNames,
        signatureState,
        streamContract?.webSearch === true,
      );
    }
    return this.processStreamResponse(
      upstreamStream,
      model,
      clientToolNames,
      signatureState,
      streamContract,
    );
  }

  private createOpenAIStreamContract(
    request: OpenAIChatRequest,
    webSearch = false,
  ): OpenAIStreamContract {
    return {
      expectedChoices: request.n ?? 1,
      includeUsage: request.stream_options?.include_usage === true,
      serviceTier: this.resolveOpenAIServiceTier(request.service_tier),
      webSearch,
    };
  }

  private resolveOpenAIServiceTier(requestedTier: string | undefined): string | undefined {
    return requestedTier ? 'default' : undefined;
  }

  private processResponsesStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    clientToolNames?: ReadonlySet<string>,
    signatureState?: StreamingSignatureState,
    webSearch = false,
  ): Observable<string> {
    return processResponsesStreamResponse(this.streamRuntime(), upstreamStream, {
      clientToolNames,
      model,
      signatureState,
      webSearch,
    });
  }

  // Handle SSE Stream conversion
  private processStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    clientToolNames?: ReadonlySet<string>,
    signatureState?: StreamingSignatureState,
    streamContract: OpenAIStreamContract = { expectedChoices: 1, includeUsage: false },
  ): Observable<string> {
    return processStreamResponse(this.streamRuntime(), upstreamStream, {
      clientToolNames,
      model,
      signatureState,
      streamContract,
    });
  }

  private createSyntheticOpenAIStream(
    response: OpenAIChatResponse,
    streamContract: OpenAIStreamContract = { expectedChoices: 1, includeUsage: false },
  ): Observable<string> {
    return createSyntheticOpenAIStream(this.streamRuntime(), response, streamContract);
  }

  private createSyntheticResponsesStream(
    response: OpenAIChatResponse,
    clientToolNames?: ReadonlySet<string>,
  ): Observable<string> {
    return createSyntheticResponsesStream(response, clientToolNames);
  }

  private createSignatureState(accountId: string, model: string): StreamingSignatureState {
    return { accountId, model, store: this.signatureStore };
  }

  private toClaudeRequest(
    request: AnthropicChatRequest,
    signatureSessionKey?: string,
  ): ClaudeRequest {
    return toClaudeRequest(request, signatureSessionKey);
  }

  private toAnthropicChatResponse(
    response: ClaudeResponse,
    fallbackModel: string,
  ): AnthropicChatResponse {
    return toAnthropicChatResponse(response, fallbackModel);
  }

  private toInternalGeminiRequest(request: GeminiRequest): GeminiInternalRequest['request'] {
    return toInternalGeminiRequest(request);
  }

  // Convert OpenAI request format to Claude/Anthropic format
  private convertOpenAIToClaude(
    request: OpenAIChatRequest,
    signatureSessionKey?: string,
  ): ClaudeRequest {
    return convertOpenAIToClaude(request, signatureSessionKey);
  }

  private convertClaudeToOpenAIResponse(
    claudeResponse: ClaudeResponse,
    model: string,
    clientToolNames?: ReadonlySet<string>,
  ): OpenAIChatResponse {
    return convertClaudeToOpenAIResponse(claudeResponse, model, clientToolNames);
  }

  private convertGeminiToOpenAIResponse(
    geminiResponse: GeminiResponse,
    model: string,
    clientToolNames?: ReadonlySet<string>,
    signatureState?: StreamingSignatureState,
    serviceTier?: string,
    topLogprobs = 0,
    webSearch = false,
  ): OpenAIChatResponse {
    return convertGeminiToOpenAIResponse(
      geminiResponse,
      model,
      clientToolNames,
      signatureState,
      serviceTier,
      topLogprobs,
      webSearch,
    );
  }
}
