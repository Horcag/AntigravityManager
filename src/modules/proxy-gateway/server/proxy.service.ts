import { HttpStatus, Injectable, Logger, Inject } from '@nestjs/common';
import { isEmpty, isFunction, isNil, isNumber, isPlainObject, isString } from 'lodash-es';
import { AccountLeaseService } from './account-lease.service';
import { GeminiClient } from './clients/gemini.client';
import { UpstreamRequestError } from './clients/upstream-error';
import { AccountPoolUnavailableException, OpenAIProtocolException } from './openai-protocol-error';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { transformClaudeRequestIn } from '../antigravity/ClaudeRequestMapper';
import { transformResponse } from '../antigravity/ClaudeResponseMapper';
import { StreamingState, PartProcessor } from '../antigravity/ClaudeStreamingMapper';
import { type SignatureContext, SignatureStore } from '../antigravity/SignatureStore';
import { decodeSignature } from '../antigravity/signature-utils';
import {
  type GeminiResponsesGroundingMetadata,
  type GeminiResponsesStreamPart,
  type GeminiResponsesUsageMetadata,
  type OpenAIResponsesConfiguration,
  OpenAIResponsesStreamingMapper,
} from '../antigravity/OpenAIResponsesStreamingMapper';
import {
  ClaudeRequest,
  ClaudeResponse,
  GeminiInternalRequest,
  GeminiPart as InternalGeminiPart,
} from '../antigravity/types';
import { normalizeObjectJsonSchema } from '../antigravity/JsonSchemaUtils';
import { classifyStreamError } from '../antigravity/stream-error-utils';
import {
  OpenAIChatRequest,
  AnthropicChatRequest,
  GeminiResponse,
  GeminiRequest,
  AnthropicChatResponse,
  OpenAIChatResponse,
  AnthropicContent,
} from './interfaces/request-interfaces';
import { getServerConfig } from '../../../server/server-config';
import { resolveRequestUserAgent } from './request-user-agent';
import { CloudAccount } from '@/modules/cloud-account/types';
import { ProxyGenerationConstraints } from './proxy-generation-constraints';
import {
  ProxyRetryPolicy,
  type ProxyTokenRetryState,
  type ProxyUpstreamFailureClassification,
} from './proxy-retry-policy';
import { ProxyModelRoutingPolicy } from './proxy-model-routing-policy';
import { parseImageDataUrl } from './image-data-url';

interface StreamIdleTimer {
  reset: () => void;
  clear: () => void;
  dispose: () => void;
}

type OpenAIOutputProtocol = 'chat-completions' | 'responses' | 'text-completions';

/** Wire shape emitted by the OpenAI streaming mappers. */
type OpenAIStreamVariant = 'chat' | 'text';

interface OpenAIStreamOptions {
  variant: OpenAIStreamVariant;
  includeUsage: boolean;
  idPrefix?: 'chatcmpl' | 'cmpl';
}

