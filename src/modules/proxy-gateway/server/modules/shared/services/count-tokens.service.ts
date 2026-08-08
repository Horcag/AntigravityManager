import { Inject, Injectable } from '@nestjs/common';
import { isObjectLike } from 'lodash-es';

import { transformClaudeRequestIn } from '../../../../antigravity/ClaudeRequestMapper';
import { SignatureStore } from '../../../../antigravity/SignatureStore';
import type {
  ClaudeRequest,
  GeminiContent,
  GeminiCountTokensResponse,
} from '../../../../antigravity/types';
import { BaseProxyService } from '../../../common/base-proxy.service';
import { UpstreamRequestError } from '../../../common/exceptions/upstream-request-exception';
import type {
  AnthropicChatRequest,
  AnthropicCountTokensRequest,
  AnthropicCountTokensResponse,
  GeminiRequest,
} from '../../../common/interfaces/request-interfaces';
import { attachModelRouteMetadata } from '../../../common/model-route-metadata';
import { createNoAvailableAccountError } from '../../../common/model-route-errors';
import { resolveRequestUserAgent } from '../../../common/utils/request-user-agent';
import { AccountLeaseService } from '../../account-lease/account-lease.service';
import { GeminiClient } from '../../gemini/gemini-client.service';
import { GenerationConstraintsService } from './generation-constraints.service';
import { ModelRouteMissJournalService } from './model-route-miss-journal.service';
import { ModelRoutingService } from './model-routing.service';
import { ProxyRetryService } from './proxy-retry.service';
import {
  applyAnthropicModelVariant,
  rebindAnthropicModelVariant,
} from './model-variant-request.service';

export interface GeminiCountTokensResult {
  totalTokens: number;
}

const MAX_RETRIES = 3;

interface CountTokensPayload {
  /** Model id without the `models/` prefix; the transport adds it. */
  model: string;
  contents: GeminiContent[];
}

type CountTokensPayloadFactory = (context: {
  accountId: string;
  effectiveModel: string;
}) => CountTokensPayload;

interface CountTokensLeaseResult {
  response: GeminiCountTokensResponse;
  servedModel: string;
}

/**
 * Token counting for the native Gemini and Anthropic surfaces.
 *
 * Kept out of `ProxyService` because counting shares only the account lease and routing machinery
 * with generation; it has no streaming, no generation constraints and no response mapping.
 */
