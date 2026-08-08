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
  Req,
  Logger,
  Optional,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { isEmpty, isFunction, isNil, isObjectLike, isPlainObject, isString } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import { ProxyService } from './proxy.service';
import { map, Observable, of, tap } from 'rxjs';
import {
  OpenAIChatRequest,
  OpenAICompletionRequest,
  OpenAIToolCall,
  OpenAIChatResponse,
  OpenAIContentPart,
  GeminiRequest,
  GeminiResponse,
} from './common/interfaces/request-interfaces';
import { toCustomToolArguments } from '../antigravity/CustomToolCall';
import { ApplyPatchFailureCompactor } from '../antigravity/ApplyPatchFailureCompaction';
import {
  toOpenAIResponsesResponse,
  type OpenAIResponsesResponseContext,
} from '../antigravity/OpenAIResponsesResponseMapper';
import {
  mergeOpenAIResponsesInputItems,
  normalizeOpenAIResponsesInputItems,
  OpenAIResponsesSessionStore,
  type OpenAIResponsesSession,
} from './modules/openai/responses/openai-responses-session.store';
import {
  normalizeOpenAIChatRequest,
  normalizeOpenAICompletionRequest,
  OpenAIRequestValidationError,
} from './modules/openai/chat/openai-request-contract';
import {
  AnthropicRequestValidationError,
  normalizeAnthropicMessagesRequest,
} from './modules/anthropic/anthropic-request-contract';
import {
  mapResponsesReasoningEffort,
  normalizeOpenAIResponsesRequest,
  type ResponsesRequestBody,
} from './modules/openai/responses/openai-responses-request-contract';
import { ProxyGuard } from './guards/proxy.guard';
import {
  getOpenAICompatibleModels,
  isNonChatCatalogModelId,
  MODEL_LIST_CREATED_AT,
  MODEL_LIST_OWNER,
} from '../antigravity/ModelMapping';
import { AccountLeaseService } from './modules/account-lease/account-lease.service';
import { UpstreamRequestError } from './common/exceptions/upstream-request-exception';
import {
  type ImageMonitoringRequest,
  type OpenAIImageResponse,
  summarizeImageRequest,
  summarizeImageResponse,
} from './modules/openai/media/image-monitoring-summary';
import { parseImageMultipartRequest } from './modules/openai/media/image-multipart-request';
import {
  getGeminiImageRequestMetadata,
  normalizeImageEditJsonRequest,
  normalizeImageGenerationRequest,
} from './modules/openai/media/image-request-contract';
import { parseAudioMultipartRequest } from './modules/openai/media/audio-multipart-request';
import {
  OPENAI_IMAGE_RESPONSE_BYTES_LIMIT,
  OpenAIMediaRequestError,
  isOpenAIImageOutputMimeType,
  normalizeMultipartMediaError,
  parseInlineMediaInput,
} from './modules/openai/media/openai-media-request-contract';
import {
  mapGeminiAudioTranscriptionStream,
  mapOpenAIImageStream,
} from './modules/openai/media/openai-media-streaming';
import { safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';
import { ModelRoutingService } from './modules/shared/services/model-routing.service';
import { ModelAvailabilityService } from './modules/shared/services/model-availability.service';
import { ModelRouteError } from './common/exceptions/model-route-exception';
import {
  inheritUpstreamBackpressure,
  pauseObservableUpstream,
  resumeObservableUpstream,
} from './common/stream-backpressure';
import {
  createModelRouteHeaders,
  getModelRouteMetadata,
  type ModelRouteMetadata,
} from './common/model-route-metadata';
import { ModelRouteMissJournalService } from './modules/shared/services/model-route-miss-journal.service';

export const IMAGE_QUOTA_REFRESH = Symbol('IMAGE_QUOTA_REFRESH');
export type ImageQuotaRefresh = () => Promise<void>;

export type { ResponsesRequestBody } from './modules/openai/responses/openai-responses-request-contract';

export interface PreparedResponsesRequest {
  request: OpenAIChatRequest;
  responseContext: OpenAIResponsesResponseContext;
  session: OpenAIResponsesSession;
}

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
    @Inject(IMAGE_QUOTA_REFRESH)
    private readonly imageQuotaRefresh?: ImageQuotaRefresh,
    @Optional()
    @Inject(ModelRoutingService)
    private readonly modelRoutingService?: ModelRoutingService,
    @Optional()
    @Inject(ModelAvailabilityService)
    private readonly modelAvailabilityService?: ModelAvailabilityService,
    @Optional()
    @Inject(ModelRouteMissJournalService)
    private readonly modelRouteMissJournalService?: ModelRouteMissJournalService,
  ) {}

  @Get('models')
  listModels(@Res() res: FastifyReply) {
    try {
      const modelIds = getOpenAICompatibleModels(
        {},
        this.accountLeaseService?.getAllCollectedModels(),
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
      unpublished_catalog_ids: canonicalModels
        .filter((modelId) => isNonChatCatalogModelId(modelId))
        .sort((left, right) => left.localeCompare(right)),
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
      if (request.stream && this.isObservableLike(result)) {
        this.writeSseResponse(
          res,
          this.toLegacyTextCompletionsStream(result),
          'openai',
          routeHeaders,
        );
        return;
      }

      const response = result as OpenAIChatResponse;
      this.applyResponseHeaders(res, routeHeaders);
      res.status(HttpStatus.OK).send(this.toLegacyTextCompletionsResponse(response));
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/completions', error);
    }
  }

  @Post('responses')
  async responses(@Body() body: ResponsesRequestBody, @Res() res: FastifyReply) {
    try {
      const prepared = this.prepareResponsesRequest(body);
      if (!prepared) {
        res.status(HttpStatus.BAD_REQUEST).send({
          error: {
            code: 'previous_response_not_found',
            message: `Unknown or expired previous_response_id: ${body.previous_response_id}`,
            param: 'previous_response_id',
            type: 'invalid_request_error',
          },
        });
        return;
      }
      const result = await this.proxyService.handleChatCompletions(prepared.request, 'responses');
      const routeHeaders = this.getModelRouteResponseHeaders(result, prepared.request.model);
      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(
          res,
          this.cacheResponsesStream(result, prepared.session),
          'openai',
          routeHeaders,
        );
        return;
      }

      const response = result as OpenAIChatResponse;
      const responsesResponse = toOpenAIResponsesResponse(response, prepared.responseContext);
      this.saveResponsesSession(responsesResponse, prepared.session);
      this.applyResponseHeaders(res, routeHeaders);
      res.status(HttpStatus.OK).send(responsesResponse);
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/responses', error);
    }
  }

  @Post('images/generations')
  async imageGenerations(
    @Body()
    rawBody: ImageMonitoringRequest,
    @Res() res: FastifyReply,
  ) {
    const path = '/v1/images/generations';
    try {
      const body = normalizeImageGenerationRequest(rawBody);
      this.logImageMonitoringSummary('request', summarizeImageRequest(path, body));
      const request: OpenAIChatRequest = {
        model: body.model ?? 'gemini-3.1-flash-image',
        messages: [
          {
            role: 'user',
            content: body.prompt ?? '',
          },
        ],
        stream: body.stream,
        size: body.size,
        quality: body.quality,
        extra: getGeminiImageRequestMetadata(body),
      };

      await this.sendOpenAIImageGenerationResponse(request, body.prompt ?? '', path, body, res);
    } catch (error) {
      this.sendOpenAIErrorResponse(res, path, error);
    }
  }

  @Post('images/edits')
  async imageEdits(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const path = '/v1/images/edits';
    let body: ImageMonitoringRequest;
    try {
      body = this.hasMultipartBoundary(req)
        ? await parseImageMultipartRequest(req)
        : normalizeImageEditJsonRequest(req.body);
    } catch (error) {
      this.sendOpenAIErrorResponse(res, path, normalizeMultipartMediaError(error));
      return;
    }
    this.logImageMonitoringSummary('request', summarizeImageRequest(path, body));

    const imageParts = [
      ...this.collectImageContentParts([body.image], 'image/png'),
      ...this.collectImageContentParts(body.reference_images ?? [], 'image/jpeg'),
    ];
    const maskParts = this.collectImageContentParts([body.mask], 'image/png');
    const content: OpenAIContentPart[] = [
      {
        type: 'text',
        text: body.prompt ?? 'Please edit the provided image.',
      },
      ...imageParts,
      ...(maskParts.length > 0
        ? [
            {
              type: 'text' as const,
              text: 'Use the following image as the edit mask.',
            },
            ...maskParts,
          ]
        : []),
    ];

    const request: OpenAIChatRequest = {
      model: body.model ?? 'gemini-3.1-flash-image',
      messages: [
        {
          role: 'user',
          content,
        },
      ],
      stream: body.stream,
      size: body.size,
      quality: body.quality,
      extra: getGeminiImageRequestMetadata(body),
    };

    await this.sendOpenAIImageGenerationResponse(request, body.prompt ?? '', path, body, res);
  }

  @Post('audio/transcriptions')
  async audioTranscriptions(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const path = '/v1/audio/transcriptions';
    if (!this.hasMultipartBoundary(req)) {
      this.sendOpenAIErrorResponse(
        res,
        path,
        new OpenAIMediaRequestError(
          'Expected a multipart/form-data request with a valid boundary',
          'content-type',
        ),
      );
      return;
    }

    let body;
    try {
      body = await parseAudioMultipartRequest(req);
    } catch (error) {
      this.sendOpenAIErrorResponse(res, path, normalizeMultipartMediaError(error));
      return;
    }

    const instruction = [
      body.prompt ?? 'Transcribe the provided speech audio accurately.',
      body.language ? `The expected language is ${body.language}.` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n');
    const request: GeminiRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: instruction },
            {
              inlineData: {
                data: body.file.data,
                mimeType: body.file.mimeType,
              },
            },
          ],
        },
      ],
      generationConfig:
        body.temperature === undefined ? undefined : { temperature: body.temperature },
    };

    try {
      if (body.stream) {
        const upstreamStream = await this.proxyService.handleGeminiStreamGenerateContent(
          body.model,
          request,
        );
        this.writeSseResponse(
          res,
          inheritUpstreamBackpressure(
            upstreamStream,
            mapGeminiAudioTranscriptionStream(upstreamStream),
          ),
          'openai',
          this.getModelRouteResponseHeaders(upstreamStream, body.model),
        );
        return;
      }

      const result = await this.proxyService.handleGeminiGenerateContent(body.model, request);
      this.applyResponseHeaders(res, this.getModelRouteResponseHeaders(result, body.model));
      const transcript =
        result.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? '')
          .join('')
          .trim() ?? '';

      if (body.response_format === 'text') {
        res.header('Content-Type', 'text/plain; charset=utf-8');
        res.status(HttpStatus.OK).send(transcript);
      } else {
        res.status(HttpStatus.OK).send({ text: transcript });
      }
    } catch (error) {
      this.sendOpenAIErrorResponse(res, path, error);
    }
  }

  private async respondOpenAIChatCompletions(body: OpenAIChatRequest, res: FastifyReply) {
    try {
      const request = normalizeOpenAIChatRequest(body);
      const result = await this.proxyService.handleChatCompletions(request);
      const routeHeaders = this.getModelRouteResponseHeaders(result, request.model);

      if (request.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result, 'openai', routeHeaders);
        return;
      } else {
        this.applyResponseHeaders(res, routeHeaders);
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/chat/completions', error);
    }
  }

  @Post('messages')
  async anthropicMessages(@Body() body: unknown, @Res() res: FastifyReply) {
    const requestId = this.createAnthropicRequestId();
    try {
      const request = normalizeAnthropicMessagesRequest(body);
      const result = await this.proxyService.handleAnthropicMessages(request);
      const routeHeaders = this.getModelRouteResponseHeaders(result, request.model);

      if (request.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result, 'anthropic', {
          ...routeHeaders,
          'request-id': requestId,
        });
        return;
      } else {
        this.applyResponseHeaders(res, routeHeaders);
        res.header('request-id', requestId).status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      this.sendAnthropicErrorResponse(res, '/v1/messages', error, undefined, requestId);
    }
  }

  private toLegacyTextCompletionsResponse(response: OpenAIChatResponse): Record<string, unknown> {
    return {
      id: this.toLegacyCompletionId(response.id),
      object: 'text_completion',
      created: response.created,
      model: response.model,
      choices: (response.choices ?? []).map((choice) => ({
        text: isString(choice.message?.content) ? choice.message.content : '',
        index: choice.index,
        logprobs: choice.logprobs ?? null,
        finish_reason: choice.finish_reason ?? null,
      })),
      usage: response.usage,
    };
  }

  private toLegacyTextCompletionsStream(stream: Observable<unknown>): Observable<string> {
    return inheritUpstreamBackpressure(
      stream,
      stream.pipe(map((chunk) => this.toLegacyTextCompletionsSseChunk(chunk))),
    );
  }

  private toLegacyTextCompletionsSseChunk(chunk: unknown): string {
    if (!isString(chunk)) {
      return String(chunk ?? '');
    }

    const events = chunk.split('\n\n');
    const converted: string[] = [];
    for (const event of events) {
      if (!event) {
        continue;
      }
      const dataLine = event.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine || dataLine === 'data: [DONE]') {
        converted.push(`${event}\n\n`);
        continue;
      }

      try {
        const payload = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
        if (payload.object !== 'chat.completion.chunk' || !Array.isArray(payload.choices)) {
          converted.push(`${event}\n\n`);
          continue;
        }

        const choices = payload.choices.map((choiceValue) => {
          const choice = this.toRecord(choiceValue) ?? {};
          const delta = this.toRecord(choice.delta) ?? {};
          return {
            text: isString(delta.content) ? delta.content : '',
            index: typeof choice.index === 'number' ? choice.index : 0,
            logprobs: choice.logprobs ?? null,
            finish_reason: choice.finish_reason ?? null,
          };
        });
        const legacyPayload = {
          ...payload,
          id: this.toLegacyCompletionId(this.asString(payload.id) ?? ''),
          object: 'text_completion',
          choices,
        };
        converted.push(`data: ${JSON.stringify(legacyPayload)}\n\n`);
      } catch {
        converted.push(`${event}\n\n`);
      }
    }
    return converted.join('');
  }

  private toLegacyCompletionId(id: string): string {
    if (id.startsWith('chatcmpl-')) {
      return `cmpl-${id.slice('chatcmpl-'.length)}`;
    }
    return id.startsWith('cmpl-') ? id : `cmpl-${id}`;
  }

  public prepareResponsesRequest(body: ResponsesRequestBody): PreparedResponsesRequest | null {
    const normalizedBody = normalizeOpenAIResponsesRequest(body);
    const currentInputItems = this.normalizeResponsesInputItems(normalizedBody.input);
    const previousSession = normalizedBody.previous_response_id
      ? OpenAIResponsesSessionStore.get(normalizedBody.previous_response_id)
      : null;
    if (normalizedBody.previous_response_id && !previousSession) {
      return null;
    }

    const inputItems = mergeOpenAIResponsesInputItems(
      previousSession?.inputItems ?? [],
      currentInputItems,
      previousSession?.toolCallItems,
    );
    const model = normalizedBody.model ?? previousSession?.model ?? 'gemini-3-flash';
    const instructions = normalizedBody.instructions;
    const tools = normalizedBody.tools ?? previousSession?.tools;
    const request = this.buildResponsesChatRequest({
      ...normalizedBody,
      input: inputItems,
      instructions,
      model,
      tools,
    });

    return {
      request,
      responseContext: {
        instructions,
        maxOutputTokens: normalizedBody.max_output_tokens,
        metadata: normalizedBody.metadata,
        parallelToolCalls: normalizedBody.parallel_tool_calls,
        previousResponseId: normalizedBody.previous_response_id,
        reasoning: normalizedBody.reasoning,
        store: normalizedBody.store,
        temperature: normalizedBody.temperature,
        text: normalizedBody.text,
        toolChoice: normalizedBody.tool_choice,
        tools: normalizedBody.tools,
        topP: normalizedBody.top_p,
        truncation: normalizedBody.truncation,
      },
      session: {
        inputItems,
        instructions,
        model,
        requestDefaults: {
          ...(normalizedBody.tool_choice !== undefined
            ? { tool_choice: normalizedBody.tool_choice }
            : {}),
        },
        store: normalizedBody.store !== false,
        tools,
      },
    };
  }

  private normalizeResponsesInputItems(input: unknown): unknown[] {
    return normalizeOpenAIResponsesInputItems(input);
  }

  private cacheResponsesStream(
    stream: Observable<unknown>,
    session: OpenAIResponsesSession,
  ): Observable<unknown> {
    return inheritUpstreamBackpressure(
      stream,
      new Observable<unknown>((subscriber) => {
        const subscription = stream.subscribe({
          next: (event) => {
            this.saveResponsesSession(this.extractCompletedResponsesEvent(event), session);
            subscriber.next(event);
          },
          error: (error: unknown) => subscriber.error(error),
          complete: () => subscriber.complete(),
        });

        return () => subscription.unsubscribe();
      }),
    );
  }

  private extractCompletedResponsesEvent(event: unknown): unknown | null {
    if (!isString(event)) {
      return null;
    }

    const dataLine = event.split(/\r?\n/).find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return null;
    }

    try {
      const parsed = this.toRecord(JSON.parse(dataLine.slice('data:'.length).trimStart()));
      return parsed?.type === 'response.completed' || parsed?.type === 'response.incomplete'
        ? (parsed.response ?? null)
        : null;
    } catch {
      return null;
    }
  }

  private saveResponsesSession(response: unknown, session: OpenAIResponsesSession): void {
    if (session.store === false) {
      return;
    }
    const responseRecord = this.toRecord(response);
    const responseId = this.asString(responseRecord?.id);
    const output = responseRecord?.output;
    if (!responseId || !Array.isArray(output)) {
      return;
    }

    OpenAIResponsesSessionStore.save(responseId, {
      ...session,
      inputItems: [...session.inputItems, ...output],
    });
  }

  private normalizeResponsesInput(input: unknown): string {
    if (isString(input)) {
      return input;
    }

    if (Array.isArray(input)) {
      return input
        .map((item) => {
          if (isString(item)) {
            return item;
          }
          const itemRecord = this.toRecord(item);
          const content = this.asString(itemRecord?.content);
          if (content) {
            return content;
          }
          return JSON.stringify(item);
        })
        .join('\n');
    }

    if (isNil(input)) {
      return '';
    }

    return JSON.stringify(input);
  }

  private buildResponsesChatRequest(body: ResponsesRequestBody): OpenAIChatRequest {
    const reasoningEffort = mapResponsesReasoningEffort(body.reasoning?.effort);
    const messages: OpenAIChatRequest['messages'] = [];
    if (isString(body.instructions) && !isEmpty(body.instructions.trim())) {
      messages.push({
        role: 'system',
        content: body.instructions,
      });
    }

    const callIdToToolName = new Map<string, string>();
    const incompleteCustomCallIds = new Set<string>();
    const applyPatchFailureCompactor = new ApplyPatchFailureCompactor();
    const inputItems = Array.isArray(body.input) ? body.input : null;

    if (inputItems) {
      for (const item of inputItems) {
        const itemObj = this.toRecord(item);
        if (!itemObj) {
          continue;
        }

        const type = this.asString(itemObj.type);
        if (!type) {
          continue;
        }

        if (
          type === 'function_call' ||
          type === 'local_shell_call' ||
          type === 'web_search_call' ||
          type === 'custom_tool_call'
        ) {
          const callId =
            this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? `call_${Date.now()}`;
          if (
            type === 'custom_tool_call' &&
            this.asString(itemObj.status)?.toLowerCase() === 'incomplete'
          ) {
            incompleteCustomCallIds.add(callId);
            continue;
          }

          const toolName =
            type === 'local_shell_call'
              ? 'shell'
              : type === 'web_search_call'
                ? 'builtin_web_search'
                : (this.asString(itemObj.name) ?? 'unknown');
          callIdToToolName.set(callId, toolName);
        }
      }

      for (const item of inputItems) {
        const itemObj = this.toRecord(item);
        if (!itemObj) {
          continue;
        }

        const type = this.asString(itemObj.type);
        if (!type) {
          continue;
        }

        if (type === 'message') {
          const role = this.asString(itemObj.role) ?? 'user';
          const content = this.normalizeResponsesMessageContent(itemObj.content);
          messages.push({ role, content });
          continue;
        }

        if (
          type === 'function_call' ||
          type === 'local_shell_call' ||
          type === 'web_search_call' ||
          type === 'custom_tool_call'
        ) {
          const callId =
            this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? `call_${Date.now()}`;
          if (incompleteCustomCallIds.has(callId)) {
            continue;
          }

          const toolName = callIdToToolName.get(callId) ?? 'unknown';
          const customInput =
            type === 'custom_tool_call' ? (this.asString(itemObj.input) ?? '') : undefined;
          const args =
            customInput === undefined
              ? this.resolveToolArguments(type, itemObj)
              : toCustomToolArguments(toolName, customInput);
          const toolCall: OpenAIToolCall = {
            id: callId,
            type: 'function',
            function: {
              name: toolName,
              arguments: JSON.stringify(args),
            },
          };
          if (customInput !== undefined) {
            toolCall.custom_input = customInput;
          }
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
          });
          continue;
        }

        if (type === 'function_call_output' || type === 'custom_tool_call_output') {
          const callId = this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? 'unknown';
          if (incompleteCustomCallIds.has(callId)) {
            continue;
          }
          if (type === 'custom_tool_call_output' && !callIdToToolName.has(callId)) {
            continue;
          }

          const toolName = callIdToToolName.get(callId) ?? 'unknown';
          const normalizedOutput = this.normalizeResponsesOutput(itemObj.output);
          const output =
            toolName === 'apply_patch'
              ? applyPatchFailureCompactor.compact(normalizedOutput)
              : normalizedOutput;
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            name: toolName,
            content: output,
          });
          continue;
        }
      }
    } else if (isString(body.input)) {
      messages.push({
        role: 'user',
        content: body.input,
      });
    } else if (!isNil(body.input)) {
      messages.push({
        role: 'user',
        content: this.normalizeResponsesInput(body.input),
      });
    }

    if (messages.length === 0) {
      messages.push({
        role: 'user',
        content: '',
      });
    }

    return {
      model: body.model ?? 'gemini-3-flash',
      messages,
      tools: body.tools,
      max_tokens: body.max_output_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      presence_penalty: body.presence_penalty,
      frequency_penalty: body.frequency_penalty,
      seed: body.seed,
      tool_choice: body.tool_choice,
      parallel_tool_calls: body.parallel_tool_calls,
      reasoning_effort: reasoningEffort,
      thinking: body.reasoning
        ? {
            type: body.reasoning.effort === 'none' ? 'disabled' : 'enabled',
            effort: reasoningEffort,
          }
        : undefined,
      response_format: this.toResponsesChatResponseFormat(body.text),
      store: body.store,
      metadata: body.metadata as Record<string, string> | undefined,
      service_tier: body.service_tier,
      user: body.user,
      stream: body.stream,
      extra: {
        ...(body.metadata ?? {}),
        include: body.include,
        previous_response_id: body.previous_response_id,
        text_verbosity: this.asString(body.text?.verbosity) ?? undefined,
        truncation: body.truncation,
        user_id: body.user,
      },
    };
  }

  private toResponsesChatResponseFormat(
    text: Record<string, unknown> | undefined,
  ): OpenAIChatRequest['response_format'] {
    const format = this.toRecord(text?.format);
    if (!format) {
      return undefined;
    }
    const type = this.asString(format.type);
    if (type !== 'json_schema') {
      return type ? { type } : undefined;
    }
    return {
      type,
      json_schema: {
        name: this.asString(format.name) ?? undefined,
        description: this.asString(format.description) ?? undefined,
        schema: this.toRecord(format.schema) ?? undefined,
        strict: typeof format.strict === 'boolean' ? format.strict : undefined,
      },
    };
  }

  private normalizeResponsesMessageContent(content: unknown): string | OpenAIContentPart[] {
    if (isString(content)) {
      return content;
    }

    if (!Array.isArray(content)) {
      return this.normalizeResponsesInput(content);
    }

    const textParts: string[] = [];
    const imageParts: OpenAIContentPart[] = [];

    for (const item of content) {
      const block = this.toRecord(item);
      if (!block) {
        continue;
      }

      const blockType = this.asString(block.type);
      if (blockType === 'input_text' || blockType === 'text' || blockType === 'output_text') {
        const text = this.asString(block.text);
        if (text) {
          textParts.push(text);
        }
        continue;
      }

      if (blockType === 'input_image' || blockType === 'image_url') {
        const imageUrl = this.resolveImageUrl(block);
        if (imageUrl) {
          imageParts.push({
            type: 'image_url',
            image_url: {
              url: imageUrl,
            },
          });
        }
      }
    }

    if (imageParts.length === 0) {
      return textParts.join('\n');
    }

    const merged: OpenAIContentPart[] = [];
    if (textParts.length > 0) {
      merged.push({
        type: 'text',
        text: textParts.join('\n'),
      });
    }
    merged.push(...imageParts);
    return merged;
  }

  private resolveToolArguments(
    type: string,
    item: Record<string, unknown>,
  ): Record<string, unknown> {
    if (type === 'local_shell_call') {
      const action = this.toRecord(item.action);
      const exec = action ? this.toRecord(action.exec) : null;
      const command = this.asString(exec?.command);
      return {
        command: command ? [command] : [],
      };
    }

    if (type === 'web_search_call') {
      const action = this.toRecord(item.action);
      return {
        query: this.asString(action?.query) ?? '',
      };
    }

    const raw = item.arguments;
    if (isString(raw)) {
      try {
        const parsed = JSON.parse(raw);
        const parsedRecord = this.toRecord(parsed);
        if (parsedRecord) {
          return parsedRecord;
        }
        return {
          value: parsed,
        };
      } catch {
        return {
          raw,
        };
      }
    }

    const rawRecord = this.toRecord(raw);
    if (rawRecord) {
      return rawRecord;
    }

    return {};
  }

  private normalizeResponsesOutput(output: unknown): string {
    if (isString(output)) {
      return output;
    }
    const outputRecord = this.toRecord(output);
    const content = this.asString(outputRecord?.content);
    if (content) {
      return content;
    }
    if (isNil(output)) {
      return '';
    }
    return JSON.stringify(output);
  }

  private resolveImageUrl(block: Record<string, unknown>): string | null {
    const raw = block.image_url;
    if (isString(raw)) {
      return raw;
    }
    const rawRecord = this.toRecord(raw);
    const url = this.asString(rawRecord?.url);
    if (url) {
      return url;
    }
    return null;
  }

  private collectImageContentParts(
    entries: Array<string | { data?: string; mimeType?: string } | undefined>,
    defaultMimeType: string,
  ): OpenAIContentPart[] {
    const parts: OpenAIContentPart[] = [];
    for (const entry of entries) {
      const inlineData = this.resolveInlineData(entry, defaultMimeType);
      if (!inlineData) {
        continue;
      }
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${inlineData.mimeType};base64,${inlineData.data}`,
        },
      });
    }
    return parts;
  }

  private resolveInlineData(
    input: unknown,
    defaultMimeType: string,
  ): {
    mimeType: string;
    data: string;
  } | null {
    if (!input) {
      return null;
    }

    if (isString(input)) {
      const dataUri = input.match(/^data:(?<mime>[^;]+);base64,(?<data>[A-Za-z0-9+/=]+)$/);
      if (dataUri?.groups?.mime && dataUri.groups.data) {
        return {
          mimeType: dataUri.groups.mime,
          data: dataUri.groups.data,
        };
      }

      const cleaned = input.replace(/\s+/g, '');
      if (cleaned.length > 0) {
        return {
          mimeType: defaultMimeType,
          data: cleaned,
        };
      }
      return null;
    }

    const inputRecord = this.toRecord(input);
    if (inputRecord) {
      const data = this.asString(inputRecord.data);
      if (!data) {
        return null;
      }
      return {
        mimeType: this.asString(inputRecord.mimeType) ?? defaultMimeType,
        data,
      };
    }

    return null;
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (!isPlainObject(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | null {
    return isString(value) ? value : null;
  }

  private getModelRouteResponseHeaders(
    result: unknown,
    requestedModel: string | undefined,
  ): Record<string, string> {
    let metadata = getModelRouteMetadata(result);
    if (!metadata && requestedModel && this.modelRoutingService) {
      const route = this.modelRoutingService.resolveModelRoute(requestedModel);
      const responseRecord = isObjectLike(result) ? (result as Record<string, unknown>) : undefined;
      metadata = {
        requestedModel,
        resolvedModel: route.targetModel,
        servedModel:
          this.asString(responseRecord?.model) ??
          this.asString(responseRecord?.modelVersion) ??
          undefined,
        routeSource: route.source,
      } satisfies ModelRouteMetadata;
    }
    return createModelRouteHeaders(metadata);
  }

  private applyResponseHeaders(res: FastifyReply, headers: Record<string, string>): void {
    for (const [name, value] of Object.entries(headers)) {
      res.header(name, value);
    }
  }

  private isObservableLike(value: unknown): value is Observable<unknown> {
    return isObjectLike(value) && isFunction((value as { subscribe?: unknown }).subscribe);
  }

  private writeSseResponse(
    res: FastifyReply,
    stream: Observable<unknown>,
    protocol: 'anthropic' | 'openai' = 'openai',
    responseHeaders: Record<string, string> = {},
  ): void {
    if (!res.raw || !isFunction(res.raw.writeHead) || !isFunction(res.raw.write)) {
      res.header('Content-Type', 'text/event-stream');
      res.header('Cache-Control', 'no-cache');
      res.header('Connection', 'keep-alive');
      for (const [name, value] of Object.entries(responseHeaders)) {
        res.header(name, value);
      }
      res.send(stream);
      return;
    }

    if (isFunction((res as { hijack?: () => void }).hijack)) {
      (res as { hijack: () => void }).hijack();
    }

    res.raw.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...responseHeaders,
    });

    let waitingForDrain = false;
    let subscription: { unsubscribe(): void } | undefined;
    const clearDrainListener = (): void => {
      if (!waitingForDrain) {
        return;
      }
      waitingForDrain = false;
      res.raw.removeListener('drain', onDrain);
    };
    const onDrain = (): void => {
      waitingForDrain = false;
      resumeObservableUpstream(stream);
    };
    const onClose = (): void => {
      clearDrainListener();
      subscription?.unsubscribe();
    };
    const cleanupResponseListeners = (): void => {
      clearDrainListener();
      res.raw.removeListener('close', onClose);
    };

    res.raw.on('close', onClose);
    subscription = stream.subscribe({
      next: (chunk) => {
        if (res.raw.writableEnded) {
          return;
        }
        const payload = isString(chunk) ? chunk : String(chunk ?? '');
        if (!res.raw.write(payload) && !waitingForDrain) {
          waitingForDrain = true;
          pauseObservableUpstream(stream);
          res.raw.once('drain', onDrain);
        }
      },
      error: (error) => {
        if (res.raw.writableEnded) {
          return;
        }
        cleanupResponseListeners();
        const message = error instanceof Error ? error.message : String(error);
        if (protocol === 'anthropic') {
          const descriptor = this.resolveAnthropicError(error, message);
          res.raw.write(
            `event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: {
                type: descriptor.type,
                message,
              },
            })}\n\n`,
          );
          res.raw.end();
          return;
        }
        res.raw.write(
          `data: ${JSON.stringify({
            error: {
              message,
              type: 'server_error',
            },
          })}\n\n`,
        );
        res.raw.end();
      },
      complete: () => {
        cleanupResponseListeners();
        if (!res.raw.writableEnded) {
          res.raw.end();
        }
      },
    });
  }

  private async sendOpenAIImageGenerationResponse(
    request: OpenAIChatRequest,
    prompt: string,
    path: '/v1/images/generations' | '/v1/images/edits',
    body: ImageMonitoringRequest,
    res: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.proxyService.handleChatCompletions(request);
      const routeHeaders = this.getModelRouteResponseHeaders(result, request.model);
      if (this.isObservableLike(result)) {
        if (body.stream) {
          const stream = inheritUpstreamBackpressure(
            result,
            mapOpenAIImageStream(result, {
              partialImages: body.partial_images ?? 0,
              path,
              quality: body.quality,
              size: body.size,
            }).pipe(
              tap({
                complete: () => this.scheduleImageQuotaRefresh(),
              }),
            ),
          );
          this.writeSseResponse(res, stream, 'openai', routeHeaders);
          return;
        }
        this.logProxyEndpointError(
          path,
          HttpStatus.INTERNAL_SERVER_ERROR,
          'Upstream unexpectedly returned a stream for a buffered image request',
        );
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
          error: {
            message: 'Upstream unexpectedly returned a stream for a buffered image request',
            type: 'invalid_request_error',
          },
        });
        return;
      }

      const content = result.choices?.[0]?.message?.content;
      const image = this.extractInlineBase64Image(isString(content) ? content : '');
      if (!image) {
        this.logProxyEndpointError(
          path,
          HttpStatus.BAD_GATEWAY,
          'Upstream did not return inline image data',
        );
        res.status(HttpStatus.BAD_GATEWAY).send({
          error: {
            message: 'Upstream did not return inline image data',
            type: 'invalid_response_error',
          },
        });
        return;
      }

      const response: OpenAIImageResponse = {
        created: Math.floor(Date.now() / 1000),
        output_format: this.resolveImageOutputFormat(image.mimeType),
        data: [
          {
            b64_json: image.data,
          },
        ],
      };
      this.sendOpenAIImageSuccess(response, path, body, res, routeHeaders);
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Internal Server Error';
      let resolvedError = error;

      if (this.isProjectContextErrorMessage(message)) {
        try {
          const geminiRequest = this.buildGeminiImageRequest(request, prompt);
          const geminiResult = await this.proxyService.handleGeminiGenerateContent(
            request.model ?? 'gemini-3.1-flash-image',
            geminiRequest,
          );
          const fallbackImage = this.extractInlineBase64ImageFromGeminiResponse(geminiResult);
          if (fallbackImage) {
            const response: OpenAIImageResponse = {
              created: Math.floor(Date.now() / 1000),
              output_format: this.resolveImageOutputFormat(fallbackImage.mimeType),
              data: [
                {
                  b64_json: fallbackImage.data,
                },
              ],
            };
            this.sendOpenAIImageSuccess(
              response,
              path,
              body,
              res,
              this.getModelRouteResponseHeaders(geminiResult, request.model),
            );
            return;
          }
          message = 'Upstream did not return inline image data';
          resolvedError = new UpstreamRequestError({
            message,
            status: HttpStatus.BAD_GATEWAY,
          });
        } catch (fallbackError) {
          resolvedError = fallbackError;
          message = fallbackError instanceof Error ? fallbackError.message : message;
        }
      }

      this.sendOpenAIErrorResponse(res, path, resolvedError, message);
    }
  }

  private sendOpenAIImageSuccess(
    response: OpenAIImageResponse,
    path: '/v1/images/generations' | '/v1/images/edits',
    body: ImageMonitoringRequest,
    res: FastifyReply,
    routeHeaders: Record<string, string> = {},
  ): void {
    this.logImageMonitoringSummary('response', summarizeImageResponse(response));
    this.scheduleImageQuotaRefresh();
    if (!body.stream) {
      this.applyResponseHeaders(res, routeHeaders);
      res.status(HttpStatus.OK).send(response);
      return;
    }

    this.logger.warn(
      `${path} upstream stream setup fell back to a buffered result; emitting only the completed image event`,
    );

    const type = path.endsWith('/edits') ? 'image_edit.completed' : 'image_generation.completed';
    const event = {
      type,
      b64_json: response.data[0]?.b64_json ?? '',
      background: 'auto',
      created_at: response.created,
      output_format: response.output_format ?? 'png',
      quality: body.quality ?? 'auto',
      size: body.size ?? 'auto',
    };
    this.writeSseResponse(
      res,
      of(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`),
      'openai',
      routeHeaders,
    );
  }

  private resolveImageOutputFormat(mimeType: string): string {
    if (mimeType === 'image/jpeg') {
      return 'jpeg';
    }
    if (mimeType === 'image/webp') {
      return 'webp';
    }
    return 'png';
  }

  private logImageMonitoringSummary(direction: 'request' | 'response', summary: unknown): void {
    this.logger.log(`[ImageMonitor] ${direction} ${safeStringifyPacket(summary)}`);
  }

  /**
   * Image requests can consume quota outside the regular account-lease refresh cadence.
   * Keep this asynchronous so a successful image response is never delayed by monitoring I/O.
   */
  private scheduleImageQuotaRefresh(): void {
    if (!this.imageQuotaRefresh) {
      return;
    }

    this.imageQuotaRefresh().catch((error: unknown) => {
      this.logger.warn('Failed to refresh quotas after image generation', error);
    });
  }

  private extractInlineBase64Image(content: string): {
    mimeType: string;
    data: string;
  } | null {
    const pattern = /data:(?<mime>[\w/+.-]+);base64,(?<data>[^)\s"'\\]*)/gu;
    let finalImage: { mimeType: string; data: string } | null = null;
    for (const matched of content.matchAll(pattern)) {
      if (!matched.groups) {
        continue;
      }
      finalImage = this.validateUpstreamInlineImage(
        `data:${matched.groups.mime};base64,${matched.groups.data}`,
      );
    }
    return finalImage;
  }

  private extractInlineBase64ImageFromGeminiResponse(response: GeminiResponse): {
    mimeType: string;
    data: string;
  } | null {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    let finalImage: { mimeType: string; data: string } | null = null;
    for (const part of parts) {
      if (part.inlineData?.data) {
        finalImage = this.validateUpstreamInlineImage({
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType ?? 'image/jpeg',
        });
      }
      if (part.text) {
        const parsed = this.extractInlineBase64Image(part.text);
        if (parsed || part.text.includes('data:')) {
          finalImage = parsed;
        }
      }
    }
    return finalImage;
  }

  private validateUpstreamInlineImage(input: unknown): {
    mimeType: string;
    data: string;
  } | null {
    try {
      const parsed = parseInlineMediaInput(input, {
        kind: 'image',
        maxBytes: OPENAI_IMAGE_RESPONSE_BYTES_LIMIT,
        param: 'upstream_image',
      });
      return isOpenAIImageOutputMimeType(parsed.mimeType)
        ? { mimeType: parsed.mimeType, data: parsed.data }
        : null;
    } catch {
      return null;
    }
  }

  private buildGeminiImageRequest(
    request: OpenAIChatRequest,
    fallbackPrompt: string,
  ): GeminiRequest {
    const userMessage = request.messages.find((message) => message.role === 'user');
    const textParts: string[] = [];
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

    if (!userMessage) {
      parts.push({ text: fallbackPrompt || 'Please generate an image based on this request.' });
    } else if (isString(userMessage.content)) {
      parts.push({
        text:
          userMessage.content ||
          fallbackPrompt ||
          'Please generate an image based on this request.',
      });
    } else if (Array.isArray(userMessage.content)) {
      for (const block of userMessage.content) {
        if (block.type === 'text' && isString(block.text) && !isEmpty(block.text.trim())) {
          textParts.push(block.text);
        }
        if (block.type === 'image_url') {
          const imageUrl = this.resolveImageUrl(block as unknown as Record<string, unknown>);
          const inlineData = this.resolveInlineData(imageUrl, 'image/png');
          if (inlineData) {
            parts.push({
              inlineData: {
                mimeType: inlineData.mimeType,
                data: inlineData.data,
              },
            });
          }
        }
      }
      if (textParts.length > 0) {
        parts.unshift({ text: textParts.join('\n') });
      }
    } else {
      parts.push({ text: fallbackPrompt || 'Please generate an image based on this request.' });
    }

    if (parts.length === 0) {
      parts.push({ text: fallbackPrompt || 'Please generate an image based on this request.' });
    }

    const metadata = this.toRecord(request.extra);
    const metadataAspectRatio = this.asString(metadata?.image_aspect_ratio);
    const metadataImageSize = this.asString(metadata?.image_size);
    const imageConfig: Record<string, string> = {};
    if (
      metadataAspectRatio &&
      ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(metadataAspectRatio)
    ) {
      imageConfig.aspectRatio = metadataAspectRatio;
    }
    if (metadataImageSize && ['1K', '2K', '4K'].includes(metadataImageSize)) {
      imageConfig.imageSize = metadataImageSize;
    }

    return {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      ...(Object.keys(imageConfig).length > 0 ? { generationConfig: { imageConfig } } : {}),
    };
  }

  private isProjectContextErrorMessage(message: string): boolean {
    const lowered = message.toLowerCase();
    return (
      lowered.includes('#3501') ||
      (lowered.includes('google cloud project') && lowered.includes('code assist license')) ||
      (lowered.includes('resource projects/') && lowered.includes('could not be found')) ||
      (lowered.includes('project') && lowered.includes('not found'))
    );
  }

  private hasMultipartBoundary(req: FastifyRequest): boolean {
    const contentType = req.headers['content-type'];
    if (!isString(contentType)) {
      return false;
    }

    const lowered = contentType.toLowerCase();
    return lowered.includes('multipart/form-data') && lowered.includes('boundary=');
  }

  private resolveErrorMessageText(error: unknown): string {
    return error instanceof Error ? error.message : 'Internal Server Error';
  }

  private sendOpenAIErrorResponse(
    res: FastifyReply,
    endpoint: string,
    error: unknown,
    overrideMessage?: string,
  ): void {
    const message = overrideMessage ?? this.resolveErrorMessageText(error);
    if (error instanceof OpenAIMediaRequestError) {
      this.logProxyEndpointError(endpoint, error.statusCode, message, error);
      res.status(error.statusCode).send({
        error: {
          message,
          type: error.type,
          param: error.param,
          code: error.code,
        },
      });
      return;
    }
    if (error instanceof ModelRouteError) {
      const status = error.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
      this.logProxyEndpointError(endpoint, status as HttpStatus, message, error);
      res.status(status).send({
        error: {
          message,
          type:
            status === HttpStatus.NOT_FOUND
              ? 'invalid_request_error'
              : status === HttpStatus.TOO_MANY_REQUESTS
                ? 'rate_limit_error'
                : 'server_error',
          param: 'model',
          code: error.code,
        },
      });
      return;
    }
    if (error instanceof OpenAIRequestValidationError) {
      this.logProxyEndpointError(endpoint, HttpStatus.BAD_REQUEST, message, error);
      res.status(HttpStatus.BAD_REQUEST).send({
        error: {
          message,
          type: error.type,
          param: error.param,
          code: error.code,
        },
      });
      return;
    }
    const status = this.resolveErrorHttpStatus(message, error);
    this.logProxyEndpointError(endpoint, status, message, error);
    res.status(status).send({
      error: {
        message,
        type: 'server_error',
      },
    });
  }

  private sendAnthropicErrorResponse(
    res: FastifyReply,
    endpoint: string,
    error: unknown,
    overrideMessage?: string,
    requestId: string = this.createAnthropicRequestId(),
  ): void {
    const message = overrideMessage ?? this.resolveErrorMessageText(error);
    const descriptor = this.resolveAnthropicError(error, message);
    this.logProxyEndpointError(endpoint, descriptor.status, message, error);
    res
      .header('request-id', requestId)
      .status(descriptor.status)
      .send({
        type: 'error',
        error: {
          type: descriptor.type,
          message,
        },
        request_id: requestId,
      });
  }

  private createAnthropicRequestId(): string {
    return `req_${uuidv4().replace(/-/gu, '')}`;
  }

  private resolveAnthropicError(
    error: unknown,
    message: string,
  ): { status: HttpStatus; type: string } {
    if (error instanceof AnthropicRequestValidationError) {
      return { status: HttpStatus.BAD_REQUEST, type: 'invalid_request_error' };
    }

    const resolvedStatus = this.resolveErrorHttpStatus(message, error);
    switch (resolvedStatus) {
      case HttpStatus.BAD_REQUEST:
        return { status: resolvedStatus, type: 'invalid_request_error' };
      case HttpStatus.UNAUTHORIZED:
        return { status: resolvedStatus, type: 'authentication_error' };
      case HttpStatus.PAYMENT_REQUIRED:
        return { status: resolvedStatus, type: 'billing_error' };
      case HttpStatus.FORBIDDEN:
        return { status: resolvedStatus, type: 'permission_error' };
      case HttpStatus.NOT_FOUND:
        return { status: resolvedStatus, type: 'not_found_error' };
      case HttpStatus.CONFLICT:
        return { status: resolvedStatus, type: 'conflict_error' };
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return { status: resolvedStatus, type: 'request_too_large' };
      case HttpStatus.TOO_MANY_REQUESTS:
        return { status: resolvedStatus, type: 'rate_limit_error' };
      case HttpStatus.GATEWAY_TIMEOUT:
        return { status: resolvedStatus, type: 'timeout_error' };
      case HttpStatus.SERVICE_UNAVAILABLE:
        return { status: 529 as HttpStatus, type: 'overloaded_error' };
      default:
        return { status: HttpStatus.INTERNAL_SERVER_ERROR, type: 'api_error' };
    }
  }

  private resolveErrorHttpStatus(message: string, error?: unknown): HttpStatus {
    if (
      error instanceof UpstreamRequestError &&
      Number.isInteger(error.status) &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status <= 599
    ) {
      return error.status as HttpStatus;
    }

    const lowered = message.toLowerCase();
    if (lowered.includes('all accounts failed or unhealthy')) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (lowered.includes('all accounts exhausted') || lowered.includes('no available accounts')) {
      return HttpStatus.TOO_MANY_REQUESTS;
    }
    if (
      lowered.includes('network socket disconnected') ||
      lowered.includes('secure tls connection was established') ||
      lowered.includes('socket hang up') ||
      lowered.includes('econnreset') ||
      lowered.includes('eai_again')
    ) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (lowered.includes('401') || lowered.includes('unauthorized')) {
      return HttpStatus.UNAUTHORIZED;
    }
    if (lowered.includes('403') || lowered.includes('forbidden')) {
      return HttpStatus.FORBIDDEN;
    }
    if (lowered.includes('429') || lowered.includes('rate limit') || lowered.includes('quota')) {
      return HttpStatus.TOO_MANY_REQUESTS;
    }
    if (lowered.includes('503') || lowered.includes('service unavailable')) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (lowered.includes('502') || lowered.includes('bad gateway')) {
      return HttpStatus.BAD_GATEWAY;
    }
    if (lowered.includes('504') || lowered.includes('timeout')) {
      return HttpStatus.GATEWAY_TIMEOUT;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private logProxyEndpointError(
    endpoint: string,
    status: HttpStatus,
    message: string,
    error?: unknown,
  ): void {
    const base = `[${endpoint}] status=${status} message=${message}`;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(base, error instanceof Error ? error.stack : undefined);
      return;
    }
    this.logger.warn(base);
  }
}
