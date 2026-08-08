import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Res,
  HttpStatus,
  UseGuards,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { ProxyService } from './proxy.service';
import {
  OpenAIChatRequest,
  OpenAICompletionRequest,
  OpenAIChatResponse,
} from './common/interfaces/request-interfaces';
import {
  OpenAIResponsesSessionStore,
  type OpenAIResponsesSessionStoreLike,
} from './modules/openai/responses/openai-responses-session.store';
import { OpenAIResponsesSessionService } from './modules/openai/responses/openai-responses-session.service';
import { toOpenAIResponsesResponse } from '../antigravity/OpenAIResponsesResponseMapper';
import {
  normalizeOpenAIChatRequest,
  normalizeOpenAICompletionRequest,
} from './modules/openai/chat/openai-request-contract';
import {
  AnthropicRequestValidationError,
  normalizeAnthropicCountTokensRequest,
  normalizeAnthropicMessagesRequest,
} from './modules/anthropic/anthropic-request-contract';
import {
  buildResponseNotFoundError,
  type ResponsesRequestBody,
} from './modules/openai/responses/openai-responses-request-contract';
import {
  prepareResponsesRequest,
  type PreparedResponsesRequest,
} from './modules/openai/responses/openai-responses-chat-request';
import {
  cacheResponsesStream,
  saveResponsesSession,
} from './modules/openai/responses/openai-responses-session-cache';
import {
  toLegacyTextCompletionsResponse,
  toLegacyTextCompletionsStream,
} from './modules/openai/chat/openai-legacy-completions';
import { ProxyGuard } from './guards/proxy.guard';
import {
  getOpenAICompatibleModels,
  getUnpublishedCatalogModelIds,
  MODEL_LIST_CREATED_AT,
  MODEL_LIST_OWNER,
} from '../antigravity/ModelMapping';
import { AccountLeaseService } from './modules/account-lease/account-lease.service';
import { buildModelRoleRoutes } from './modules/openai/media/image-model-resolution';
import { ModelRoutingService } from './modules/shared/services/model-routing.service';
import { ModelAvailabilityService } from './modules/shared/services/model-availability.service';
import { buildModelRouteResponseHeaders } from './common/model-route-response-headers';
import {
  createAnthropicRequestId,
  sendAnthropicErrorResponse,
  sendOpenAIErrorResponse,
} from './common/proxy-error-responses';
import {
  applyResponseHeaders,
  isObservableLike,
  writeSseResponse,
} from './common/sse-response-writer';
import { ModelRouteMissJournalService } from './modules/shared/services/model-route-miss-journal.service';
import { FileContentStore } from './modules/files/file-content-store.service';
import {
  FileReferenceError,
  expandFileReferences,
  type FileReferenceSurface,
} from './modules/files/file-reference-expander';

export type { ResponsesRequestBody } from './modules/openai/responses/openai-responses-request-contract';
export type { PreparedResponsesRequest } from './modules/openai/responses/openai-responses-chat-request';