@Injectable()
export class CountTokensService extends BaseProxyService {
  constructor(
    @Inject(AccountLeaseService) accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) geminiClient: GeminiClient,
    @Inject(GenerationConstraintsService) generationConstraints: GenerationConstraintsService,
    @Inject(ProxyRetryService) retryPolicy: ProxyRetryService,
    @Inject(ModelRoutingService) modelRoutingPolicy: ModelRoutingService,
    @Inject(ModelRouteMissJournalService)
    private readonly modelRouteMissJournalService: ModelRouteMissJournalService,
    @Inject(SignatureStore) private readonly signatureStore: SignatureStore,
  ) {
    super(
      accountLeaseService,
      geminiClient,
      generationConstraints,
      retryPolicy,
      modelRoutingPolicy,
    );
  }

  /**
   * `POST /v1beta/models/{model}:countTokens`.
   *
   * Only `contents` reach the upstream endpoint, so a system instruction or tool declarations sent
   * alongside them are not part of the returned count.
   */
  async countGeminiTokens(
    model: string,
    contents: GeminiContent[],
  ): Promise<GeminiCountTokensResult> {
    const normalizedModel = this.modelRoutingPolicy.normalizeGeminiModel(model);
    const route = this.modelRoutingPolicy.resolveModelRoute(normalizedModel);

    const lease = await this.countTokensWithLease(
      route.targetModel,
      'Gemini countTokens',
      ({ effectiveModel }) => ({ model: effectiveModel, contents }),
    );

    return attachModelRouteMetadata(
      { totalTokens: this.requireTotalTokens(lease.response) },
      {
        requestedModel: model,
        resolvedModel: route.targetModel,
        servedModel: lease.servedModel,
        routeSource: route.source,
      },
    );
  }

  /**
   * `POST /v1/messages/count_tokens`.
   *
   * The Anthropic body is converted by the same mapper the Messages endpoint uses, so the counted
   * contents are the ones a real completion would have sent; everything else the mapper produces
   * (generation config, tools, safety settings) is discarded because the upstream endpoint rejects it.
   */
  async countAnthropicTokens(
    request: AnthropicCountTokensRequest,
  ): Promise<AnthropicCountTokensResponse> {
    const route = this.modelRoutingPolicy.resolveModelRoute(request.model);
    const appliedVariant = applyAnthropicModelVariant({
      ...request,
      model: route.targetModel,
    });
    const targetModel = appliedVariant.request.model;
    const requestUserAgent = await resolveRequestUserAgent();

    const lease = await this.countTokensWithLease(
      targetModel,
      'Anthropic count_tokens',
      ({ accountId, effectiveModel }) => {
        const rebound = rebindAnthropicModelVariant(appliedVariant, effectiveModel);
        const accountTargetModel = rebound.variant ? rebound.request.model : effectiveModel;
        const mapped = transformClaudeRequestIn(
          toClaudeRequest(rebound.request),
          undefined,
          requestUserAgent,
          accountTargetModel,
          { accountId, store: this.signatureStore },
        );
        return { model: mapped.model, contents: mapped.request.contents };
      },
    );

    return attachModelRouteMetadata(
      { input_tokens: this.requireTotalTokens(lease.response) },
      {
        requestedModel: request.model,
        resolvedModel: targetModel,
        servedModel: lease.servedModel,
        routeSource: route.source,
      },
    );
  }

  /**
   * Refuses to invent a count.
   *
   * Neither public contract can express "unknown": the Gemini envelope has a bare `totalTokens`
   * integer and Anthropic a bare `input_tokens`, so any marker we added would be dropped by SDK
   * parsers and read back as a real number. An upstream error is the only signal that survives the
   * protocol boundary, so a response without a usable count is reported as a bad gateway and each
   * surface renders it in its own error envelope.
   */
  private requireTotalTokens(response: GeminiCountTokensResponse): number {
    const totalTokens = response.totalTokens;
    if (!Number.isInteger(totalTokens) || (totalTokens as number) < 0) {
      throw new UpstreamRequestError({
        message: 'Upstream countTokens response did not include a usable totalTokens value',
        status: 502,
      });
    }
    return totalTokens as number;
  }

  private async countTokensWithLease(
    targetModel: string,
    label: string,
    createPayload: CountTokensPayloadFactory,
  ): Promise<CountTokensLeaseResult> {
    const deadlineAt = this.createRequestDeadline();
    const extraHeaders = this.createModelSpecificHeaders(targetModel);
    const retryState = this.createTokenRetryState();
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.waitBeforeRetry(
        attempt,
        MAX_RETRIES,
        label,
        retryState.graceRetryToken !== null,
        deadlineAt,
      );

      const token = await this.selectRetryToken(retryState, targetModel);
      if (!token) {
        throw createNoAvailableAccountError({
          accountLeaseService: this.accountLeaseService,
          missJournal: this.modelRouteMissJournalService,
          model: targetModel,
        });
      }

      const effectiveModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );

      try {
        const payload = createPayload({ accountId: token.id, effectiveModel });
        const response = await this.geminiClient.countTokensInternal(
          {
            request: {
              model: `models/${payload.model}`,
              contents: payload.contents,
            },
          },
          token.token.access_token,
          token.token.upstream_proxy_url,
          extraHeaders,
          deadlineAt,
        );
        this.markUpstreamSuccess(token.id, effectiveModel);
        return { response, servedModel: effectiveModel };
      } catch (error) {
        lastError = error;
        if (await this.prepareGraceRetry(retryState, token, error, label)) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveModel, error);
      }
    }

    throw lastError || new Error(`${label} request failed after retries`);
  }
}

/**
 * Reads the conversation out of a native `countTokens` body.
 *
 * The public Gemini contract allows either bare `contents` or a `generateContentRequest` wrapper;
 * `null` means neither was present, which callers report as `INVALID_ARGUMENT` rather than counting
 * an empty conversation.
 */
export function resolveCountTokensContents(body: unknown): GeminiContent[] | null {
  if (!isObjectLike(body)) {
    return null;
  }

  const direct = (body as GeminiRequest).contents;
  if (Array.isArray(direct)) {
    return direct as GeminiContent[];
  }

  const wrapped = (body as { generateContentRequest?: unknown }).generateContentRequest;
  if (isObjectLike(wrapped) && Array.isArray((wrapped as GeminiRequest).contents)) {
    return (wrapped as GeminiRequest).contents as GeminiContent[];
  }

  return null;
}

/**
 * Mirrors the field selection the Messages endpoint applies before mapping, so both surfaces feed
 * `transformClaudeRequestIn` the same shape.
 */
function toClaudeRequest(request: AnthropicChatRequest): ClaudeRequest {
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
    thinking: request.thinking,
    output_config: request.output_config,
  };
}