interface OpenAIStreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly streamIdleTimeoutMs = 300_000;
  private readonly generationConstraints: ProxyGenerationConstraints;
  private readonly retryPolicy: ProxyRetryPolicy;
  private readonly modelRoutingPolicy = new ProxyModelRoutingPolicy();

  constructor(
    @Inject(AccountLeaseService) private readonly accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) private readonly geminiClient: GeminiClient,
  ) {
    this.generationConstraints = new ProxyGenerationConstraints(this.accountLeaseService);
    this.retryPolicy = new ProxyRetryPolicy(this.accountLeaseService, this.logger);
  }

  private createOfficialRequestId(): string {
    const timestampMs = Date.now();
    const randomHex = uuidv4().replace(/-/g, '').slice(0, 8);
    return `agent/${timestampMs}/${randomHex}`;
  }

  private createCloudCodeTraceId(): string {
    return `req_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  }

  private shouldEmitCloudCodeMeta(): boolean {
    return Boolean(getServerConfig()?.experimental?.enable_cloud_code_meta);
  }

  private createCloudCodeMetaChunk(traceId: string): string {
    const payload = {
      __cloudCodeMeta: {
        traceId,
      },
    };

    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  private destroyUpstreamStream(upstreamStream: NodeJS.ReadableStream): void {
    const destroy = (upstreamStream as { destroy?: () => void }).destroy;
    if (isFunction(destroy)) {
      destroy.call(upstreamStream);
    }
  }

  private createStreamIdleTimer(
    upstreamStream: NodeJS.ReadableStream,
    label: string,
    onTimeout: () => void,
  ): StreamIdleTimer {
    let idleTimer: NodeJS.Timeout | undefined;

    const clear = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const reset = (): void => {
      clear();
      idleTimer = setTimeout(() => {
        this.logger.error(`[${label}] Idle timeout after 300s, terminating stream`);
        onTimeout();
        this.destroyUpstreamStream(upstreamStream);
      }, this.streamIdleTimeoutMs);
    };

    return {
      reset,
      clear,
      dispose: () => {
        clear();
        this.destroyUpstreamStream(upstreamStream);
      },
    };
  }

  private createTokenRetryState(): ProxyTokenRetryState {
    return this.retryPolicy.createTokenRetryState();
  }

  private async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    return this.retryPolicy.selectRetryToken(retryState, model, sessionKey);
  }

  private async waitBeforeRetry(
    attemptIndex: number,
    maxRetries: number,
    label: string,
    shouldSkipBackoff: boolean,
  ): Promise<void> {
    await this.retryPolicy.waitBeforeRetry(attemptIndex, maxRetries, label, shouldSkipBackoff);
  }

  private async prepareGraceRetry(
    retryState: ProxyTokenRetryState,
    token: CloudAccount,
    error: unknown,
    label: string,
  ): Promise<boolean> {
    return this.retryPolicy.prepareGraceRetry(retryState, token, error, label);
  }

  // --- Anthropic Handlers ---

  async handleAnthropicMessages(
    request: AnthropicChatRequest,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    const sessionKey = this.extractAnthropicSessionKey(request);

    const targetModel = this.resolveTargetModel(request.model);
    const extraHeaders = this.createModelSpecificHeaders(request.model);
    this.logger.log(
      `Anthropic request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}`,
    );

    // Retry loop
    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(i, maxRetries, 'Anthropic', retryState.graceRetryToken !== null);

      const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
      if (!token) {
        throw new AccountPoolUnavailableException(
          'No healthy account is available',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );

      const signatureContext: SignatureContext = {
        accountId: token.id,
        model: effectiveTargetModel,
      };

      try {
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        const geminiBody = transformClaudeRequestIn(
          this.toClaudeRequest(request),
          projectId,
          requestUserAgent,
          signatureContext,
        );
        geminiBody.model = effectiveTargetModel;
        this.applyInternalGenerationConstraints(geminiBody, effectiveTargetModel, token.id);

        if (request.stream) {
          const stream = await this.geminiClient.streamGenerateInternal(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          return this.processAnthropicInternalStream(stream, geminiBody.model, signatureContext);
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          return this.toAnthropicChatResponse(transformResponse(response, signatureContext));
        }
      } catch (error) {
        if (error instanceof Error && this.isProjectContextError(error.message)) {
          this.logger.warn(
            `Anthropic request hit project context issue, retrying without project: ${error.message}`,
          );
          try {
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(
              this.toClaudeRequest(request),
              '',
              requestUserAgent,
              signatureContext,
            );
            fallbackBody.model = effectiveTargetModel;
            this.applyInternalGenerationConstraints(fallbackBody, effectiveTargetModel, token.id);
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              return this.processAnthropicInternalStream(
                stream,
                fallbackBody.model,
                signatureContext,
              );
            } else {
              const response = await this.generateInternalWithStreamFallback(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              return this.toAnthropicChatResponse(transformResponse(response, signatureContext));
            }
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        }

        if (error instanceof Error && this.isQuotaExhaustedError(error.message)) {
          this.logger.warn(
            `Anthropic request hit quota exhaustion on mapped model, retrying with fallback model gemini-3-flash: ${error.message}`,
          );
          try {
            const downgradedRequest: ClaudeRequest = {
              ...this.toClaudeRequest(request),
              model: 'gemini-3-flash',
            };
            const requestUserAgent = await resolveRequestUserAgent();
            const downgradedSignatureContext: SignatureContext = {
              accountId: token.id,
              model: 'gemini-3-flash',
            };
            const downgradedBody = transformClaudeRequestIn(
              downgradedRequest,
              token.token.project_id ?? '',
              requestUserAgent,
              downgradedSignatureContext,
            );
            this.applyInternalGenerationConstraints(downgradedBody, 'gemini-3-flash', token.id);
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                downgradedBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              return this.processAnthropicInternalStream(
                stream,
                downgradedBody.model,
                downgradedSignatureContext,
              );
            } else {
              const response = await this.generateInternalWithStreamFallback(
                downgradedBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              const transformed = this.toAnthropicChatResponse(
                transformResponse(response, downgradedSignatureContext),
              );
              return {
                ...transformed,
                model: request.model,
              };
            }
          } catch (downgradeErr) {
            lastError = downgradeErr;
          }
        }

        lastError = error;
        if (await this.prepareGraceRetry(retryState, token, lastError, 'Anthropic')) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveTargetModel, error);
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private processAnthropicInternalStream(
    upstreamStream: NodeJS.ReadableStream,
    _model: string,
    signatureContext?: SignatureContext,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';

      const state = new StreamingState();
      const processor = new PartProcessor(state, signatureContext);

      let lastFinishReason: string | undefined;
      let lastUsageMetadata: Record<string, unknown> | undefined;

      let hasUsableEvent = false;
      let terminated = false;
      let idleTimer: StreamIdleTimer;
      const failStream = (error: Error): void => {
        if (terminated) {
          return;
        }
        terminated = true;
        idleTimer.clear();
        subscriber.error(error);
      };
      idleTimer = this.createStreamIdleTimer(upstreamStream, 'Claude-SSE', () => {
        failStream(new Error('Upstream stream idle timeout after 300s'));
      });

      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        if (terminated) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (terminated) {
            return;
          }
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice('data:'.length).trim();
          if (dataStr.length === 0 || dataStr === '[DONE]') continue;

          try {
            const json = JSON.parse(dataStr);

            if (json) {
              const startMsg = state.emitMessageStart(json);
              if (startMsg) {
                hasUsableEvent = true;
                subscriber.next(startMsg);
              }
            }

            const candidate = json.candidates?.[0];
            const parts = candidate?.content?.parts;

            if (candidate?.finishReason) {
              lastFinishReason = candidate.finishReason;
            }
            if (json.usageMetadata) {
              lastUsageMetadata = json.usageMetadata;
            }

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
            this.logger.error('Stream parse error', e);
            const errorChunks = state.handleParseError(dataStr);
            errorChunks.forEach((c) => subscriber.next(c));
            if (state.getErrorCount() > 3) {
              failStream(new Error('Malformed upstream stream payload'));
              return;
            }
          }
        }
      });

      upstreamStream.on('end', () => {
        if (terminated) {
          return;
        }
        idleTimer.clear();
        if (!hasUsableEvent || !state.messageStartSent) {
          this.logger.warn('Upstream stream ended without a usable Anthropic message start');
          failStream(new Error('Empty response stream'));
          return;
        }

        const finishChunks = state.emitFinish(lastFinishReason, lastUsageMetadata);
        finishChunks.forEach((c) => subscriber.next(c));
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        const cleanError = err instanceof Error ? err : new Error(String(err));
        const { type } = classifyStreamError(cleanError);

        this.logger.error(`Stream error: ${type} - ${cleanError.message}`);
        failStream(cleanError);
      });

      return () => {
        idleTimer.dispose();
      };
    });
  }

  // --- OpenAI / Universal Handlers ---
  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
  ): Promise<GeminiResponse> {
    const normalizedModel = this.normalizeGeminiModel(model);
    const targetModel = this.resolveTargetModel(normalizedModel);
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log(
      `Gemini generate request received: model=${normalizedModel}, mappedModel=${targetModel}`,
    );

    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(i, maxRetries, 'Gemini', retryState.graceRetryToken !== null);

      const token = await this.selectRetryToken(retryState, targetModel);
      if (!token) {
        throw new AccountPoolUnavailableException(
          'All available accounts are exhausted or rate limited',
          HttpStatus.TOO_MANY_REQUESTS,
        );
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
        );

        return this.normalizeGeminiGenerateResponse(response);
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
            );
            return this.normalizeGeminiGenerateResponse(response);
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
    const targetModel = this.resolveTargetModel(normalizedModel);
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
      );

      const token = await this.selectRetryToken(retryState, targetModel);
      if (!token) {
        throw new AccountPoolUnavailableException(
          'All available accounts are exhausted or rate limited',
          HttpStatus.TOO_MANY_REQUESTS,
        );
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
        );
        return this.passthroughSseStream(stream);
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
            );
            return this.passthroughSseStream(stream);
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

  private passthroughSseStream(upstreamStream: NodeJS.ReadableStream): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let receivedData = false;
      let terminated = false;
      let idleTimer: StreamIdleTimer;
      const failStream = (error: Error): void => {
        if (terminated) {
          return;
        }
        terminated = true;
        idleTimer.clear();
        subscriber.error(error);
      };
      idleTimer = this.createStreamIdleTimer(upstreamStream, 'Gemini-SSE', () => {
        failStream(new Error('Upstream stream idle timeout after 300s'));
      });

      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        if (terminated) {
          return;
        }
        receivedData = true;
        idleTimer.reset();
        subscriber.next(decoder.decode(chunk, { stream: true }));
      });

      upstreamStream.on('end', () => {
        if (terminated) {
          return;
        }
        idleTimer.clear();
        if (!receivedData) {
          subscriber.error(new Error('Empty response stream'));
          return;
        }
        terminated = true;
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        const cleanError = err instanceof Error ? new Error(err.message) : new Error(String(err));
        failStream(cleanError);
      });

      return () => {
        idleTimer.dispose();
      };
    });
  }

  private normalizeGeminiModel(model: string): string {
    return this.modelRoutingPolicy.normalizeGeminiModel(model);
  }

  private applyInternalGenerationConstraints(
    body: GeminiInternalRequest,
    model: string,
    accountId: string,
  ): void {
    this.generationConstraints.applyInternalGenerationConstraints(body, model, accountId);
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

  private normalizeGeminiGenerateResponse(response: GeminiResponse): GeminiResponse {
    const candidates = Array.isArray(response.candidates)
      ? response.candidates.map((candidate, index) => ({
          content: candidate?.content,
          finishReason: candidate?.finishReason,
          index: isNumber(candidate?.index) ? candidate.index : index,
        }))
      : [];

    const normalized: GeminiResponse = {
      candidates,
    };

    const usage = response.usageMetadata;
    if (usage) {
      const usageMetadata: NonNullable<GeminiResponse['usageMetadata']> = {};
      if (usage.promptTokenCount !== undefined) {
        usageMetadata.promptTokenCount = usage.promptTokenCount;
      }
      if (usage.candidatesTokenCount !== undefined) {
        usageMetadata.candidatesTokenCount = usage.candidatesTokenCount;
      }
      if (usage.totalTokenCount !== undefined) {
        usageMetadata.totalTokenCount = usage.totalTokenCount;
      }
      if (usage.promptTokensDetails !== undefined) {
        usageMetadata.promptTokensDetails = usage.promptTokensDetails;
      }
      if (usage.candidatesTokensDetails !== undefined) {
        usageMetadata.candidatesTokensDetails = usage.candidatesTokensDetails;
      }
      if (usage.trafficType !== undefined) {
        usageMetadata.trafficType = usage.trafficType;
      }
      if (!isEmpty(usageMetadata)) {
        normalized.usageMetadata = usageMetadata;
      }
    }

    return normalized;
  }

  async handleChatCompletions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
    responsesConfiguration?: OpenAIResponsesConfiguration,
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const sessionKey = this.extractOpenAISessionKey(request);

    const targetModel = this.resolveTargetModel(request.model);
    const extraHeaders = this.createModelSpecificHeaders(request.model);
    this.logger.log(
      `OpenAI-compatible request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}`,
    );

    // Deterministic request conversion happens before any account is leased so a local
    // mapping failure never selects an account or penalizes one.
    const claudeRequest = this.convertOpenAIToClaude(request);
    const streamOptions = this.resolveOpenAIStreamOptions(request, outputProtocol);

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
      );

      // 1. Get Token
      const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
      if (!token) {
        throw new AccountPoolUnavailableException(
          'All available accounts are exhausted or rate limited',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );

      const signatureContext: SignatureContext = {
        accountId: token.id,
        model: effectiveTargetModel,
      };

      try {
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        const geminiBody = transformClaudeRequestIn(
          claudeRequest,
          projectId,
          requestUserAgent,
          signatureContext,
        );
        geminiBody.model = effectiveTargetModel;
        this.applyInternalGenerationConstraints(geminiBody, effectiveTargetModel, token.id);

        // Use v1internal API (same as Anthropic handler)
        if (request.stream) {
          try {
            const stream = await this.geminiClient.streamGenerateInternal(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            return this.createOpenAIProtocolStream(
              stream,
              request.model,
              outputProtocol,
              streamOptions,
              signatureContext,
              responsesConfiguration,
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
            );
            this.logger.log(
              `Upstream response snippet after stream fallback: ${JSON.stringify(response).substring(0, 500)}`,
            );
            const claudeResponse = transformResponse(response, signatureContext);
            const openaiResponse = this.convertClaudeToOpenAIResponse(
              claudeResponse,
              request.model,
              response.usageMetadata,
              outputProtocol,
            );
            return outputProtocol === 'responses'
              ? this.createSyntheticResponsesStream(openaiResponse, responsesConfiguration)
              : this.createSyntheticOpenAIStream(openaiResponse, streamOptions);
          }
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          this.logger.log(
            `Upstream response snippet (non-stream): ${JSON.stringify(response).substring(0, 500)}`,
          );
          // Transform Gemini response to OpenAI format
          const claudeResponse = transformResponse(response, signatureContext);
          this.logger.log(
            `Transformed Claude response snippet: ${JSON.stringify(claudeResponse).substring(0, 500)}`,
          );
          return this.convertClaudeToOpenAIResponse(
            claudeResponse,
            request.model,
            response.usageMetadata,
            outputProtocol,
          );
        }
      } catch (err) {
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `OpenAI compatibility request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(
              claudeRequest,
              '',
              requestUserAgent,
              signatureContext,
            );
            fallbackBody.model = effectiveTargetModel;
            this.applyInternalGenerationConstraints(fallbackBody, effectiveTargetModel, token.id);
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              return this.createOpenAIProtocolStream(
                stream,
                request.model,
                outputProtocol,
                streamOptions,
                signatureContext,
                responsesConfiguration,
              );
            }

            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            const claudeResponse = transformResponse(response, signatureContext);
            return this.convertClaudeToOpenAIResponse(
              claudeResponse,
              request.model,
              response.usageMetadata,
              outputProtocol,
            );
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        if (await this.prepareGraceRetry(retryState, token, lastError, 'OpenAI-compatible')) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveTargetModel, lastError);
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private async generateInternalWithStreamFallback(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<GeminiResponse> {
    const direct = await this.geminiClient.generateInternal(
      body,
      accessToken,
      upstreamProxyUrl,
      extraHeaders,
    );
    if (this.hasUsableGeminiCandidate(direct)) {
      return direct;
    }

    this.logger.warn('Empty non-stream response detected, falling back to stream aggregation.');
    const stream = await this.geminiClient.streamGenerateInternal(
      body,
      accessToken,
      upstreamProxyUrl,
      extraHeaders,
    );
    return this.collectGeminiStreamAsResponse(stream);
  }

  private hasUsableGeminiCandidate(response: GeminiResponse): boolean {
    const candidates = response?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return false;
    }

    const first = candidates[0];
    const parts = first?.content?.parts;
    return Array.isArray(parts) && parts.length > 0;
  }

  private collectGeminiStreamAsResponse(
    upstreamStream: NodeJS.ReadableStream,
  ): Promise<GeminiResponse> {
    return new Promise((resolve, reject) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let receivedData = false;
      const mergedParts: InternalGeminiPart[] = [];
      let finishReason: string | undefined;
      let usageMetadata: GeminiResponse['usageMetadata'];
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Gemini-Collect', () => {
        reject(new Error('Stream idle timeout'));
      });

      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        receivedData = true;
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) {
            continue;
          }

          const dataStr = trimmed.slice('data:'.length).trim();
          if (dataStr.length === 0 || dataStr === '[DONE]') {
            continue;
          }

          try {
            const parsed = JSON.parse(dataStr);
            const candidate = parsed?.candidates?.[0];
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
              mergedParts.push(
                ...parts.filter((part): part is InternalGeminiPart => this.isGeminiPart(part)),
              );
            }

            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }
            if (parsed?.usageMetadata) {
              usageMetadata = parsed.usageMetadata;
            }
          } catch {
            // Ignore malformed chunks and continue collecting valid parts.
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        if (!receivedData) {
          reject(new Error('Empty response stream'));
          return;
        }

        resolve({
          candidates: [
            {
              content: {
                role: 'model',
                parts: mergedParts,
              },
              finishReason,
            },
          ],
          usageMetadata,
        });
      });

      upstreamStream.on('error', (error: unknown) => {
        idleTimer.clear();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private createOpenAIProtocolStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    outputProtocol: OpenAIOutputProtocol,
    streamOptions: OpenAIStreamOptions,
    signatureContext?: SignatureContext,
    responsesConfiguration?: OpenAIResponsesConfiguration,
  ): Observable<string> {
    if (outputProtocol === 'responses') {
      return this.processResponsesStreamResponse(
        upstreamStream,
        model,
        signatureContext,
        responsesConfiguration,
      );
    }
    return this.processStreamResponse(upstreamStream, model, signatureContext, streamOptions);
  }

  private resolveOpenAIStreamOptions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol,
  ): OpenAIStreamOptions {
    return {
      variant: outputProtocol === 'text-completions' ? 'text' : 'chat',
      includeUsage: request.stream_options?.include_usage === true,
      idPrefix: outputProtocol === 'text-completions' ? 'cmpl' : 'chatcmpl',
    };
  }

  /**
   * Maps upstream Gemini usage metadata onto the OpenAI usage shape, and only that.
   * Both the prompt and the candidates counters have to be real numbers before any
   * usage can be reported: empty or partial metadata returns null so no caller can put
   * an invented 0/0/0 on the wire. `thoughtsTokenCount` stays optional because upstreams
   * omit it for non-thinking models, where it is genuinely zero rather than unknown.
   */
  private mapGeminiUsageMetadata(usage: unknown): OpenAIStreamUsage | null {
    const record = this.toUnknownRecord(usage);
    if (!record) {
      return null;
    }

    const promptTokens = record.promptTokenCount;
    const candidatesTokens = record.candidatesTokenCount;
    if (!isNumber(promptTokens) || !isNumber(candidatesTokens)) {
      return null;
    }

    const thoughtsTokens = isNumber(record.thoughtsTokenCount) ? record.thoughtsTokenCount : 0;
    const completionTokens = candidatesTokens + thoughtsTokens;
    const totalTokens = isNumber(record.totalTokenCount)
      ? record.totalTokenCount
      : promptTokens + completionTokens;

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      ...(thoughtsTokens > 0
        ? { completion_tokens_details: { reasoning_tokens: thoughtsTokens } }
        : {}),
    };
  }

  private processResponsesStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureContext?: SignatureContext,
    responsesConfiguration?: OpenAIResponsesConfiguration,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      let receivedUsableCandidate = false;
      const mapper = new OpenAIResponsesStreamingMapper({
        model,
        responseId: `resp_${uuidv4()}`,
        signatureContext,
        configuration: responsesConfiguration,
      });
      let heartbeatTimer: NodeJS.Timeout | undefined;

      const clearHeartbeat = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      const complete = (finishReason?: string): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearHeartbeat();
        for (const event of mapper.complete(finishReason)) {
          subscriber.next(event);
        }
        subscriber.complete();
      };

      const fail = (message: string, code = 'upstream_error'): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearHeartbeat();
        idleTimer.clear();
        for (const event of mapper.fail(message, code)) {
          subscriber.next(event);
        }
        subscriber.complete();
      };

      subscriber.next(mapper.createResponseCreatedEvent());
      subscriber.next(mapper.createResponseInProgressEvent());
      heartbeatTimer = setInterval(() => {
        if (!completed) {
          subscriber.next(': ping\n\n');
        }
      }, 15_000);
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'OpenAI-Responses-SSE', () =>
        fail('Upstream Responses stream timed out', 'stream_timeout'),
      );
      idleTimer.reset();

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          return;
        }
        const dataString = trimmed.slice('data:'.length).trim();
        if (dataString.length === 0 || dataString === '[DONE]') {
          return;
        }
        try {
          const payload = this.toUnknownRecord(JSON.parse(dataString));
          if (!payload) {
            fail('Upstream Responses stream payload was not an object', 'invalid_upstream_payload');
            return;
          }
          const upstreamError = this.toUnknownRecord(payload.error);
          if (upstreamError) {
            fail(
              isString(upstreamError.message)
                ? upstreamError.message
                : 'Upstream Responses stream returned an error',
              'upstream_error',
            );
            return;
          }
          const responsePayload = this.toUnknownRecord(payload.response) ?? payload;
          const usageMetadata = this.toResponsesUsageMetadata(
            responsePayload.usageMetadata ?? payload.usageMetadata,
          );
          if (!Array.isArray(responsePayload.candidates)) {
            if (receivedUsableCandidate && usageMetadata) {
              mapper.setUsageMetadata(usageMetadata);
              return;
            }
            fail(
              'Upstream Responses stream payload did not include candidates',
              'invalid_upstream_payload',
            );
            return;
          }
          const candidate = this.toUnknownRecord(responsePayload.candidates[0]);
          if (!candidate) {
            fail(
              'Upstream Responses stream payload did not include a usable candidate',
              'invalid_upstream_payload',
            );
            return;
          }
          receivedUsableCandidate = true;
          mapper.setUsageMetadata(usageMetadata);
          const content = this.toUnknownRecord(candidate?.content);
          if (Array.isArray(content?.parts)) {
            for (const part of content.parts) {
              const normalizedPart = this.toResponsesStreamPart(part);
              if (normalizedPart) {
                for (const event of mapper.processPart(normalizedPart)) {
                  subscriber.next(event);
                }
              }
            }
          }
          const grounding = this.toResponsesGroundingMetadata(candidate?.groundingMetadata);
          if (grounding) {
            for (const event of mapper.processGrounding(grounding)) {
              subscriber.next(event);
            }
          }
          if (isString(candidate?.finishReason) && candidate.finishReason.length > 0) {
            complete(candidate.finishReason);
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Malformed upstream Responses JSON';
          fail(`Malformed upstream Responses JSON: ${message}`, 'invalid_upstream_payload');
        }
      };

      upstreamStream.on('data', (chunk: Buffer) => {
        if (completed) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
          if (completed) {
            return;
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        if (buffer.trim()) {
          processLine(buffer);
        }
        if (!receivedUsableCandidate) {
          fail('Upstream Responses stream was empty', 'empty_stream');
          return;
        }
        complete();
      });

      upstreamStream.on('error', (error: unknown) => {
        idleTimer.clear();
        const cleanError =
          error instanceof Error ? new Error(error.message) : new Error(String(error));
        this.logger.error(`OpenAI Responses stream error: ${cleanError.message}`);
        fail(cleanError.message, 'upstream_error');
      });

      return () => {
        clearHeartbeat();
        idleTimer.dispose();
      };
    });
  }

  private toResponsesStreamPart(value: unknown): GeminiResponsesStreamPart | null {
    const part = this.toUnknownRecord(value);
    if (!part) {
      return null;
    }

    const functionCallRecord = this.toUnknownRecord(part.functionCall);
    const functionName = isString(functionCallRecord?.name) ? functionCallRecord.name : null;
    const functionArgs = this.toUnknownRecord(functionCallRecord?.args) ?? {};
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
            args: functionArgs,
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

  private toResponsesUsageMetadata(value: unknown): GeminiResponsesUsageMetadata | undefined {
    const usage = this.toUnknownRecord(value);
    if (!usage) {
      return undefined;
    }
    return {
      candidatesTokenCount: isNumber(usage.candidatesTokenCount)
        ? usage.candidatesTokenCount
        : undefined,
      promptTokenCount: isNumber(usage.promptTokenCount) ? usage.promptTokenCount : undefined,
      thoughtsTokenCount: isNumber(usage.thoughtsTokenCount) ? usage.thoughtsTokenCount : undefined,
      totalTokenCount: isNumber(usage.totalTokenCount) ? usage.totalTokenCount : undefined,
    };
  }

  private toUnknownRecord(value: unknown): Record<string, unknown> | null {
    if (!isPlainObject(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private buildOpenAIStreamChunk(
    identity: { streamId: string; created: number; model: string },
    streamOptions: OpenAIStreamOptions,
    choices: Array<Record<string, unknown>>,
    usage?: OpenAIStreamUsage,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      id: identity.streamId,
      object: streamOptions.variant === 'text' ? 'text_completion' : 'chat.completion.chunk',
      created: identity.created,
      model: identity.model,
      choices,
    };
    // Official semantics: usage is present-but-null on normal chunks only when the
    // caller opted in, and never fabricated otherwise.
    if (streamOptions.includeUsage) {
      payload.usage = usage ?? null;
    }
    return payload;
  }

  private buildOpenAIContentChoice(
    variant: OpenAIStreamVariant,
    text: string,
  ): Record<string, unknown> {
    if (variant === 'text') {
      return { text, index: 0, logprobs: null, finish_reason: null };
    }
    return { index: 0, delta: { content: text }, finish_reason: null };
  }

  private buildOpenAIAssistantRoleChoice(): Record<string, unknown> {
    return { index: 0, delta: { role: 'assistant' }, finish_reason: null };
  }

  private buildOpenAIFinishChoice(
    variant: OpenAIStreamVariant,
    finishReason: string | null,
  ): Record<string, unknown> {
    if (variant === 'text') {
      return { text: '', index: 0, logprobs: null, finish_reason: finishReason };
    }
    return { index: 0, delta: {}, finish_reason: finishReason };
  }

  // Handle SSE Stream conversion
  private processStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureContext?: SignatureContext,
    streamOptions: OpenAIStreamOptions = { variant: 'chat', includeUsage: false },
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let hasEmittedChunk = false;
      let hasSentDone = false;
      let terminated = false;
      let emittedToolCall = false;
      let lastUsage: OpenAIStreamUsage | null = null;
      const toolCallIndices = new Map<string, number>();
      /** Signature seen earlier in THIS stream, used only for tool calls of this same stream. */
      let streamSignature: string | null = null;

      const idPrefix =
        streamOptions.idPrefix ?? (streamOptions.variant === 'text' ? 'cmpl' : 'chatcmpl');
      const streamId = `${idPrefix}-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);
      const identity = { streamId, created, model };
      const isTextVariant = streamOptions.variant === 'text';
      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      const pushChoice = (choice: Record<string, unknown>, countsAsUsable = true): void => {
        if (countsAsUsable) {
          hasEmittedChunk = true;
        }
        subscriber.next(
          `data: ${JSON.stringify(this.buildOpenAIStreamChunk(identity, streamOptions, [choice]))}\n\n`,
        );
      };

      if (!isTextVariant) {
        pushChoice(this.buildOpenAIAssistantRoleChoice(), false);
      }

      const sendDone = (): void => {
        if (hasSentDone) {
          return;
        }
        // Only emit the usage-only frame when upstream actually reported usage.
        // Fabricating a zero-token frame would be a lie on the wire.
        if (streamOptions.includeUsage && lastUsage) {
          subscriber.next(
            `data: ${JSON.stringify(
              this.buildOpenAIStreamChunk(identity, streamOptions, [], lastUsage),
            )}\n\n`,
          );
        }
        subscriber.next('data: [DONE]\n\n');
        hasSentDone = true;
      };

      const failStream = (error: Error): void => {
        if (terminated) {
          return;
        }
        terminated = true;
        idleTimer.clear();
        this.logger.error(`OpenAI-compatible stream error: ${error.message}`);
        subscriber.error(error);
      };

      // An idle stream is a failed stream: terminate through the error path so the
      // client never mistakes a stalled upstream for a successful completion.
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'OpenAI-SSE', () => {
        failStream(new Error('Upstream stream idle timeout after 300s'));
      });

      idleTimer.reset();

      const handleLine = (line: string): void => {
        if (terminated) {
          return;
        }
        const trimmed = line.trim();
        // Upstreams emit both "data:" and "data: " forms.
        if (!trimmed.startsWith('data:')) return;

        const dataStr = trimmed.slice('data:'.length).trim();
        if (dataStr.length === 0 || dataStr === '[DONE]') return;

        let json: any;
        try {
          json = JSON.parse(dataStr);
        } catch {
          // A malformed upstream payload is a real failure: surface one terminal
          // stream error instead of silently completing as a successful stream.
          failStream(new Error('Malformed upstream stream payload'));
          return;
        }

        if (json?.error) {
          const upstreamMessage = isString(json.error?.message) ? json.error.message : undefined;
          failStream(new Error(upstreamMessage ?? 'Upstream stream returned an error payload'));
          return;
        }

        {
          const candidate = json?.candidates?.[0];
          const parts = candidate?.content?.parts || [];

          // Partial metadata leaves the previously reported usage untouched rather than
          // downgrading it to zeros.
          const mappedUsage = this.mapGeminiUsageMetadata(json?.usageMetadata);
          if (mappedUsage) {
            lastUsage = mappedUsage;
          }

          for (const part of parts) {
            const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature);
            if (signature) {
              streamSignature = signature;
            }

            if (part.thought && part.text) {
              if (isTextVariant) {
                // Legacy completions have no reasoning channel.
                continue;
              }
              pushChoice({
                index: 0,
                delta: { reasoning_content: part.text },
                finish_reason: null,
              });
              continue;
            }

            if (part.functionCall) {
              const toolCallId =
                part.functionCall.id || [part.functionCall.name, uuidv4()].join('-');
              if (part.functionCall.id && toolCallIndices.has(toolCallId)) {
                continue;
              }
              const toolCallIndex = toolCallIndices.get(toolCallId) ?? toolCallIndices.size;
              toolCallIndices.set(toolCallId, toolCallIndex);
              // Capture for replay under the id the client actually sees (upstream id when
              // Gemini supplies one, otherwise the generated id), keyed by the account/model
              // that produced it.
              const capturedSignature = signature ?? streamSignature;
              if (capturedSignature && signatureContext) {
                SignatureStore.store(
                  {
                    accountId: signatureContext.accountId,
                    model: signatureContext.model,
                    toolCallId: toolCallId,
                  },
                  capturedSignature,
                );
              }
              if (isTextVariant) {
                // Legacy completions cannot express tool calls.
                continue;
              }
              emittedToolCall = true;
              pushChoice({
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolCallIndex,
                      id: toolCallId,
                      type: 'function',
                      function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args || {}),
                      },
                    },
                  ],
                },
                finish_reason: null,
              });
              continue;
            }

            if (part.inlineData) {
              const mimeType = part.inlineData.mimeType || 'image/jpeg';
              const data = part.inlineData.data || '';
              const imageMarkdown = `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`;
              pushChoice(this.buildOpenAIContentChoice(streamOptions.variant, imageMarkdown));
              continue;
            }

            if (part.text) {
              pushChoice(this.buildOpenAIContentChoice(streamOptions.variant, part.text));
            }
          }

          if (candidate?.finishReason) {
            const mappedFinishReason = emittedToolCall
              ? 'tool_calls'
              : this.mapGeminiFinishReasonToOpenAIFinishReason(candidate.finishReason);
            pushChoice(this.buildOpenAIFinishChoice(streamOptions.variant, mappedFinishReason));
            terminated = true;
            idleTimer.clear();
            sendDone();
            subscriber.complete();
            return;
          }
        }
      };

      upstreamStream.on('data', (chunk: Buffer) => {
        if (terminated) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (terminated) {
            return;
          }
          handleLine(line);
        }
      });

      upstreamStream.on('end', () => {
        if (terminated) {
          return;
        }
        // Upstream may end without a trailing newline: flush the decoder and process
        // whatever data line is still buffered before deciding how the stream ends.
        buffer += decoder.decode();
        const pending = buffer;
        buffer = '';
        for (const line of pending.split('\n')) {
          if (terminated) {
            return;
          }
          handleLine(line);
        }
        if (terminated) {
          return;
        }
        if (!hasEmittedChunk) {
          // No candidate, no content, no finish reason: this is a failed stream, not an
          // empty success. Terminate through the error path and emit no [DONE].
          failStream(new Error('Upstream stream ended without any usable content'));
          return;
        }
        terminated = true;
        idleTimer.clear();
        sendDone();
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        // Convert to clean Error to avoid circular reference issues (socket objects)
        failStream(err instanceof Error ? new Error(err.message) : new Error(String(err)));
      });

      return () => {
        idleTimer.dispose();
      };
    });
  }

  private createSyntheticOpenAIStream(
    response: OpenAIChatResponse,
    streamOptions: OpenAIStreamOptions = { variant: 'chat', includeUsage: false },
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const idPrefix =
        streamOptions.idPrefix ?? (streamOptions.variant === 'text' ? 'cmpl' : 'chatcmpl');
      const streamId = response.id || `${idPrefix}-${uuidv4()}`;
      const created = response.created || Math.floor(Date.now() / 1000);
      const model = response.model;
      const identity = { streamId, created, model };
      const choice = response.choices?.[0];
      const toolCalls = choice?.message?.tool_calls ?? [];
      // Legacy text completions have no tool-call channel, so they never claim tool_calls.
      const emitsToolCalls = streamOptions.variant !== 'text' && toolCalls.length > 0;
      const finishReason = emitsToolCalls ? 'tool_calls' : (choice?.finish_reason ?? 'stop');
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : '';
      const chunkSize = 80;

      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      const pushChoice = (payloadChoice: Record<string, unknown>): void => {
        subscriber.next(
          `data: ${JSON.stringify(
            this.buildOpenAIStreamChunk(identity, streamOptions, [payloadChoice]),
          )}\n\n`,
        );
      };

      if (streamOptions.variant !== 'text') {
        pushChoice(this.buildOpenAIAssistantRoleChoice());
      }

      const sendDone = (): void => {
        // Never invent usage the upstream response did not carry.
        if (streamOptions.includeUsage && response.usage) {
          subscriber.next(
            `data: ${JSON.stringify(
              this.buildOpenAIStreamChunk(identity, streamOptions, [], {
                prompt_tokens: response.usage.prompt_tokens,
                completion_tokens: response.usage.completion_tokens,
                total_tokens: response.usage.total_tokens,
              }),
            )}\n\n`,
          );
        }
        subscriber.next('data: [DONE]\n\n');
        subscriber.complete();
      };

      for (let index = 0; index < content.length; index += chunkSize) {
        const piece = content.slice(index, index + chunkSize);
        const isLast = index + chunkSize >= content.length;
        const payloadChoice = this.buildOpenAIContentChoice(streamOptions.variant, piece);
        // The finish chunk is deferred when tool-call deltas still have to be emitted.
        if (isLast && !emitsToolCalls) {
          payloadChoice.finish_reason = finishReason;
        }
        pushChoice(payloadChoice);
      }

      if (emitsToolCalls) {
        // Replay the actual calls on the wire with their original ids and deterministic
        // indexes, so a synthetic fallback stream is not silently stripped of tool calls.
        toolCalls.forEach((toolCall, toolCallIndex) => {
          pushChoice({
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: toolCall.id,
                  type: 'function',
                  function: {
                    name: toolCall.function.name,
                    arguments: toolCall.function.arguments,
                  },
                },
              ],
            },
            finish_reason: null,
          });
        });
      }

      if (content.length === 0 || emitsToolCalls) {
        pushChoice(this.buildOpenAIFinishChoice(streamOptions.variant, finishReason));
      }

      sendDone();
    });
  }

  private createSyntheticResponsesStream(
    response: OpenAIChatResponse,
    configuration?: OpenAIResponsesConfiguration,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const mapper = new OpenAIResponsesStreamingMapper({
        model: response.model,
        responseId: `resp_${uuidv4()}`,
        configuration,
      });
      const choice = response.choices?.[0];
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : undefined;

      subscriber.next(mapper.createResponseCreatedEvent());
      subscriber.next(mapper.createResponseInProgressEvent());
      if (response.usage) {
        const reasoningTokens = response.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        mapper.setUsageMetadata({
          candidatesTokenCount: response.usage.completion_tokens - reasoningTokens,
          promptTokenCount: response.usage.prompt_tokens,
          thoughtsTokenCount: reasoningTokens,
          totalTokenCount: response.usage.total_tokens,
        });
      }
      if (content) {
        for (const event of mapper.processPart({ text: content })) {
          subscriber.next(event);
        }
      }

      for (const toolCall of choice?.message?.tool_calls ?? []) {
        for (const event of mapper.processPart({
          functionCall: {
            args: this.parseOpenAIFunctionArguments(toolCall.function.arguments),
            id: toolCall.id,
            name: toolCall.function.name,
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

  private toClaudeRequest(request: AnthropicChatRequest): ClaudeRequest {
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
      metadata: request.metadata,
    };
  }

  private toAnthropicChatResponse(response: ClaudeResponse): AnthropicChatResponse {
    return {
      id: response.id,
      type: response.type,
      role: response.role,
      model: response.model,
      content: response.content,
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
      usage: {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
        cache_read_input_tokens: response.usage?.cache_read_input_tokens,
      },
    };
  }

  private toInternalGeminiRequest(request: GeminiRequest): GeminiInternalRequest['request'] {
    return {
      contents: request.contents,
      generationConfig: request.generationConfig,
      systemInstruction: request.systemInstruction
        ? {
            parts: request.systemInstruction.parts
              .filter((part): part is { text: string } => isString(part.text))
              .map((part) => ({ text: part.text })),
          }
        : undefined,
    };
  }

  // Convert OpenAI request format to Claude/Anthropic format
  private convertOpenAIToClaude(request: OpenAIChatRequest): ClaudeRequest {
    const messages = request.messages || [];
    const systemPromptParts: string[] = [];
    const anthropicMessages: ClaudeRequest['messages'] = [];

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const msg = messages[messageIndex];
      // `developer` is the current OpenAI spelling of `system`; both are instructions,
      // never user turns.
      if (msg.role === 'system' || msg.role === 'developer') {
        const systemText = this.extractOpenAITextContent(msg.content);
        if (systemText) {
          systemPromptParts.push(systemText);
        }
        continue;
      }

      if (msg.role === 'tool') {
        const toolResults: AnthropicContent[] = [];
        do {
          const toolMessage = messages[messageIndex];
          const toolResultText = this.extractOpenAITextContent(toolMessage.content) || '';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolMessage.tool_call_id ?? '',
            content: toolResultText,
            is_error: false,
          });
          messageIndex++;
        } while (messages[messageIndex]?.role === 'tool');

        anthropicMessages.push({
          role: 'user',
          content: toolResults,
        });
        messageIndex--;
        continue;
      }

      const contentBlocks = this.convertOpenAIPartsToAnthropicContent(msg.content);

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          contentBlocks.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: this.parseOpenAIFunctionArguments(toolCall.function.arguments),
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
      tools: this.convertOpenAIToolsToAnthropicTools(request.tools),
      tool_choice: this.convertOpenAIToolChoice(request.tool_choice, request.tools),
      max_tokens: request.max_completion_tokens ?? request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stop_sequences: this.convertOpenAIStopSequences(request.stop),
      response_mime_type: this.convertOpenAIResponseFormat(request.response_format),
      stream: request.stream,
      metadata: {
        ...(request.extra ?? {}),
        source: 'openai',
      },
    };
  }

  private convertOpenAIToolChoice(
    toolChoice: unknown,
    tools: OpenAIChatRequest['tools'],
  ): ClaudeRequest['tool_choice'] {
    if (toolChoice === undefined) {
      return undefined;
    }
    if (toolChoice === 'none' || toolChoice === 'auto' || toolChoice === 'required') {
      return toolChoice;
    }

    const namedChoice = this.toUnknownRecord(toolChoice);
    if (namedChoice?.type !== 'function') {
      throw this.invalidOpenAIRequest(
        'tool_choice must be none, auto, required, or a named function selection',
        'tool_choice',
      );
    }

    const functionChoice = this.toUnknownRecord(namedChoice.function);
    const name = isString(functionChoice?.name) ? functionChoice.name.trim() : '';
    if (!name) {
      throw this.invalidOpenAIRequest(
        'tool_choice.function.name is required for named function selection',
        'tool_choice',
      );
    }

    const hasNamedTool = tools?.some((tool) => tool.function?.name === name);
    if (!hasNamedTool) {
      throw this.invalidOpenAIRequest(
        `tool_choice function "${name}" is not among the provided tools`,
        'tool_choice',
      );
    }
    return { type: 'tool', name };
  }

  private convertOpenAIStopSequences(stop: OpenAIChatRequest['stop']): string[] | undefined {
    if (isNil(stop)) {
      return undefined;
    }

    const entries = isString(stop) ? [stop] : stop;
    if (!Array.isArray(entries)) {
      throw this.invalidOpenAIRequest('stop must be a string or an array of strings', 'stop');
    }
    if (entries.length === 0) {
      return undefined;
    }
    if (entries.length > 4) {
      throw this.invalidOpenAIRequest('stop supports at most 4 sequences', 'stop');
    }
    for (const entry of entries) {
      if (!isString(entry) || isEmpty(entry)) {
        throw this.invalidOpenAIRequest('stop entries must be non-empty strings', 'stop');
      }
    }
    return [...entries];
  }

  private convertOpenAIResponseFormat(
    responseFormat: OpenAIChatRequest['response_format'],
  ): string | undefined {
    if (isNil(responseFormat)) {
      return undefined;
    }
    const type = responseFormat.type;
    if (type === 'text') {
      return undefined;
    }
    if (type === 'json_object') {
      return 'application/json';
    }
    // A response_format object without a usable type is a malformed request, not an
    // implicit "text": silently defaulting it would hide the caller's mistake.
    if (!isString(type) || isEmpty(type)) {
      throw this.invalidOpenAIRequest(
        "response_format.type is required and must be one of 'text' or 'json_object'",
        'response_format',
      );
    }
    // json_schema (and anything unknown) is rejected rather than silently dropped
    // until real schema passthrough exists.
    throw this.invalidOpenAIRequest(
      `response_format type '${type}' is not supported`,
      'response_format',
    );
  }

  private invalidOpenAIRequest(message: string, param: string): OpenAIProtocolException {
    return new OpenAIProtocolException(message, HttpStatus.BAD_REQUEST, { param });
  }

  private convertOpenAIPartsToAnthropicContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): AnthropicContent[] {
    if (content === null || content === undefined) {
      return [];
    }

    if (isString(content)) {
      return content.trim() ? [{ type: 'text', text: content }] : [];
    }

    const blocks: AnthropicContent[] = [];
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text });
        continue;
      }

      if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url;
        const dataUrl = parseImageDataUrl(url);
        if (dataUrl) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: dataUrl.mimeType,
              data: dataUrl.data,
            },
          });
        } else if (!/^data:/i.test(url)) {
          blocks.push({ type: 'text', text: `[image_url] ${url}` });
        }
      }
    }
    return blocks;
  }

  private extractOpenAITextContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): string {
    if (content === null || content === undefined) {
      return '';
    }

    if (isString(content)) {
      return content;
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

  private convertOpenAIToolsToAnthropicTools(
    tools: OpenAIChatRequest['tools'],
  ): AnthropicChatRequest['tools'] {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const result: NonNullable<AnthropicChatRequest['tools']> = [];
    const searchToolTypes = new Set([
      'web_search_20250305',
      'google_search',
      'google_search_retrieval',
      'builtin_web_search',
    ]);

    for (const tool of tools) {
      if (!tool) {
        continue;
      }

      const toolType = isString(tool.type) ? tool.type.toLowerCase() : '';
      const functionName = isString(tool.function?.name) ? tool.function.name : '';
      const normalizedFunctionName = functionName.toLowerCase();
      const isSearchTool =
        searchToolTypes.has(toolType) || searchToolTypes.has(normalizedFunctionName);

      if (isSearchTool) {
        result.push({
          name: functionName || 'builtin_web_search',
          type: 'web_search_20250305',
          input_schema: {
            type: 'object',
            properties: {},
          },
        });
        continue;
      }

      if (!tool.function || !functionName) {
        continue;
      }

      const inputSchema = normalizeObjectJsonSchema(tool.function.parameters);

      result.push({
        name: functionName,
        description: tool.function.description,
        input_schema: inputSchema,
      });
    }

    return result.length > 0 ? result : undefined;
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
    if (normalized === 'SAFETY' || normalized === 'RECITATION') {
      return 'content_filter';
    }

    return finishReason.toLowerCase();
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

  /**
   * Converts the Claude-shaped intermediate response to the OpenAI Chat wire shape.
   *
   * Usage is resolved from the raw upstream Gemini payload first because it is the only
   * source that carries thinking tokens; the Claude intermediate is a fallback for the
   * callers that only hold that shape. Neither is defaulted: an upstream that reported
   * nothing yields a response with no usage key rather than a fabricated 0/0/0.
   */
  private convertClaudeToOpenAIResponse(
    claudeResponse: ClaudeResponse,
    model: string,
    upstreamUsageMetadata?: unknown,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
  ): OpenAIChatResponse {
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
      .map((block, index: number) => ({
        id: block.id || `tool-call-${index}`,
        type: 'function' as const,
        function: {
          name: block.name || 'unknown_tool',
          arguments: this.normalizeToolCallArguments(block.input),
        },
      }));

    // Raw upstream metadata is the richest source (it carries thinking tokens); the
    // Claude intermediate is the fallback and now only carries usage when it was real.
    const usage =
      this.mapGeminiUsageMetadata(upstreamUsageMetadata) ??
      this.toOpenAIUsageFromClaudeUsage(claudeResponse.usage);

    return {
      id: `${outputProtocol === 'text-completions' ? 'cmpl' : 'chatcmpl'}-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            reasoning_content: reasoningContent || undefined,
          },
          logprobs: null,
          finish_reason: this.mapAnthropicStopReasonToOpenAIFinishReason(
            claudeResponse.stop_reason,
          ),
        },
      ],
      ...(usage ? { usage } : {}),
    };
  }

  private toOpenAIUsageFromClaudeUsage(usage: ClaudeResponse['usage']): OpenAIStreamUsage | null {
    if (!usage || !isNumber(usage.input_tokens) || !isNumber(usage.output_tokens)) {
      return null;
    }
    return {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    };
  }

  private resolveTargetModel(model: string): string {
    return this.modelRoutingPolicy.resolveTargetModel(model);
  }

  private async applyUpstreamPenalty(
    accountId: string,
    model: string,
    error: unknown,
  ): Promise<void> {
    if (this.isModelNotFoundError(error)) {
      // Quota metadata can advertise ids the generation API rejects; mark the
      // id so the in-flight retry loop and later requests reroute to a sibling.
      this.accountLeaseService.markModelUnrequestable(model);
    }
    await this.retryPolicy.applyUpstreamPenalty(accountId, model, error);
  }

  private isModelNotFoundError(error: unknown): boolean {
    const notFoundMarker = 'Requested entity was not found';
    if (error instanceof UpstreamRequestError) {
      return (
        error.status === HttpStatus.NOT_FOUND ||
        error.message.includes(notFoundMarker) ||
        Boolean(error.body?.includes(notFoundMarker))
      );
    }
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes(notFoundMarker);
  }

  private resolveGraceRetryDelay(error: unknown): number | null {
    return this.retryPolicy.resolveGraceRetryDelay(error);
  }

  private classifyUpstreamFailure(errorMessage: string): ProxyUpstreamFailureClassification {
    return this.retryPolicy.classifyUpstreamFailure(errorMessage);
  }

  private createModelSpecificHeaders(model: string | undefined): Record<string, string> {
    return this.modelRoutingPolicy.createModelSpecificHeaders(model);
  }

  private isProjectLicenseError(errorMessage: string): boolean {
    const msg = errorMessage.toLowerCase();
    return (
      msg.includes('#3501') ||
      (msg.includes('google cloud project') && msg.includes('code assist license'))
    );
  }

  private isProjectNotFoundError(errorMessage: string): boolean {
    const msg = errorMessage.toLowerCase();
    return (
      msg.includes('invalid project resource name projects/') ||
      (msg.includes('resource projects/') && msg.includes('could not be found')) ||
      (msg.includes('project') && msg.includes('not found'))
    );
  }

  private isProjectContextError(errorMessage: string): boolean {
    return this.isProjectLicenseError(errorMessage) || this.isProjectNotFoundError(errorMessage);
  }

  private isQuotaExhaustedError(errorMessage: string): boolean {
    const msg = errorMessage.toLowerCase();
    return (
      msg.includes('resource has been exhausted') ||
      msg.includes('resource_exhausted') ||
      msg.includes('quota')
    );
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
    const extra = request.extra;
    const sessionCandidate =
      extra?.session_id ?? extra?.sessionId ?? extra?.user_id ?? extra?.userId;
    if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
      return undefined;
    }
    return `openai:${sessionCandidate.trim()}`;
  }

  private isGeminiPart(value: unknown): value is InternalGeminiPart {
    return isPlainObject(value);
  }
}
