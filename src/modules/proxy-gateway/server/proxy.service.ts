import { Inject, Injectable } from '@nestjs/common';
import { isEmpty, isNil, isNumber, isPlainObject, isString } from 'lodash-es';
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
import { v4 as uuidv4 } from 'uuid';
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
import { requestsWebSearch, transformClaudeRequestIn } from '../antigravity/ClaudeRequestMapper';
import {
  WEB_SEARCH_ROLE,
  runWebSearchSubCall,
  withWebSearchContext,
} from './modules/gemini/web-search-sub-call';
import { transformResponse } from '../antigravity/ClaudeResponseMapper';
import {
  toOpenAIResponsesUsage,
  toOpenAIUsage,
  toOpenAIUsageFromGeminiUsageMetadata,
} from '../antigravity/OpenAIUsageMapper';
import {
  PartProcessor,
  type StreamingSignatureState,
  StreamingState,
} from '../antigravity/ClaudeStreamingMapper';
import {
  type GeminiResponsesGroundingMetadata,
  type GeminiResponsesStreamPart,
  OpenAIResponsesStreamingMapper,
} from '../antigravity/OpenAIResponsesStreamingMapper';
import { toOpenAIResponsesId } from '../antigravity/OpenAIResponsesResponseMapper';
import {
  ClaudeRequest,
  ClaudeResponse,
  type GeminiContent,
  GeminiInternalRequest,
  type GroundingMetadata,
  type UsageMetadata,
} from '../antigravity/types';
import { toWebSearchResultSet, type WebSearchResultSet } from '../antigravity/web-search-results';
import {
  attachWebSearchResults,
  buildOpenAIUrlCitationAnnotations,
} from '../antigravity/openai-web-search';
import { OpenAIChatWebSearchStream } from './modules/openai/chat/openai-chat-web-search-stream';
import { applyOpenAIJsonObjectFence } from './modules/openai/chat/openai-json-object-fence';
import { convertOpenAIToolsToAnthropicTools } from './modules/openai/chat/openai-tool-conversion';
import {
  extractCustomToolInput,
  isCustomToolCall,
  toCustomToolArguments,
} from '../antigravity/CustomToolCall';
import { optimizeApplyPatch } from '../antigravity/ApplyPatchPreflight';
import { flattenOpenAITools, splitNamespaceToolName } from '../antigravity/ToolNamespace';
import { resolveShellToolName } from '../antigravity/ShellToolName';
import { sanitizeSystemInstructionForCache } from '../antigravity/StablePromptPrefix';
import { classifyStreamError } from '../antigravity/stream-error-utils';
import { SignatureStore } from '../antigravity/SignatureStore';
import {
  InvalidFunctionCallArgumentsError,
  normalizeFunctionCallArgs,
} from '../antigravity/function-call-args';
import {
  ToolCallIdConflictError,
  ToolCallIdIntegrityTracker,
} from '../antigravity/tool-call-id-integrity';
import { decodeSignature } from '../antigravity/signature-utils';
import { decodeInternalSseData } from '../antigravity/internal-sse';
import {
  AnthropicChatRequest,
  AnthropicChatResponse,
  AnthropicContent,
  AnthropicCountTokensRequest,
  AnthropicCountTokensResponse,
  GeminiRequest,
  GeminiResponse,
  GeminiUsageMetadata,
  OpenAIChatLogprobs,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIUsage,
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
import { attachUpstreamBackpressure } from './common/stream-backpressure';
import { attachModelRouteMetadata } from './common/model-route-metadata';

type OpenAIOutputProtocol = 'chat-completions' | 'responses';

interface OpenAIStreamContract {
  expectedChoices: number;
  includeUsage: boolean;
  serviceTier?: string;
  /** Emit search citations rather than the trailing grounding markdown. */
  webSearch?: boolean;
}

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
    const sessionKey = this.extractAnthropicSessionKey(request);
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
        if (error instanceof Error && this.isProjectContextError(error.message)) {
          this.logger.warn(
            `Anthropic request hit project context issue, retrying without project: ${error.message}`,
          );
          try {
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
            } else {
              const response = await this.generateInternalWithStreamFallback(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
                deadlineAt,
              );
              this.markUpstreamSuccess(token.id, fallbackBody.model);
              const anthropicResponse = this.toAnthropicChatResponse(
                transformResponse(
                  response,
                  this.createSignatureState(token.id, fallbackBody.model),
                  {
                    webSearch,
                    stopSequences: (claudeRequest ?? baseClaudeRequest).stop_sequences,
                  },
                ),
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
            }
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = error;
        }

        if (
          !appliedVariantRequest.variant &&
          (await this.prepareGraceRetry(retryState, token, lastError, 'Anthropic'))
        ) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, accountTargetModel, lastError);
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
    return attachUpstreamBackpressure(
      new Observable<string>((subscriber) => {
        const decoder = new TextDecoder();
        let buffer = '';

        const state = new StreamingState(signatureState, fallbackModel, {
          webSearch,
          stopSequences,
        });
        const processor = new PartProcessor(state);

        let lastFinishReason: string | undefined;
        let lastUsageMetadata: UsageMetadata | undefined;

        let receivedResponse = false;
        let cleanedUp = false;
        const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Claude-SSE', () => {
          state
            .emitTerminalError('timeout_error', 'The upstream stopped producing streaming data.')
            .forEach((chunk) => subscriber.next(chunk));
          cleanup(false);
          subscriber.complete();
        });

        const cleanup = (destroy: boolean): void => {
          if (cleanedUp) {
            return;
          }
          cleanedUp = true;
          idleTimer.clear();
          upstreamStream.removeListener('data', onData);
          upstreamStream.removeListener('end', onEnd);
          upstreamStream.removeListener('error', onError);
          if (destroy) {
            idleTimer.dispose();
          }
        };

        const onData = (chunk: Buffer): void => {
          idleTimer.reset();
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const dataStr = trimmed.slice(6);

            const decoded = decodeInternalSseData(dataStr);
            if (decoded.kind === 'ignored') {
              continue;
            }
            if (decoded.kind === 'invalid') {
              this.logger.error('Stream parse error: invalid v1internal SSE payload');
              const errorChunks = state.handleParseError(dataStr);
              errorChunks.forEach((c) => subscriber.next(c));
              if (errorChunks.some((event) => event.startsWith('event: error'))) {
                cleanup(true);
                subscriber.complete();
                return;
              }
              continue;
            }

            try {
              const response = decoded.response;
              receivedResponse = true;

              const startMsg = state.emitMessageStart(response);
              if (startMsg) subscriber.next(startMsg);

              const candidate = response.candidates?.[0];
              const parts = candidate?.content?.parts;

              if (candidate?.finishReason) {
                lastFinishReason = candidate.finishReason;
              }
              if (response.usageMetadata) {
                lastUsageMetadata = response.usageMetadata;
              }
              state.captureGrounding(candidate?.groundingMetadata);

              if (Array.isArray(parts)) {
                for (const part of parts) {
                  if (this.isGeminiPart(part)) {
                    const chunks = processor.process(part);
                    chunks.forEach((c) => subscriber.next(c));
                  }
                }
              }

              // Reset error state on successful parse
              state.resetErrorState();
            } catch (e) {
              if (
                e instanceof ToolCallIdConflictError ||
                e instanceof InvalidFunctionCallArgumentsError
              ) {
                state
                  .emitTerminalError('api_error', e.message)
                  .forEach((chunk) => subscriber.next(chunk));
                cleanup(true);
                subscriber.complete();
                return;
              }
              this.logger.error('Stream parse error', e);
              const errorChunks = state.handleParseError(dataStr);
              errorChunks.forEach((c) => subscriber.next(c));
              if (errorChunks.some((event) => event.startsWith('event: error'))) {
                cleanup(true);
                subscriber.complete();
                return;
              }
            }
          }
        };

        const onEnd = (): void => {
          if (!receivedResponse) {
            this.logger.warn('Empty response stream detected');
            cleanup(false);
            subscriber.error(new Error('Empty response stream'));
            return;
          }

          const finishChunks = state.emitFinish(lastFinishReason, lastUsageMetadata);
          finishChunks.forEach((c) => subscriber.next(c));
          cleanup(false);
          subscriber.complete();
        };

        const onError = (err: unknown): void => {
          const cleanError = err instanceof Error ? err : new Error(String(err));
          const { type } = classifyStreamError(cleanError);

          this.logger.error(`Stream error: ${type} - ${cleanError.message}`);
          state
            .emitTerminalError(
              type === 'timeout_error' ? 'timeout_error' : 'api_error',
              cleanError.message,
            )
            .forEach((chunk) => subscriber.next(chunk));
          cleanup(false);
          subscriber.complete();
        };

        upstreamStream.on('data', onData);
        upstreamStream.on('end', onEnd);
        upstreamStream.on('error', onError);
        idleTimer.reset();

        return () => {
          cleanup(true);
        };
      }),
      upstreamStream,
    );
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
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `Gemini request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
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
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        if (await this.prepareGraceRetry(retryState, token, lastError, 'Gemini')) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveTargetModel, lastError);
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
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `Gemini stream request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
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
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        if (await this.prepareGraceRetry(retryState, token, lastError, 'Gemini stream')) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveTargetModel, lastError);
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
    const normalizedProjectId = projectId?.trim();

    const internalRequest: GeminiInternalRequest = {
      requestId: this.createOfficialRequestId(),
      request: this.toInternalGeminiRequest(request),
      model,
      userAgent: requestUserAgent,
      requestType,
    };

    if (normalizedProjectId) {
      internalRequest.project = normalizedProjectId;
    }

    if (requestType !== 'image_gen') {
      internalRequest.enabledCreditTypes = ['GOOGLE_ONE_AI'];
    }

    return internalRequest;
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
    const sessionKey = this.extractOpenAISessionKey(request);
    const clientToolNames = this.extractOpenAIToolNames(routedRequest.tools);
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
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `OpenAI compatibility request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
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
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        if (
          !appliedVariantRequest.variant &&
          (await this.prepareGraceRetry(retryState, token, lastError, 'OpenAI-compatible'))
        ) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, accountTargetModel, lastError);
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
    return attachUpstreamBackpressure(
      new Observable<string>((subscriber) => {
        const decoder = new TextDecoder();
        let buffer = '';
        let settled = false;
        const mapper = new OpenAIResponsesStreamingMapper({
          clientToolNames,
          model,
          responseId: `resp_${uuidv4()}`,
          signatureState,
          webSearch,
        });
        let heartbeatTimer: NodeJS.Timeout | undefined;
        let idleTimer: { clear(): void; dispose(): void; reset(): void };
        let started = false;

        const ensureStarted = (): void => {
          if (started) {
            return;
          }
          started = true;
          subscriber.next(mapper.createResponseCreatedEvent());
          subscriber.next(mapper.createResponseInProgressEvent());
        };

        const clearHeartbeat = (): void => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
        };

        const complete = (finishReason?: string): void => {
          if (settled) {
            return;
          }
          settled = true;
          ensureStarted();
          idleTimer.clear();
          clearHeartbeat();
          for (const event of mapper.complete(finishReason)) {
            subscriber.next(event);
          }
          subscriber.complete();
        };

        const fail = (error: unknown): void => {
          if (settled) {
            return;
          }
          settled = true;
          ensureStarted();
          idleTimer.clear();
          clearHeartbeat();
          for (const event of mapper.fail(error)) {
            subscriber.next(event);
          }
          subscriber.complete();
        };

        const processLine = (line: string): void => {
          if (settled) {
            return;
          }
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) {
            return;
          }

          const dataString = trimmed.slice(6);
          try {
            const decoded = decodeInternalSseData(dataString);
            if (decoded.kind !== 'response') {
              return;
            }

            const responsePayload = decoded.response;
            if (isString(responsePayload.modelVersion) && responsePayload.modelVersion.trim()) {
              mapper.setModel(responsePayload.modelVersion);
            }
            ensureStarted();
            const usageMetadata = this.toGeminiUsageMetadata(responsePayload.usageMetadata);
            if (usageMetadata) {
              mapper.setUsage(
                toOpenAIResponsesUsage(toOpenAIUsageFromGeminiUsageMetadata(usageMetadata)),
              );
            }
            const candidates = responsePayload.candidates;
            if (!Array.isArray(candidates)) {
              return;
            }

            const candidate = this.toUnknownRecord(candidates[0]);
            const content = this.toUnknownRecord(candidate?.content);
            const parts = content?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                const normalizedPart = this.toResponsesStreamPart(part);
                if (!normalizedPart) {
                  continue;
                }
                for (const event of mapper.processPart(normalizedPart)) {
                  subscriber.next(event);
                }
              }
            }

            if (webSearch) {
              mapper.captureWebSearchGrounding(
                candidate?.groundingMetadata as GroundingMetadata | undefined,
              );
            } else {
              const grounding = this.toResponsesGroundingMetadata(candidate?.groundingMetadata);
              if (grounding) {
                for (const event of mapper.processGrounding(grounding)) {
                  subscriber.next(event);
                }
              }
            }

            if (isString(candidate?.finishReason) && candidate.finishReason.length > 0) {
              complete(candidate.finishReason);
            }
          } catch (error) {
            if (
              error instanceof ToolCallIdConflictError ||
              error instanceof InvalidFunctionCallArgumentsError
            ) {
              (upstreamStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
              fail(error);
            }
            // Ignore malformed upstream keepalive/data lines that are not contract failures.
          }
        };

        heartbeatTimer = setInterval(() => {
          if (!settled) {
            subscriber.next(': ping\n\n');
          }
        }, 15_000);
        idleTimer = this.createStreamIdleTimer(upstreamStream, 'OpenAI-Responses-SSE', () =>
          fail(new Error('OpenAI Responses upstream stream idle timeout')),
        );
        idleTimer.reset();

        upstreamStream.on('data', (chunk: Buffer) => {
          if (settled) {
            return;
          }
          idleTimer.reset();
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            processLine(line);
          }
        });

        upstreamStream.on('end', () => {
          if (settled) {
            return;
          }
          buffer += decoder.decode();
          if (buffer.trim().length > 0) {
            processLine(buffer);
          }
          if (!settled) {
            fail(new Error('upstream stream ended without a finish reason'));
          }
        });

        upstreamStream.on('error', (error: unknown) => {
          const cleanError =
            error instanceof Error ? new Error(error.message) : new Error(String(error));
          this.logger.error(`OpenAI Responses stream error: ${cleanError.message}`);
          fail(cleanError);
        });

        return () => {
          clearHeartbeat();
          idleTimer.dispose();
        };
      }),
      upstreamStream,
    );
  }

  private toResponsesStreamPart(value: unknown): GeminiResponsesStreamPart | null {
    const part = this.toUnknownRecord(value);
    if (!part) {
      return null;
    }

    const functionCallRecord = this.toUnknownRecord(part.functionCall);
    const functionName = isString(functionCallRecord?.name) ? functionCallRecord.name : null;
    const functionId = isString(functionCallRecord?.id) ? functionCallRecord.id : undefined;
    const inlineDataRecord = this.toUnknownRecord(part.inlineData);
    const inlineData =
      isString(inlineDataRecord?.mimeType) && isString(inlineDataRecord.data)
        ? {
            data: inlineDataRecord.data,
            mimeType: inlineDataRecord.mimeType,
          }
        : undefined;

    return {
      functionCall: functionName
        ? {
            ...(functionCallRecord && Object.hasOwn(functionCallRecord, 'args')
              ? { args: functionCallRecord.args }
              : {}),
            id: functionId,
            name: functionName,
          }
        : undefined,
      inlineData,
      text: isString(part.text) ? part.text : undefined,
      thought: part.thought === true,
      thoughtSignature: isString(part.thoughtSignature) ? part.thoughtSignature : undefined,
      thought_signature: isString(part.thought_signature) ? part.thought_signature : undefined,
    };
  }

  private toResponsesGroundingMetadata(value: unknown): GeminiResponsesGroundingMetadata | null {
    const grounding = this.toUnknownRecord(value);
    if (!grounding) {
      return null;
    }

    const webSearchQueries = Array.isArray(grounding.webSearchQueries)
      ? grounding.webSearchQueries.filter(isString)
      : undefined;
    const groundingChunks = Array.isArray(grounding.groundingChunks)
      ? grounding.groundingChunks.flatMap((chunk) => {
          const web = this.toUnknownRecord(this.toUnknownRecord(chunk)?.web);
          if (!web) {
            return [];
          }
          return [
            {
              web: {
                title: isString(web.title) ? web.title : undefined,
                uri: isString(web.uri) ? web.uri : undefined,
              },
            },
          ];
        })
      : undefined;

    if (!webSearchQueries?.length && !groundingChunks?.length) {
      return null;
    }
    return { groundingChunks, webSearchQueries };
  }

  private toGeminiUsageMetadata(value: unknown): GeminiUsageMetadata | undefined {
    const usageMetadata = this.toUnknownRecord(value);
    if (!usageMetadata) {
      return undefined;
    }

    return {
      cachedContentTokenCount: isNumber(usageMetadata.cachedContentTokenCount)
        ? usageMetadata.cachedContentTokenCount
        : undefined,
      candidatesTokenCount: isNumber(usageMetadata.candidatesTokenCount)
        ? usageMetadata.candidatesTokenCount
        : undefined,
      promptTokenCount: isNumber(usageMetadata.promptTokenCount)
        ? usageMetadata.promptTokenCount
        : undefined,
      thoughtsTokenCount: isNumber(usageMetadata.thoughtsTokenCount)
        ? usageMetadata.thoughtsTokenCount
        : undefined,
      totalTokenCount: isNumber(usageMetadata.totalTokenCount)
        ? usageMetadata.totalTokenCount
        : undefined,
      total_input_tokens: isNumber(usageMetadata.total_input_tokens)
        ? usageMetadata.total_input_tokens
        : undefined,
      total_output_tokens: isNumber(usageMetadata.total_output_tokens)
        ? usageMetadata.total_output_tokens
        : undefined,
      total_cached_tokens: isNumber(usageMetadata.total_cached_tokens)
        ? usageMetadata.total_cached_tokens
        : undefined,
      total_thought_tokens: isNumber(usageMetadata.total_thought_tokens)
        ? usageMetadata.total_thought_tokens
        : undefined,
      totalThoughtTokens: isNumber(usageMetadata.totalThoughtTokens)
        ? usageMetadata.totalThoughtTokens
        : undefined,
      total_tokens: isNumber(usageMetadata.total_tokens) ? usageMetadata.total_tokens : undefined,
      total_tool_use_tokens: isNumber(usageMetadata.total_tool_use_tokens)
        ? usageMetadata.total_tool_use_tokens
        : undefined,
      cachedTokens: isNumber(usageMetadata.cachedTokens) ? usageMetadata.cachedTokens : undefined,
    };
  }

  private toUnknownRecord(value: unknown): Record<string, unknown> | null {
    if (!isPlainObject(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  // Handle SSE Stream conversion
  private processStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    clientToolNames?: ReadonlySet<string>,
    signatureState?: StreamingSignatureState,
    streamContract: OpenAIStreamContract = { expectedChoices: 1, includeUsage: false },
  ): Observable<string> {
    return attachUpstreamBackpressure(
      new Observable<string>((subscriber) => {
        const decoder = new TextDecoder();
        let buffer = '';
        let hasEmittedChunk = false;
        let settled = false;
        let servedModel = model;
        let lastUsage: OpenAIUsage | undefined;
        const observedChoiceIndexes = new Set<number>();
        const roleEmittedIndexes = new Set<number>();
        const finishedChoiceIndexes = new Set<number>();
        const toolCallIndexes = new Map<number, number>();
        const emittedToolCallCounts = new Map<number, number>();
        const latestResponseSignatures = new Map<number, string>();
        const webSearchStream = new OpenAIChatWebSearchStream(streamContract.webSearch === true);
        const toolCallIntegrityByChoice = new Map<number, ToolCallIdIntegrityTracker>();
        let heartbeatTimer: NodeJS.Timeout | undefined;

        const streamId = `chatcmpl-${uuidv4()}`;
        const created = Math.floor(Date.now() / 1000);
        if (this.shouldEmitCloudCodeMeta()) {
          subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
        }

        const pushChunk = (payload: Record<string, unknown>): void => {
          if (settled) {
            return;
          }
          hasEmittedChunk = true;
          subscriber.next(`data: ${JSON.stringify(payload)}\n\n`);
        };

        const withOptionalUsage = (payload: Record<string, unknown>): Record<string, unknown> => {
          const withTier = streamContract.serviceTier
            ? { ...payload, service_tier: streamContract.serviceTier }
            : payload;
          return streamContract.includeUsage ? { ...withTier, usage: null } : withTier;
        };

        const emitRoleIfNeeded = (choiceIndex: number): void => {
          observedChoiceIndexes.add(choiceIndex);
          if (roleEmittedIndexes.has(choiceIndex)) {
            return;
          }
          roleEmittedIndexes.add(choiceIndex);
          pushChunk(
            withOptionalUsage({
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: servedModel,
              choices: [
                {
                  index: choiceIndex,
                  delta: { role: 'assistant', content: '' },
                  finish_reason: null,
                },
              ],
            }),
          );
        };

        const requiredChoiceCount = (): number =>
          Math.max(streamContract.expectedChoices, observedChoiceIndexes.size);

        const clearHeartbeat = (): void => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
        };

        const finalizeSuccess = (): void => {
          if (settled) {
            return;
          }
          idleTimer.clear();
          clearHeartbeat();
          if (streamContract.includeUsage) {
            pushChunk({
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: servedModel,
              choices: [],
              usage: lastUsage ?? null,
              ...(streamContract.serviceTier ? { service_tier: streamContract.serviceTier } : {}),
            });
          }
          subscriber.next('data: [DONE]\n\n');
          settled = true;
          subscriber.complete();
        };

        const failStream = (error: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          idleTimer.clear();
          clearHeartbeat();
          subscriber.error(error);
        };

        const idleTimer = this.createStreamIdleTimer(upstreamStream, 'OpenAI-SSE', () => {
          failStream(new Error('OpenAI-compatible upstream stream idle timeout'));
        });

        idleTimer.reset();
        heartbeatTimer = setInterval(() => {
          if (!settled) {
            subscriber.next(': ping\n\n');
          }
        }, 15_000);

        const processLine = (line: string): void => {
          if (settled) {
            return;
          }
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) {
            return;
          }

          try {
            const decoded = decodeInternalSseData(trimmed.slice(6));
            if (decoded.kind !== 'response') {
              return;
            }

            const responsePayload = decoded.response;
            if (isString(responsePayload.modelVersion) && responsePayload.modelVersion.trim()) {
              servedModel = responsePayload.modelVersion.trim();
            }
            const usageMetadata = this.toGeminiUsageMetadata(responsePayload.usageMetadata);
            if (usageMetadata) {
              lastUsage = toOpenAIUsageFromGeminiUsageMetadata(usageMetadata);
            }

            const candidates = Array.isArray(responsePayload.candidates)
              ? responsePayload.candidates
              : [];
            for (const [fallbackCandidateIndex, candidateValue] of candidates.entries()) {
              const candidate = this.toUnknownRecord(candidateValue);
              if (!candidate) {
                continue;
              }
              const candidateIndex = isNumber(candidate.index)
                ? candidate.index
                : fallbackCandidateIndex;
              emitRoleIfNeeded(candidateIndex);

              webSearchStream.captureGrounding(candidateIndex, candidate.groundingMetadata);

              const content = this.toUnknownRecord(candidate.content);
              const parts = Array.isArray(content?.parts) ? content.parts : [];
              let reasoningContent = '';
              let responseContent = '';

              for (const partValue of parts) {
                const part = this.toUnknownRecord(partValue);
                if (!part) {
                  continue;
                }

                if (isString(part.text)) {
                  const cleanText = part.text
                    .replaceAll('<think>\n', '')
                    .replaceAll('<think>', '')
                    .replaceAll('\n</think>', '')
                    .replaceAll('</think>', '');
                  if (part.thought === true) {
                    reasoningContent += cleanText;
                  } else {
                    responseContent += cleanText;
                  }
                }

                const rawSignature = isString(part.thoughtSignature)
                  ? part.thoughtSignature
                  : isString(part.thought_signature)
                    ? part.thought_signature
                    : undefined;
                const signature = decodeSignature(rawSignature);
                if (signature) {
                  latestResponseSignatures.set(candidateIndex, signature);
                }

                const functionCall = this.toUnknownRecord(part.functionCall);
                if (functionCall && isString(functionCall.name)) {
                  const rawArguments = normalizeFunctionCallArgs(functionCall);
                  const explicitToolCallId = isString(functionCall.id)
                    ? functionCall.id
                    : undefined;
                  const integrityTracker =
                    toolCallIntegrityByChoice.get(candidateIndex) ??
                    new ToolCallIdIntegrityTracker();
                  toolCallIntegrityByChoice.set(candidateIndex, integrityTracker);
                  const integrity = integrityTracker.record(
                    explicitToolCallId,
                    functionCall.name,
                    rawArguments,
                  );
                  if (integrity === 'replay') {
                    const replaySignature =
                      signature ?? latestResponseSignatures.get(candidateIndex);
                    if (replaySignature && signatureState && explicitToolCallId) {
                      signatureState.store.store(
                        {
                          accountId: signatureState.accountId,
                          model: signatureState.model,
                          toolCallId: explicitToolCallId,
                        },
                        replaySignature,
                      );
                    }
                    continue;
                  }

                  const splitName = splitNamespaceToolName(functionCall.name);
                  const functionName = clientToolNames
                    ? resolveShellToolName(splitName.name, clientToolNames)
                    : splitName.name;
                  const functionArguments = isCustomToolCall(functionName)
                    ? toCustomToolArguments(
                        functionName,
                        optimizeApplyPatch(extractCustomToolInput(functionName, rawArguments))
                          .input,
                      )
                    : rawArguments;
                  const clientToolCallId = explicitToolCallId ?? `${functionName}-${uuidv4()}`;
                  const capturedSignature =
                    signature ?? latestResponseSignatures.get(candidateIndex);
                  if (capturedSignature && signatureState) {
                    signatureState.store.store(
                      {
                        accountId: signatureState.accountId,
                        model: signatureState.model,
                        toolCallId: clientToolCallId,
                      },
                      capturedSignature,
                    );
                  }
                  const toolCallIndex = toolCallIndexes.get(candidateIndex) ?? 0;
                  pushChunk(
                    withOptionalUsage({
                      id: streamId,
                      object: 'chat.completion.chunk',
                      created,
                      model: servedModel,
                      choices: [
                        {
                          index: candidateIndex,
                          delta: {
                            tool_calls: [
                              {
                                index: toolCallIndex,
                                id: clientToolCallId,
                                type: 'function',
                                function: {
                                  name: functionName,
                                  arguments: JSON.stringify(functionArguments),
                                },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    }),
                  );
                  toolCallIndexes.set(candidateIndex, toolCallIndex + 1);
                  emittedToolCallCounts.set(
                    candidateIndex,
                    (emittedToolCallCounts.get(candidateIndex) ?? 0) + 1,
                  );
                }

                const inlineData = this.toUnknownRecord(part.inlineData);
                if (inlineData) {
                  const mimeType = isString(inlineData.mimeType)
                    ? inlineData.mimeType
                    : 'image/jpeg';
                  const data = isString(inlineData.data) ? inlineData.data : '';
                  responseContent += `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`;
                }
              }

              if (reasoningContent) {
                pushChunk(
                  withOptionalUsage({
                    id: streamId,
                    object: 'chat.completion.chunk',
                    created,
                    model: servedModel,
                    choices: [
                      {
                        index: candidateIndex,
                        delta: { content: null, reasoning_content: reasoningContent },
                        finish_reason: null,
                      },
                    ],
                  }),
                );
              }

              if (responseContent) {
                webSearchStream.appendText(candidateIndex, responseContent);
                pushChunk(
                  withOptionalUsage({
                    id: streamId,
                    object: 'chat.completion.chunk',
                    created,
                    model: servedModel,
                    choices: [
                      {
                        index: candidateIndex,
                        delta: { content: responseContent },
                        finish_reason: null,
                      },
                    ],
                  }),
                );
              }

              if (isString(candidate.finishReason) && !finishedChoiceIndexes.has(candidateIndex)) {
                const annotations = webSearchStream.buildAnnotations(candidateIndex);
                if (annotations.length > 0) {
                  pushChunk(
                    withOptionalUsage({
                      id: streamId,
                      object: 'chat.completion.chunk',
                      created,
                      model: servedModel,
                      choices: [
                        {
                          index: candidateIndex,
                          delta: { annotations },
                          finish_reason: null,
                        },
                      ],
                    }),
                  );
                }
                pushChunk(
                  withOptionalUsage({
                    id: streamId,
                    object: 'chat.completion.chunk',
                    created,
                    model: servedModel,
                    choices: [
                      {
                        index: candidateIndex,
                        delta: {},
                        finish_reason:
                          (emittedToolCallCounts.get(candidateIndex) ?? 0) > 0
                            ? 'tool_calls'
                            : this.mapGeminiFinishReasonToOpenAIFinishReason(
                                candidate.finishReason,
                              ),
                      },
                    ],
                  }),
                );
                finishedChoiceIndexes.add(candidateIndex);
              }
            }

            if (
              finishedChoiceIndexes.size >= requiredChoiceCount() &&
              (!streamContract.includeUsage || lastUsage !== undefined)
            ) {
              finalizeSuccess();
            }
          } catch (error) {
            if (
              error instanceof ToolCallIdConflictError ||
              error instanceof InvalidFunctionCallArgumentsError
            ) {
              failStream(error);
            }
          }
        };

        upstreamStream.on('data', (chunk: Buffer) => {
          if (settled) {
            return;
          }
          idleTimer.reset();
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            processLine(line);
            if (settled) {
              return;
            }
          }
        });

        upstreamStream.on('end', () => {
          if (settled) {
            return;
          }
          idleTimer.clear();
          buffer += decoder.decode();
          if (buffer.trim()) {
            processLine(buffer);
          }
          if (settled) {
            return;
          }
          if (finishedChoiceIndexes.size >= requiredChoiceCount()) {
            finalizeSuccess();
            return;
          }
          const message = hasEmittedChunk
            ? `OpenAI-compatible upstream stream ended before ${requiredChoiceCount()} choice(s) finished`
            : 'Empty OpenAI-compatible upstream response stream';
          failStream(new Error(message));
        });

        upstreamStream.on('error', (err: unknown) => {
          const cleanError = err instanceof Error ? new Error(err.message) : new Error(String(err));
          this.logger.error(`OpenAI-compatible stream error: ${cleanError.message}`);
          failStream(cleanError);
        });

        return () => {
          clearHeartbeat();
          idleTimer.dispose();
        };
      }),
      upstreamStream,
    );
  }

  private createSyntheticOpenAIStream(
    response: OpenAIChatResponse,
    streamContract: OpenAIStreamContract = { expectedChoices: 1, includeUsage: false },
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const streamId = response.id || `chatcmpl-${uuidv4()}`;
      const created = response.created || Math.floor(Date.now() / 1000);
      const model = response.model;
      const chunkSize = 80;

      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      const pushChunk = (payload: Record<string, unknown>): void => {
        const withTier = streamContract.serviceTier
          ? { ...payload, service_tier: streamContract.serviceTier }
          : payload;
        const chunk = streamContract.includeUsage ? { ...withTier, usage: null } : withTier;
        subscriber.next(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      for (const choice of response.choices ?? []) {
        const choiceIndex = choice.index;
        const finishReason = choice.finish_reason ?? 'stop';
        const message = choice.message;
        pushChunk({
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: choiceIndex,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
            },
          ],
        });

        if (message?.reasoning_content) {
          pushChunk({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: choiceIndex,
                delta: { content: null, reasoning_content: message.reasoning_content },
                finish_reason: null,
              },
            ],
          });
        }

        const content = isString(message?.content) ? message.content : '';
        for (let index = 0; index < content.length; index += chunkSize) {
          pushChunk({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: choiceIndex,
                delta: { content: content.slice(index, index + chunkSize) },
                finish_reason: null,
              },
            ],
          });
        }

        for (const [toolIndex, toolCall] of (message?.tool_calls ?? []).entries()) {
          pushChunk({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: choiceIndex,
                delta: {
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: toolCall.id,
                      type: toolCall.type,
                      function: toolCall.function,
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }

        pushChunk({
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: choiceIndex,
              delta: {},
              finish_reason: finishReason,
            },
          ],
        });
      }

      if (streamContract.includeUsage) {
        subscriber.next(
          `data: ${JSON.stringify({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: response.usage,
            ...(streamContract.serviceTier ? { service_tier: streamContract.serviceTier } : {}),
          })}\n\n`,
        );
      }

      subscriber.next('data: [DONE]\n\n');
      subscriber.complete();
    });
  }

  private createSyntheticResponsesStream(
    response: OpenAIChatResponse,
    clientToolNames?: ReadonlySet<string>,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const mapper = new OpenAIResponsesStreamingMapper({
        clientToolNames,
        model: response.model,
        responseId: toOpenAIResponsesId(response.id),
      });
      const choice = response.choices?.[0];
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : undefined;
      const reasoningContent =
        choice?.message && isString(choice.message.reasoning_content)
          ? choice.message.reasoning_content
          : undefined;

      subscriber.next(mapper.createResponseCreatedEvent());
      subscriber.next(mapper.createResponseInProgressEvent());
      if (response.usage) {
        mapper.setUsage(toOpenAIResponsesUsage(response.usage));
      }
      if (reasoningContent) {
        for (const event of mapper.processPart({ text: reasoningContent, thought: true })) {
          subscriber.next(event);
        }
      }
      if (content) {
        for (const event of mapper.processPart({ text: content })) {
          subscriber.next(event);
        }
      }

      for (const toolCall of choice?.message?.tool_calls ?? []) {
        const functionName =
          toolCall.function?.name ??
          (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
        if (!functionName) {
          continue;
        }
        for (const event of mapper.processPart({
          functionCall: {
            args:
              toolCall.operation ??
              this.parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'),
            id: toolCall.call_id || toolCall.id,
            name: functionName,
          },
        })) {
          subscriber.next(event);
        }
      }

      for (const event of mapper.complete(choice?.finish_reason)) {
        subscriber.next(event);
      }
      subscriber.complete();
    });
  }

  private createSignatureState(accountId: string, model: string): StreamingSignatureState {
    return { accountId, model, store: this.signatureStore };
  }

  private toClaudeRequest(
    request: AnthropicChatRequest,
    signatureSessionKey?: string,
  ): ClaudeRequest {
    return {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      system: request.system,
      tools: request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        type: tool.type,
      })),
      stream: request.stream,
      max_tokens: request.max_tokens,
      stop_sequences: request.stop_sequences,
      temperature: request.temperature,
      top_p: request.top_p,
      top_k: request.top_k,
      thinking: request.thinking,
      output_config: request.output_config,
      metadata: {
        ...(request.metadata ?? {}),
        signature_session_key: signatureSessionKey,
      },
    };
  }

  private toAnthropicChatResponse(
    response: ClaudeResponse,
    fallbackModel: string,
  ): AnthropicChatResponse {
    return {
      id: response.id,
      type: response.type,
      role: response.role,
      model: response.model || fallbackModel,
      content:
        response.content.length === 0 && response.refusal
          ? [{ type: 'text', text: response.refusal }]
          : response.content,
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
      usage: {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
        cache_read_input_tokens: response.usage?.cache_read_input_tokens,
        ...(response.usage?.server_tool_use
          ? { server_tool_use: response.usage.server_tool_use }
          : {}),
      },
    };
  }

  private toInternalGeminiRequest(request: GeminiRequest): GeminiInternalRequest['request'] {
    const internalRequest: GeminiInternalRequest['request'] = {
      contents: request.contents,
    };

    if (request.generationConfig) {
      internalRequest.generationConfig = request.generationConfig;
    }
    if (request.tools) {
      internalRequest.tools = request.tools;
    }
    if (request.toolConfig) {
      internalRequest.toolConfig = request.toolConfig;
    }
    if (request.safetySettings) {
      internalRequest.safetySettings = request.safetySettings;
    }

    if (request.systemInstruction) {
      const textParts = (request.systemInstruction.parts ?? [])
        .filter((part): part is { text: string } => isString(part.text) && part.text.length > 0)
        .map((part) => ({ text: part.text }));
      if (textParts.length > 0) {
        internalRequest.systemInstruction = { parts: textParts };
      }
    }

    return internalRequest;
  }

  // Convert OpenAI request format to Claude/Anthropic format
  private convertOpenAIToClaude(
    request: OpenAIChatRequest,
    signatureSessionKey?: string,
  ): ClaudeRequest {
    const messages = request.messages || [];
    const systemPromptParts: string[] = [];
    const seenSystemPromptKeys = new Set<string>();
    const anthropicMessages: ClaudeRequest['messages'] = [];
    const addSystemPrompt = (text: string) => {
      const trimmed = text.trim();
      const key = sanitizeSystemInstructionForCache(trimmed).split(/\s+/).join(' ');
      if (key && !seenSystemPromptKeys.has(key)) {
        seenSystemPromptKeys.add(key);
        systemPromptParts.push(trimmed);
      }
    };

    for (const msg of messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        const systemText = this.extractOpenAITextContent(msg.content);
        if (systemText) {
          addSystemPrompt(systemText);
        }
        continue;
      }

      if (msg.role === 'tool') {
        const toolResultText = this.extractOpenAITextContent(msg.content) || '';
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id || msg.name || `tool-result-${uuidv4()}`,
              content: toolResultText,
              is_error: false,
            },
          ],
        });
        continue;
      }

      const contentBlocks = this.convertOpenAIPartsToAnthropicContent(msg.content);

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          const functionName =
            toolCall.function?.name ??
            (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
          if (!functionName) {
            continue;
          }
          contentBlocks.push({
            type: 'tool_use',
            id: toolCall.call_id || toolCall.id,
            name: functionName,
            input:
              toolCall.custom_input === undefined
                ? (toolCall.operation ??
                  this.parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'))
                : toCustomToolArguments(functionName, toolCall.custom_input),
          });
        }
      }

      anthropicMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: contentBlocks.length > 0 ? contentBlocks : '',
      });
    }

    const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join('\n') : undefined;

    return {
      model: request.model,
      messages: anthropicMessages,
      system: systemPrompt,
      tools: convertOpenAIToolsToAnthropicTools(
        request.tools,
        request.web_search_options !== undefined,
      ),
      thinking: request.thinking
        ? {
            type: request.thinking.type ?? 'enabled',
            budget_tokens: request.thinking.budget_tokens,
            effort: request.thinking.effort,
          }
        : undefined,
      max_tokens: request.max_completion_tokens ?? request.max_tokens,
      candidate_count: request.n,
      stop_sequences: typeof request.stop === 'string' ? [request.stop] : request.stop,
      temperature: request.temperature,
      top_p: request.top_p,
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty,
      seed: request.seed,
      response_format: request.response_format,
      response_logprobs: request.logprobs,
      top_logprobs: request.top_logprobs,
      tool_choice: request.tool_choice,
      stream: request.stream,
      metadata: {
        ...(request.metadata ?? {}),
        ...(request.extra ?? {}),
        ...(request.user ? { user_id: request.user } : {}),
        source: 'openai',
        signature_session_key: signatureSessionKey,
      },
    };
  }

  private convertOpenAIPartsToAnthropicContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): AnthropicContent[] {
    if (isString(content)) {
      return content.trim() ? [{ type: 'text', text: content }] : [];
    }
    if (!Array.isArray(content)) {
      return [];
    }

    const blocks: AnthropicContent[] = [];
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text });
        continue;
      }

      if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url;
        const dataUri = url.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
        if (dataUri?.groups?.mime && dataUri.groups.data) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: dataUri.groups.mime,
              data: dataUri.groups.data,
            },
          });
        } else {
          blocks.push({ type: 'text', text: `[image_url] ${url}` });
        }
        continue;
      }

      if (part.type === 'file' && part.file?.file_data) {
        // Expanded file handles arrive here as a base64 data URL. Images keep
        // their image block; anything else becomes a document block, which the
        // Claude mapper turns into the same `inlineData` part either way.
        const dataUri = part.file.file_data.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
        if (dataUri?.groups?.mime && dataUri.groups.data) {
          const source = {
            type: 'base64' as const,
            media_type: dataUri.groups.mime,
            data: dataUri.groups.data,
          };
          blocks.push(
            dataUri.groups.mime.startsWith('image/')
              ? { type: 'image', source }
              : {
                  type: 'document',
                  source,
                  ...(part.file.filename ? { title: part.file.filename } : {}),
                },
          );
        }
      }
    }
    return blocks;
  }

  private extractOpenAITextContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): string {
    if (isString(content)) {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('\n');
  }

  private parseOpenAIFunctionArguments(argumentsString: string): Record<string, unknown> {
    if (isEmpty(argumentsString.trim())) {
      return {};
    }

    try {
      const parsed = JSON.parse(argumentsString);
      if (isPlainObject(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: argumentsString };
    }
  }

  private extractOpenAIToolNames(tools: OpenAIChatRequest['tools']): ReadonlySet<string> {
    const names = new Set<string>();

    for (const tool of flattenOpenAITools(tools) ?? []) {
      const name = isString(tool.function?.name)
        ? tool.function.name
        : isString(tool.name)
          ? tool.name
          : undefined;
      if (name) {
        names.add(name);
      }
    }

    return names;
  }

  private mapGeminiFinishReasonToOpenAIFinishReason(finishReason?: string): string | null {
    if (!finishReason) {
      return null;
    }

    const normalized = finishReason.toUpperCase();
    if (normalized === 'STOP') {
      return 'stop';
    }
    if (normalized === 'MAX_TOKENS') {
      return 'length';
    }
    if (
      normalized === 'SAFETY' ||
      normalized === 'RECITATION' ||
      normalized === 'BLOCKLIST' ||
      normalized === 'PROHIBITED_CONTENT' ||
      normalized === 'SPII' ||
      normalized === 'IMAGE_SAFETY' ||
      normalized === 'IMAGE_PROHIBITED_CONTENT'
    ) {
      return 'content_filter';
    }

    return 'stop';
  }

  private mapAnthropicStopReasonToOpenAIFinishReason(stopReason?: string | null): string | null {
    if (!stopReason) {
      return null;
    }

    if (stopReason === 'end_turn') {
      return 'stop';
    }
    if (stopReason === 'max_tokens') {
      return 'length';
    }
    if (stopReason === 'tool_use') {
      return 'tool_calls';
    }
    if (stopReason === 'refusal') {
      return 'content_filter';
    }

    return stopReason;
  }

  private normalizeToolCallArguments(input: unknown): string {
    if (isString(input)) {
      return input;
    }
    if (isNil(input)) {
      return '{}';
    }

    try {
      return JSON.stringify(input);
    } catch {
      return '{}';
    }
  }

  private convertClaudeToOpenAIResponse(
    claudeResponse: ClaudeResponse,
    model: string,
    clientToolNames?: ReadonlySet<string>,
  ): OpenAIChatResponse {
    return {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [this.convertClaudeToOpenAIChoice(claudeResponse, 0, clientToolNames)],
      usage: toOpenAIUsage(claudeResponse.usage),
    };
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
    const candidates =
      geminiResponse.candidates && geminiResponse.candidates.length > 0
        ? geminiResponse.candidates
        : [undefined];
    const choices = candidates.map((candidate, fallbackIndex) => {
      const candidateResponse: GeminiResponse = {
        ...geminiResponse,
        candidates: candidate ? [candidate] : [],
      };
      const claudeResponse = transformResponse(candidateResponse, signatureState, { webSearch });
      const candidateIndex = isNumber(candidate?.index) ? candidate.index : fallbackIndex;
      return this.convertClaudeToOpenAIChoice(
        claudeResponse,
        candidateIndex,
        clientToolNames,
        this.toOpenAIChatLogprobs(candidate?.logprobsResult, topLogprobs),
        webSearch
          ? toWebSearchResultSet(candidate?.groundingMetadata as GroundingMetadata | undefined)
          : null,
      );
    });
    const usageSource = transformResponse(
      { ...geminiResponse, candidates: candidates[0] ? [candidates[0]] : [] },
      undefined,
    );

    const openaiResponse: OpenAIChatResponse = {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices,
      usage: toOpenAIUsage(usageSource.usage),
      ...(serviceTier ? { service_tier: serviceTier } : {}),
    };

    const groundingResultSet = webSearch
      ? toWebSearchResultSet(candidates[0]?.groundingMetadata as GroundingMetadata | undefined)
      : null;
    return groundingResultSet
      ? attachWebSearchResults(openaiResponse, groundingResultSet)
      : openaiResponse;
  }

  private convertClaudeToOpenAIChoice(
    claudeResponse: ClaudeResponse,
    index: number,
    clientToolNames?: ReadonlySet<string>,
    logprobs: OpenAIChatLogprobs | null = null,
    webSearchResultSet: WebSearchResultSet | null = null,
  ): OpenAIChatResponse['choices'][number] {
    const contentBlocks = Array.isArray(claudeResponse?.content) ? claudeResponse.content : [];

    const textContent = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<ClaudeResponse['content'][number], { type: 'text'; text: string }> =>
          block?.type === 'text',
      )
      .map((block) => block.text || '')
      .join('');

    const reasoningContent = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<
          ClaudeResponse['content'][number],
          { type: 'thinking'; thinking: string }
        > => block?.type === 'thinking',
      )
      .map((block) => block.thinking || '')
      .join('');

    const toolCalls = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<
          ClaudeResponse['content'][number],
          { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        > => block?.type === 'tool_use',
      )
      .map((block, toolIndex: number) => {
        const splitName = splitNamespaceToolName(block.name || 'unknown_tool');
        const functionName = clientToolNames
          ? resolveShellToolName(splitName.name, clientToolNames)
          : splitName.name;
        const argumentsInput = isCustomToolCall(functionName)
          ? toCustomToolArguments(
              functionName,
              optimizeApplyPatch(extractCustomToolInput(functionName, block.input)).input,
            )
          : block.input;
        return {
          id: block.id || `tool-call-${toolIndex}`,
          type: 'function' as const,
          function: {
            name: functionName,
            arguments: this.normalizeToolCallArguments(argumentsInput),
          },
          namespace: splitName.namespace,
        };
      });

    const annotations = buildOpenAIUrlCitationAnnotations(textContent, webSearchResultSet);

    return {
      index,
      message: {
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning_content: reasoningContent || undefined,
        refusal: claudeResponse.refusal,
        ...(annotations.length > 0 ? { annotations } : {}),
      },
      logprobs,
      finish_reason: this.mapAnthropicStopReasonToOpenAIFinishReason(claudeResponse.stop_reason),
    };
  }

  private toOpenAIChatLogprobs(value: unknown, topLogprobs: number): OpenAIChatLogprobs | null {
    const result = this.toUnknownRecord(value);
    const chosenCandidates = Array.isArray(result?.chosenCandidates) ? result.chosenCandidates : [];
    const topCandidates = Array.isArray(result?.topCandidates) ? result.topCandidates : [];
    const content = chosenCandidates.flatMap((chosenValue, index) => {
      const chosen = this.toUnknownRecord(chosenValue);
      if (!chosen || !isString(chosen.token) || !isNumber(chosen.logProbability)) {
        return [];
      }
      const topGroup = this.toUnknownRecord(topCandidates[index]);
      const alternatives = Array.isArray(topGroup?.candidates)
        ? topGroup.candidates.slice(0, topLogprobs)
        : [];
      const mappedTopLogprobs = alternatives.flatMap((alternativeValue) => {
        const alternative = this.toUnknownRecord(alternativeValue);
        if (!alternative || !isString(alternative.token) || !isNumber(alternative.logProbability)) {
          return [];
        }
        return [
          {
            token: alternative.token,
            logprob: alternative.logProbability,
            bytes: Array.from(Buffer.from(alternative.token, 'utf8')),
          },
        ];
      });
      return [
        {
          token: chosen.token,
          logprob: chosen.logProbability,
          bytes: Array.from(Buffer.from(chosen.token, 'utf8')),
          top_logprobs: mappedTopLogprobs,
        },
      ];
    });

    return content.length > 0 ? { content } : null;
  }

  private extractAnthropicSessionKey(request: AnthropicChatRequest): string | undefined {
    const metadata = request.metadata;
    const sessionCandidate =
      metadata?.session_id ?? metadata?.sessionId ?? metadata?.user_id ?? metadata?.userId;
    if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
      return undefined;
    }
    return `anthropic:${sessionCandidate.trim()}`;
  }

  private extractOpenAISessionKey(request: OpenAIChatRequest): string | undefined {
    const metadata = request.metadata;
    const extra = request.extra;
    const sessionCandidate =
      request.user ??
      metadata?.session_id ??
      metadata?.sessionId ??
      metadata?.user_id ??
      metadata?.userId ??
      extra?.session_id ??
      extra?.sessionId ??
      extra?.user_id ??
      extra?.userId;
    if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
      return undefined;
    }
    return `openai:${sessionCandidate.trim()}`;
  }
}