@Controller('v1')
@UseGuards(ProxyGuard)
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);

  constructor(
    @Inject(ProxyService) private readonly proxyService: ProxyService,
    @Optional()
    @Inject(AccountLeaseService)
    private readonly accountLeaseService?: AccountLeaseService,
    @Optional()
    @Inject(ModelRoutingService)
    private readonly modelRoutingService?: ModelRoutingService,
    @Optional()
    @Inject(ModelAvailabilityService)
    private readonly modelAvailabilityService?: ModelAvailabilityService,
    @Optional()
    @Inject(ModelRouteMissJournalService)
    private readonly modelRouteMissJournalService?: ModelRouteMissJournalService,
    @Optional()
    @Inject(OpenAIResponsesSessionService)
    private readonly responsesSessionStore?: OpenAIResponsesSessionStoreLike,
    @Optional()
    @Inject(FileContentStore)
    private readonly fileContentStore?: FileContentStore,
  ) {}

  /**
   * The durable store when the module wired one, otherwise the in-memory
   * default so a directly constructed controller still works.
   */
  private get responsesSessions(): OpenAIResponsesSessionStoreLike {
    return this.responsesSessionStore ?? OpenAIResponsesSessionStore;
  }

  /**
   * Turns stored file handles into inline content before validation.
   *
   * It has to run first because the request contracts reject content parts they
   * do not recognise, and a `file_id` part is only recognisable once resolved.
   * The store is local: the bytes still travel upstream inline, because the
   * provider has no file plane to reference.
   */
  private async expandRequestFileReferences<T>(body: T, surface: FileReferenceSurface): Promise<T> {
    return expandFileReferences(body, surface, this.fileContentStore);
  }

  private toAnthropicFileReferenceError(error: unknown): unknown {
    return error instanceof FileReferenceError
      ? new AnthropicRequestValidationError(error.message, error.param, 'invalid_value')
      : error;
  }

  @Get('models')
  listModels(@Res() res: FastifyReply) {
    try {
      const modelIds = getOpenAICompatibleModels(
        {},
        this.accountLeaseService?.getAllCollectedModels(),
        this.accountLeaseService?.getCatalogModelRoleIndex(),
      );

      const data = modelIds.map((id) => ({
        id,
        object: 'model',
        created: MODEL_LIST_CREATED_AT,
        owned_by: MODEL_LIST_OWNER,
      }));

      res.status(HttpStatus.OK).send({
        object: 'list',
        data,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list models';
      this.logger.error(message, error instanceof Error ? error.stack : undefined);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
        error: {
          message,
          type: 'server_error',
        },
      });
    }
  }

  @Get('model-routes')
  listModelRoutes(@Res() res: FastifyReply) {
    const routes = this.modelRoutingService?.getConfiguredRoutes() ?? [];
    const canonicalModels = [...(this.accountLeaseService?.getAllCollectedModels() ?? [])];
    res.status(HttpStatus.OK).send({
      object: 'model_route_list',
      checked_at: new Date().toISOString(),
      canonical_models: canonicalModels.sort((left, right) => left.localeCompare(right)),
      unpublished_catalog_ids: getUnpublishedCatalogModelIds(
        canonicalModels,
        this.accountLeaseService?.getCatalogModelRoleIndex(),
      ),
      role_routes: buildModelRoleRoutes(
        (role) => this.accountLeaseService?.getModelIdsForRole?.(role) ?? [],
      ),
      data: routes.map((route) => ({
        ...route,
        target_status:
          this.accountLeaseService?.getModelCatalogStatus(route.target) ?? 'catalog_unavailable',
        accounts: this.accountLeaseService?.getModelRouteAvailability(route.target) ?? [],
      })),
      recent_failures: this.modelAvailabilityService?.getSnapshot() ?? [],
      recent_misses: this.modelRouteMissJournalService?.getSnapshot() ?? [],
    });
  }

  @Delete('model-routes/miss-journal')
  clearMissJournal(@Res() res: FastifyReply) {
    this.modelRouteMissJournalService?.clear();
    res.status(HttpStatus.OK).send({
      object: 'model-route-miss-journal-cleared',
    });
  }

  @Post('chat/completions')
  async chatCompletions(@Body() body: OpenAIChatRequest, @Res() res: FastifyReply) {
    await this.respondOpenAIChatCompletions(body, res);
  }

  @Post('completions')
  async completions(@Body() body: OpenAICompletionRequest, @Res() res: FastifyReply) {
    try {
      const { request } = normalizeOpenAICompletionRequest(body);
      const result = await this.proxyService.handleChatCompletions(request);
      const routeHeaders = this.getModelRouteResponseHeaders(result, request.model);
      if (request.stream && isObservableLike(result)) {
        writeSseResponse(res, toLegacyTextCompletionsStream(result), 'openai', routeHeaders);
        return;
      }

      const response = result as OpenAIChatResponse;
      applyResponseHeaders(res, routeHeaders);
      res.status(HttpStatus.OK).send(toLegacyTextCompletionsResponse(response));
    } catch (error) {
      sendOpenAIErrorResponse(this.logger, res, '/v1/completions', error);
    }
  }

  @Post('responses')
  async responses(@Body() rawBody: ResponsesRequestBody, @Res() res: FastifyReply) {
    try {
      const body = await this.expandRequestFileReferences(rawBody, 'openai-responses');
      const prepared = this.prepareResponsesRequest(body);
      if (!prepared) {
        res
          .status(HttpStatus.NOT_FOUND)
          .send(buildResponseNotFoundError(String(body.previous_response_id ?? '')));
        return;
      }
      const result = await this.proxyService.handleChatCompletions(prepared.request, 'responses');
      const routeHeaders = this.getModelRouteResponseHeaders(result, prepared.request.model);
      if (body.stream && isObservableLike(result)) {
        writeSseResponse(
          res,
          cacheResponsesStream(result, prepared.session, this.responsesSessions),
          'openai',
          routeHeaders,
        );
        return;
      }

      const response = result as OpenAIChatResponse;
      const responsesResponse = toOpenAIResponsesResponse(response, prepared.responseContext);
      saveResponsesSession(responsesResponse, prepared.session, this.responsesSessions);
      applyResponseHeaders(res, routeHeaders);
      res.status(HttpStatus.OK).send(responsesResponse);
    } catch (error) {
      sendOpenAIErrorResponse(this.logger, res, '/v1/responses', error);
    }
  }

  private async respondOpenAIChatCompletions(body: OpenAIChatRequest, res: FastifyReply) {
    try {
      const request = normalizeOpenAIChatRequest(
        await this.expandRequestFileReferences(body, 'openai-chat'),
      );
      const result = await this.proxyService.handleChatCompletions(request);
      const routeHeaders = this.getModelRouteResponseHeaders(result, request.model);

      if (request.stream && isObservableLike(result)) {
        writeSseResponse(res, result, 'openai', routeHeaders);
        return;
      } else {
        applyResponseHeaders(res, routeHeaders);
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      sendOpenAIErrorResponse(this.logger, res, '/v1/chat/completions', error);
    }
  }

  @Post('messages')
  async anthropicMessages(@Body() body: unknown, @Res() res: FastifyReply) {
    const requestId = createAnthropicRequestId();
    try {
      const request = normalizeAnthropicMessagesRequest(
        await this.expandRequestFileReferences(body, 'anthropic'),
      );
      const result = await this.proxyService.handleAnthropicMessages(request);
      const routeHeaders = this.getModelRouteResponseHeaders(result, request.model);

      if (request.stream && isObservableLike(result)) {
        writeSseResponse(res, result, 'anthropic', {
          ...routeHeaders,
          'request-id': requestId,
        });
        return;
      } else {
        applyResponseHeaders(res, routeHeaders);
        res.header('request-id', requestId).status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      sendAnthropicErrorResponse(
        this.logger,
        res,
        '/v1/messages',
        this.toAnthropicFileReferenceError(error),
        undefined,
        requestId,
      );
    }
  }

  @Post('messages/count_tokens')
  async anthropicCountTokens(@Body() body: unknown, @Res() res: FastifyReply) {
    const requestId = createAnthropicRequestId();
    try {
      const request = normalizeAnthropicCountTokensRequest(
        await this.expandRequestFileReferences(body, 'anthropic'),
      );
      const result = await this.proxyService.handleAnthropicCountTokens(request);
      applyResponseHeaders(res, this.getModelRouteResponseHeaders(result, request.model));
      res
        .header('request-id', requestId)
        .status(HttpStatus.OK)
        .send({ input_tokens: result.input_tokens });
    } catch (error) {
      sendAnthropicErrorResponse(
        this.logger,
        res,
        '/v1/messages/count_tokens',
        this.toAnthropicFileReferenceError(error),
        undefined,
        requestId,
      );
    }
  }

  /**
   * Public because the Responses WebSocket transport and the batch runner serve
   * the same `/v1/responses` conversion without going through an HTTP route.
   */
  public prepareResponsesRequest(body: ResponsesRequestBody): PreparedResponsesRequest | null {
    return prepareResponsesRequest(body, this.responsesSessions);
  }

  private getModelRouteResponseHeaders(
    result: unknown,
    requestedModel: string | undefined,
  ): Record<string, string> {
    return buildModelRouteResponseHeaders(result, requestedModel, this.modelRoutingService);
  }
}
