import {
  All,
  Controller,
  Post,
  Get,
  Body,
  Res,
  HttpStatus,
  UseGuards,
  Inject,
  Req,
  Logger,
  Optional,
  Param,
  UseFilters,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { MultipartFile } from '@fastify/multipart';
import {
  isBoolean,
  isEmpty,
  isFunction,
  isNil,
  isNumber,
  isObjectLike,
  isPlainObject,
  isString,
} from 'lodash-es';
import { ProxyService } from './proxy.service';
import { Observable } from 'rxjs';
import {
  OpenAIChatRequest,
  AnthropicChatRequest,
  OpenAIChatResponse,
  OpenAIContentPart,
  OpenAILegacyCompletionRequest,
  OpenAIStreamOptions,
  GeminiRequest,
  GeminiResponse,
} from './interfaces/request-interfaces';
import { ProxyGuard } from './proxy.guard';
import {
  getOpenAICompatibleModels,
  MODEL_LIST_CREATED_AT,
  MODEL_LIST_OWNER,
  OPENAI_COMPATIBLE_DEFAULT_MODELS,
} from '../antigravity/ModelMapping';
import { getServerConfig } from '../../../server/server-config';
import { AccountLeaseService } from './account-lease.service';
import { UpstreamRequestError } from './clients/upstream-error';
import {
  OpenAIProtocolException,
  ProxyProtocolExceptionFilter,
  mapOpenAIProtocolError,
  sendOpenAIProtocolError,
} from './openai-protocol-error';
import { isMultipartParserOrLimitError } from './fastify-multipart.provider';
import { type OpenAIResponsesConfiguration } from '../antigravity/OpenAIResponsesStreamingMapper';
import {
  isValidBase64,
  type MediaKind,
  parseAudioDataUrl,
  parseImageDataUrl,
} from './image-data-url';

type InlineInput = string | { data?: string; mimeType?: string };

interface MultipartMediaInput {
  fields: Record<string, string | string[]>;
  files: Record<string, InlineInput[]>;
}

interface MediaInput {
  model?: string;
  prompt?: string;
  size?: string;
  quality?: string;
  n?: string;
  responseFormat?: string;
  outputFormat?: string;
  background?: string;
  moderation?: string;
  outputCompression?: string;
  partialImages?: string;
  stream?: string;
  style?: string;
  inputFidelity?: string;
  user?: string;
  language?: string;
  temperature?: number;
  invalidTemperature: boolean;
  timestampGranularities: string[];
  images: InlineInput[];
  referenceImages: InlineInput[];
  mask?: InlineInput;
  file?: InlineInput;
  audio?: InlineInput;
}

interface ToolCallValidationState {
  declaredIds: Set<string>;
  consumedIds: Set<string>;
}

interface OpenAIResponsesRequest {
  model?: string;
  instructions?: string;
  input?: unknown;
  tools?: OpenAIChatRequest['tools'];
  tool_choice?: OpenAIChatRequest['tool_choice'];
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  previous_response_id?: unknown;
  text?: unknown;
  background?: unknown;
  parallel_tool_calls?: unknown;
  store?: unknown;
  reasoning?: unknown;
  truncation?: unknown;
  max_tool_calls?: unknown;
  metadata?: unknown;
}

interface ImageOptionInput {
  model?: string;
  n?: number | string;
  response_format?: string;
  responseFormat?: string;
  output_format?: string;
  outputFormat?: string;
  size?: string;
  quality?: string;
  background?: string;
  moderation?: string;
  output_compression?: number | string;
  outputCompression?: string;
  partial_images?: number | string;
  partialImages?: string;
  stream?: boolean | string;
  style?: string;
  input_fidelity?: string;
  inputFidelity?: string;
  user?: string;
}

@Controller('v1')
@UseGuards(ProxyGuard)
@UseFilters(ProxyProtocolExceptionFilter)
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);

  constructor(
    @Inject(ProxyService) private readonly proxyService: ProxyService,
    @Optional()
    @Inject(AccountLeaseService)
    private readonly accountLeaseService?: AccountLeaseService,
  ) {}

  @Get('models')
  listModels(@Res() res: FastifyReply) {
    try {
      const data = this.buildOpenAIModelList();

      res.status(HttpStatus.OK).send({
        object: 'list',
        data,
      });
    } catch (error) {
      this.logger.error('Failed to list models', error instanceof Error ? error.stack : undefined);
      sendOpenAIProtocolError(res, error);
    }
  }

  @Get('models/:model')
  getModel(@Param('model') model: string, @Res() res: FastifyReply) {
    const matched = this.buildOpenAIModelList().find((item) => item.id === model);
    if (!matched) {
      sendOpenAIProtocolError(
        res,
        new OpenAIProtocolException(`The model '${model}' does not exist`, HttpStatus.NOT_FOUND, {
          param: 'model',
          code: 'model_not_found',
        }),
      );
      return;
    }
    res.status(HttpStatus.OK).send(matched);
  }

  @Post('chat/completions')
  async chatCompletions(@Body() body: OpenAIChatRequest, @Res() res: FastifyReply) {
    this.validateChatRequest(body);
    await this.respondOpenAIChatCompletions(body, res);
  }

  @Post('completions')
  async completions(
    @Body()
    body: OpenAILegacyCompletionRequest,
    @Res() res: FastifyReply,
  ) {
    this.requireJsonObject(body);
    this.requireNonEmptyString(body.model, 'model');
    this.validateCompletionPrompt(body.prompt);
    this.validateUnsupportedSamplingOptions(body);
    this.validateUnsupportedIdentityOptions(body);
    this.validateLegacyOnlyOptions(body);
    this.validatePositiveInteger('max_tokens', body.max_tokens);
    const stop = this.normalizeStopSequences(body.stop);
    const request: OpenAIChatRequest = {
      model: body.model,
      messages: [
        {
          role: 'user',
          content: this.normalizeCompletionPrompt(body.prompt),
        },
      ],
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop,
      stream: body.stream,
      stream_options: body.stream_options,
    };
    try {
      const result = await this.proxyService.handleChatCompletions(request, 'text-completions');
      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      }

      const response = result as OpenAIChatResponse;
      res.status(HttpStatus.OK).send(this.toLegacyTextCompletionsResponse(response));
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/completions', error);
    }
  }

  @Post('responses')
  async responses(
    @Body()
    body: {
      model?: string;
      instructions?: string;
      input?: unknown;
      tools?: OpenAIChatRequest['tools'];
      tool_choice?: OpenAIChatRequest['tool_choice'];
      max_output_tokens?: number;
      temperature?: number;
      top_p?: number;
      stream?: boolean;
    },
    @Res() res: FastifyReply,
  ) {
    this.requireJsonObject(body);
    this.requireNonEmptyString(body.model, 'model');
    this.validateResponsesInput(body.input);
    this.validateTools(body.tools, body.tool_choice);
    this.validateResponsesOptions(body);
    const request = this.buildResponsesChatRequest(body);
    const configuration = this.createResponsesConfiguration(body);

    try {
      const result = await this.proxyService.handleChatCompletions(
        request,
        'responses',
        configuration,
      );
      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result, 'responses');
        return;
      }

      const response = result as OpenAIChatResponse;
      res.status(HttpStatus.OK).send(this.toResponsesResponse(response, configuration));
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/responses', error);
    }
  }

  @Post('images/generations')
  async imageGenerations(
    @Body()
    body: {
      model?: string;
      prompt?: string;
      size?: string;
      quality?: string;
      n?: number | string;
      response_format?: string;
      output_format?: string;
      background?: string;
      moderation?: string;
      output_compression?: number | string;
      partial_images?: number | string;
      stream?: boolean | string;
      style?: string;
      input_fidelity?: string;
      user?: string;
    },
    @Res() res: FastifyReply,
  ) {
    this.requireJsonObject(body);
    this.requireNonEmptyString(body.prompt, 'prompt');
    if (!this.validateImageOptions(body, res)) {
      return;
    }
    const request: OpenAIChatRequest = {
      model: body.model ?? OPENAI_COMPATIBLE_DEFAULT_MODELS.images,
      messages: [
        {
          role: 'user',
          content: body.prompt ?? '',
        },
      ],
      stream: false,
      size: body.size,
      quality: body.quality,
    };

    await this.sendOpenAIImageGenerationResponse(
      request,
      body.prompt ?? '',
      '/v1/images/generations',
      res,
    );
  }

  @Post('images/edits')
  async imageEdits(
    @Body()
    body: {
      model?: string;
      prompt?: string;
      size?: string;
      quality?: string;
      n?: number | string;
      response_format?: string;
      output_format?: string;
      background?: string;
      moderation?: string;
      output_compression?: number | string;
      partial_images?: number | string;
      stream?: boolean | string;
      style?: string;
      input_fidelity?: string;
      user?: string;
      image?: InlineInput;
      reference_images?: InlineInput[];
      mask?: InlineInput;
    },
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    if (!this.isMultipartContentType(req)) {
      this.requireJsonObject(body);
      if (
        body.reference_images !== undefined &&
        body.reference_images !== null &&
        !Array.isArray(body.reference_images)
      ) {
        this.sendInvalidRequest(
          res,
          'reference_images must be an array.',
          'reference_images',
          'invalid_value',
        );
        return;
      }
    }
    const multipart = await this.readMultipartMediaInput(req, body, res);
    if (!multipart) {
      return;
    }
    const input = this.mergeMediaInput(body ?? {}, multipart);
    this.requireNonEmptyString(input.prompt, 'prompt');

    if (!this.validateImageOptions(input, res)) {
      return;
    }
    if (input.mask) {
      this.sendUnsupportedImageOption(
        res,
        'mask is not supported because this proxy cannot preserve mask semantics.',
        'mask',
      );
      return;
    }
    if (!this.validateImageInputCount(input.images, input.referenceImages, res)) {
      return;
    }
    if (
      !this.validateInlineImageInputs(input.images, 'image', res) ||
      !this.validateInlineImageInputs(input.referenceImages, 'reference_images', res)
    ) {
      return;
    }

    const imageParts = this.collectImageContentParts([...input.images, ...input.referenceImages]);
    if (imageParts.length === 0) {
      this.sendInvalidRequest(
        res,
        "Missing required 'image' file.",
        'image',
        'missing_required_parameter',
      );
      return;
    }

    const request: OpenAIChatRequest = {
      model: input.model ?? OPENAI_COMPATIBLE_DEFAULT_MODELS.images,
      messages: [
        {
          role: 'user',
          content:
            imageParts.length > 0
              ? [
                  {
                    type: 'text',
                    text:
                      input.prompt ?? 'Please edit this image based on the provided instruction.',
                  },
                  ...imageParts,
                ]
              : (input.prompt ?? 'Please edit this image based on the provided instruction.'),
        },
      ],
      stream: false,
      size: input.size,
      quality: input.quality,
    };

    await this.sendOpenAIImageGenerationResponse(
      request,
      input.prompt ?? '',
      '/v1/images/edits',
      res,
    );
  }

  @Post('audio/transcriptions')
  async audioTranscriptions(
    @Body()
    body: {
      model?: string;
      prompt?: string;
      language?: string;
      response_format?: string;
      temperature?: number | string;
      timestamp_granularities?: string | string[];
      file?: InlineInput;
      audio?: InlineInput;
    },
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    if (!this.isMultipartContentType(req)) {
      this.requireJsonObject(body);
    }
    const multipart = await this.readMultipartMediaInput(req, body, res);
    if (!multipart) {
      return;
    }
    const input = this.mergeMediaInput(body ?? {}, multipart);
    this.requireNonEmptyString(input.model, 'model');
    if (input.invalidTemperature) {
      this.sendInvalidRequest(
        res,
        'temperature must be a finite number between 0 and 1.',
        'temperature',
        'invalid_value',
      );
      return;
    }
    if (
      input.responseFormat &&
      input.responseFormat !== 'json' &&
      input.responseFormat !== 'text'
    ) {
      this.sendInvalidRequest(
        res,
        'Only response_format=json and response_format=text are supported by this proxy.',
        'response_format',
        'unsupported_option',
      );
      return;
    }
    if (input.timestampGranularities.length > 0) {
      this.sendInvalidRequest(
        res,
        'timestamp_granularities is not supported by this proxy.',
        'timestamp_granularities',
        'unsupported_option',
      );
      return;
    }

    const audioParam = input.file ? 'file' : 'audio';
    if (!this.validateInlineAudioInputs([input.file ?? input.audio], audioParam, res)) {
      return;
    }
    const inlineAudio = this.resolveInlineData(input.file ?? input.audio);
    if (!inlineAudio) {
      this.sendInvalidRequest(
        res,
        "Missing required 'file' input.",
        'file',
        'missing_required_parameter',
      );
      return;
    }

    try {
      const result = await this.proxyService.handleGeminiGenerateContent(input.model, {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: this.buildTranscriptionPrompt(input.prompt, input.language),
              },
              {
                inlineData: inlineAudio,
              },
            ],
          },
        ],
        generationConfig:
          input.temperature === undefined ? undefined : { temperature: input.temperature },
      });

      const text = result.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('')
        .trim();

      if (input.responseFormat === 'text') {
        res
          .type('text/plain; charset=utf-8')
          .status(HttpStatus.OK)
          .send(text ?? '');
        return;
      }

      res.status(HttpStatus.OK).send({ text: text ?? '' });
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/audio/transcriptions', error);
    }
  }

  private async respondOpenAIChatCompletions(body: OpenAIChatRequest, res: FastifyReply) {
    try {
      const result = await this.proxyService.handleChatCompletions(body);

      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      } else {
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/chat/completions', error);
    }
  }

  @Post('messages')
  async anthropicMessages(@Body() body: AnthropicChatRequest, @Res() res: FastifyReply) {
    this.validateAnthropicRequest(body);

    try {
      const result = await this.proxyService.handleAnthropicMessages(body);

      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result, 'anthropic');
        return;
      } else {
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      this.sendAnthropicErrorResponse(res, '/v1/messages', error);
    }
  }

  private normalizeCompletionPrompt(prompt: string | string[] | undefined): string {
    if (!prompt) {
      return '';
    }
    if (Array.isArray(prompt)) {
      return prompt.join('\n');
    }
    return prompt;
  }

  private buildOpenAIModelList(): Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }> {
    const config = getServerConfig();
    return getOpenAICompatibleModels(
      config?.custom_mapping ?? {},
      this.accountLeaseService?.getAllCollectedModels(),
    ).map((id) => ({
      id,
      object: 'model' as const,
      created: MODEL_LIST_CREATED_AT,
      owned_by: MODEL_LIST_OWNER,
    }));
  }

  @All('/*')
  unmatchedOpenAIRoute(@Req() request: FastifyRequest): never {
    throw new OpenAIProtocolException(
      `Route ${request.method}:${request.url} not found`,
      HttpStatus.NOT_FOUND,
    );
  }

  private validateChatRequest(body: OpenAIChatRequest): void {
    this.requireJsonObject(body);
    this.requireNonEmptyString(body.model, 'model');
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw this.invalidRequest('messages must be a non-empty array', 'messages');
    }
    const toolCallState: ToolCallValidationState = {
      declaredIds: new Set<string>(),
      consumedIds: new Set<string>(),
    };
    for (const [index, message] of body.messages.entries()) {
      if (
        !message ||
        !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
      ) {
        throw this.invalidRequest('messages contains an unsupported role', 'messages');
      }
      if (message.role !== 'assistant') {
        this.validateChatMessageContent(message, index);
      }
      this.validateChatToolMessage(message, index, toolCallState);
      if (message.role === 'assistant') {
        this.validateChatMessageContent(message, index);
      }
    }
    this.validateTools(body.tools, body.tool_choice);
    this.validateUnsupportedSamplingOptions(body);
    this.validateUnsupportedIdentityOptions(body);
    this.validateChatOnlyOptions(body);
    this.validatePositiveInteger('max_tokens', body.max_tokens);
    this.validatePositiveInteger('max_completion_tokens', body.max_completion_tokens);
    this.validateResponseFormat(body.response_format);
    this.normalizeStopSequences(body.stop);
  }

  private validatePositiveInteger(param: string, value: unknown): void {
    if (value === undefined) {
      return;
    }
    if (!isNumber(value) || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw this.invalidRequest(`${param} must be a positive integer`, param);
    }
  }

  private validateCompletionPrompt(prompt: string | string[] | undefined): void {
    const isValid =
      (isString(prompt) && !isEmpty(prompt.trim())) ||
      (Array.isArray(prompt) &&
        prompt.length > 0 &&
        prompt.every((item) => isString(item) && !isEmpty(item.trim())));
    if (!isValid) {
      throw this.invalidRequest('prompt must be a non-empty string or string array', 'prompt');
    }
    if (Array.isArray(prompt) && prompt.length > 1) {
      // Joining several prompts into one upstream call would silently collapse the
      // per-prompt choices the legacy contract promises.
      throw this.invalidRequest(
        'prompt arrays with more than one entry are not supported; send one prompt per request',
        'prompt',
      );
    }
  }

  /**
   * Rejects sampling options this gateway cannot honour before any account is
   * leased. Harmless defaults (n=1, zero penalties, empty logit_bias) pass through.
   */
  private validateUnsupportedSamplingOptions(body: {
    n?: number;
    seed?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    logit_bias?: Record<string, number>;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    stream_options?: OpenAIStreamOptions;
  }): void {
    if (!isNil(body.n) && body.n !== 1) {
      throw this.unsupportedParameter('n', 'only n=1 is supported');
    }
    if (!isNil(body.seed)) {
      throw this.unsupportedParameter('seed', 'deterministic seeding is not supported');
    }
    for (const param of ['presence_penalty', 'frequency_penalty'] as const) {
      const value = body[param];
      if (isNil(value)) {
        continue;
      }
      if (!isNumber(value) || !Number.isFinite(value)) {
        throw this.invalidRequest(`${param} must be a number`, param);
      }
      if (value !== 0) {
        throw this.unsupportedParameter(param, 'only the default value 0 is supported');
      }
    }
    if (!isNil(body.logit_bias)) {
      if (!isPlainObject(body.logit_bias)) {
        throw this.invalidRequest('logit_bias must be an object', 'logit_bias');
      }
      if (!isEmpty(body.logit_bias)) {
        throw this.unsupportedParameter('logit_bias', 'token biasing is not supported');
      }
    }
    this.validateNumericRange('temperature', body.temperature, 0, 2);
    this.validateNumericRange('top_p', body.top_p, 0, 1);
    this.validateStreamOptions(body.stream, body.stream_options);
  }

  private validateChatOnlyOptions(body: OpenAIChatRequest): void {
    if (!isNil(body.logprobs) && body.logprobs !== false) {
      throw this.unsupportedParameter('logprobs', 'log probabilities are not available');
    }
    if (!isNil(body.top_logprobs)) {
      throw this.unsupportedParameter('top_logprobs', 'log probabilities are not available');
    }
    this.validateUnhonoredOptions(body, [
      'service_tier',
      'store',
      'metadata',
      'modalities',
      'prediction',
      'parallel_tool_calls',
    ]);
  }

  private validateLegacyOnlyOptions(body: OpenAILegacyCompletionRequest): void {
    if (!isNil(body.logprobs)) {
      throw this.unsupportedParameter('logprobs', 'log probabilities are not available');
    }
    if (!isNil(body.suffix)) {
      throw this.unsupportedParameter('suffix', 'insertion completions are not supported');
    }
    if (!isNil(body.echo) && body.echo !== false) {
      throw this.unsupportedParameter('echo', 'prompt echo is not supported');
    }
    if (!isNil(body.best_of) && body.best_of !== 1) {
      throw this.unsupportedParameter('best_of', 'only best_of=1 is supported');
    }
  }

  private validateStreamOptions(
    stream: boolean | undefined,
    streamOptions: OpenAIStreamOptions | undefined,
  ): void {
    if (stream !== undefined && !isBoolean(stream)) {
      throw this.invalidRequest('stream must be a boolean', 'stream');
    }
    if (isNil(streamOptions)) {
      return;
    }
    if (!isPlainObject(streamOptions)) {
      throw this.invalidRequest('stream_options must be an object', 'stream_options');
    }
    if (!isNil(streamOptions.include_usage) && !isBoolean(streamOptions.include_usage)) {
      throw this.invalidRequest('stream_options.include_usage must be a boolean', 'stream_options');
    }
    if (stream !== true) {
      throw this.invalidRequest(
        'stream_options can only be set when stream is true',
        'stream_options',
      );
    }
  }

  private validateNumericRange(
    param: string,
    value: number | undefined,
    min: number,
    max: number,
  ): void {
    if (isNil(value)) {
      return;
    }
    if (!isNumber(value) || !Number.isFinite(value)) {
      throw this.invalidRequest(`${param} must be a number`, param);
    }
    if (value < min || value > max) {
      throw this.invalidRequest(`${param} must be between ${min} and ${max}`, param);
    }
  }

  private validateResponseFormat(format: OpenAIChatRequest['response_format']): void {
    if (isNil(format)) {
      return;
    }
    if (!isPlainObject(format)) {
      throw this.invalidRequest('response_format must be an object', 'response_format');
    }
    const type = format.type;
    if (type === 'text' || type === 'json_object') {
      return;
    }
    if (type === 'json_schema') {
      throw this.unsupportedParameter(
        'response_format',
        "response_format type 'json_schema' is not supported; use 'json_object'",
      );
    }
    // An object with no usable type is a malformed request. Treating it as text would
    // silently accept a shape the caller never asked for.
    if (!isString(type) || isEmpty(type.trim())) {
      throw this.invalidRequest(
        "response_format.type is required and must be one of 'text' or 'json_object'",
        'response_format',
      );
    }
    throw this.invalidRequest(`response_format type '${type}' is not supported`, 'response_format');
  }

  /**
   * `user` is accepted by the OpenAI schema but this gateway has no end-user channel to
   * forward it on. Rejecting up front beats silently dropping a field callers rely on for
   * abuse attribution, and it happens before any account is leased.
   */
  private validateUnsupportedIdentityOptions(body: { user?: unknown }): void {
    if (!isNil(body.user)) {
      throw this.unsupportedParameter('user', 'end-user identifiers are not forwarded upstream');
    }
  }

  /** Validates and normalizes `stop` into the Gemini stopSequences shape. */
  private normalizeStopSequences(stop: string | string[] | undefined): string[] | undefined {
    if (isNil(stop)) {
      return undefined;
    }

    const entries = isString(stop) ? [stop] : stop;
    if (!Array.isArray(entries)) {
      throw this.invalidRequest('stop must be a string or an array of strings', 'stop');
    }
    if (entries.length === 0) {
      return undefined;
    }
    if (entries.length > 4) {
      throw this.invalidRequest('stop supports at most 4 sequences', 'stop');
    }
    for (const entry of entries) {
      if (!isString(entry) || isEmpty(entry)) {
        throw this.invalidRequest('stop entries must be non-empty strings', 'stop');
      }
    }
    return [...entries];
  }

  private unsupportedParameter(param: string, reason: string): OpenAIProtocolException {
    return new OpenAIProtocolException(
      `${param} is not supported by this gateway: ${reason}`,
      HttpStatus.BAD_REQUEST,
      { param, code: 'unsupported_parameter' },
    );
  }

  private validateResponsesInput(input: unknown): void {
    if (isString(input) && !isEmpty(input.trim())) {
      return;
    }
    if (Array.isArray(input) && input.length > 0) {
      for (const [index, item] of input.entries()) {
        this.validateResponsesInputItem(item, index);
      }
      this.validateResponsesToolOutputReferences(input);
      return;
    }
    throw this.invalidRequest('input must be non-empty', 'input');
  }

  private validateChatToolMessage(
    message: OpenAIChatRequest['messages'][number],
    index: number,
    toolCallState: ToolCallValidationState,
  ): void {
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant') {
        throw this.invalidRequest(
          'tool_calls is only supported on assistant messages',
          `messages[${index}].tool_calls`,
        );
      }
      if (!Array.isArray(message.tool_calls)) {
        throw this.invalidRequest('tool_calls must be an array', `messages[${index}].tool_calls`);
      }

      for (const [toolCallIndex, toolCall] of message.tool_calls.entries()) {
        const param = `messages[${index}].tool_calls[${toolCallIndex}]`;
        const toolCallRecord = this.toRecord(toolCall);
        if (!toolCallRecord) {
          throw this.invalidRequest('tool_calls entries must be objects', param);
        }
        if (toolCallRecord.type !== 'function') {
          throw this.invalidRequest('tool_calls entries must have type function', `${param}.type`);
        }
        this.requireNonEmptyString(toolCallRecord.id, `${param}.id`);
        const functionRecord = this.toRecord(toolCallRecord.function);
        if (!functionRecord) {
          throw this.invalidRequest(
            'tool_calls entries must include a function object',
            `${param}.function`,
          );
        }
        this.requireNonEmptyString(functionRecord.name, `${param}.function.name`);
        if (!isString(functionRecord.arguments)) {
          throw this.invalidRequest(
            'tool_calls function arguments must be a string',
            `${param}.function.arguments`,
          );
        }
        this.declareToolCall(toolCallState, toolCallRecord.id, `${param}.id`, 'tool_calls ids');
      }
    }

    if (message.role === 'tool') {
      this.requireNonEmptyString(message.tool_call_id, `messages[${index}].tool_call_id`);
      this.consumeToolCall(
        toolCallState,
        message.tool_call_id,
        `messages[${index}].tool_call_id`,
        'tool_call_id must reference an earlier assistant tool_calls id',
        'tool_call_id may only be used once',
      );
    }
  }

  private validateResponsesToolOutputReferences(input: unknown[]): void {
    const toolCallState: ToolCallValidationState = {
      declaredIds: new Set<string>(),
      consumedIds: new Set<string>(),
    };
    for (const [index, item] of input.entries()) {
      const inputItem = this.toRecord(item);
      const type = inputItem ? this.responsesInputItemType(inputItem) : null;
      if (
        inputItem &&
        (type === 'function_call' || type === 'local_shell_call' || type === 'web_search_call')
      ) {
        const callId = this.responsesCallId(inputItem);
        const callIdParam = Object.hasOwn(inputItem, 'call_id') ? 'call_id' : 'id';
        this.declareToolCall(
          toolCallState,
          callId,
          `input[${index}].${callIdParam}`,
          'tool call ids',
        );
      }
      if (inputItem && type === 'function_call_output') {
        this.consumeToolCall(
          toolCallState,
          this.responsesCallId(inputItem),
          `input[${index}].call_id`,
          'function_call_output must reference an earlier function_call in input',
          'function_call_output call_id may only be used once',
        );
      }
    }
  }

  private declareToolCall(
    toolCallState: ToolCallValidationState,
    callId: string,
    param: string,
    duplicateMessage: string,
  ): void {
    if (toolCallState.declaredIds.has(callId)) {
      throw this.invalidRequest(`${duplicateMessage} must be unique`, param);
    }
    toolCallState.declaredIds.add(callId);
  }

  private consumeToolCall(
    toolCallState: ToolCallValidationState,
    callId: string,
    param: string,
    missingMessage: string,
    duplicateMessage: string,
  ): void {
    if (!toolCallState.declaredIds.has(callId)) {
      throw this.invalidRequest(missingMessage, param);
    }
    if (toolCallState.consumedIds.has(callId)) {
      throw this.invalidRequest(duplicateMessage, param);
    }
    toolCallState.consumedIds.add(callId);
  }

  private validateResponsesOptions(body: OpenAIResponsesRequest): void {
    this.validatePositiveInteger('max_output_tokens', body.max_output_tokens);
    this.validateNumericRange('temperature', body.temperature, 0, 2);
    this.validateNumericRange('top_p', body.top_p, 0, 1);
    this.validateStreamOptions(body.stream, undefined);
    this.validateResponsesMetadata(body.metadata);
    this.validateUnhonoredOptions(body, [
      'previous_response_id',
      'text',
      'background',
      'parallel_tool_calls',
      'store',
      'reasoning',
      'truncation',
      'max_tool_calls',
    ]);
  }

  private validateResponsesMetadata(metadata: unknown): void {
    this.responsesMetadata(metadata);
  }

  private responsesMetadata(metadata: unknown): Record<string, string> {
    if (metadata === undefined) {
      return {};
    }
    if (typeof metadata !== 'object' || metadata === null || !isPlainObject(metadata)) {
      throw this.invalidRequest('metadata must be an object with string values', 'metadata');
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (!isString(value)) {
        throw this.invalidRequest('metadata must be an object with string values', 'metadata');
      }
      result[key] = value;
    }
    return result;
  }

  private validateUnhonoredOptions(body: object, params: string[]): void {
    for (const param of params) {
      if (Object.hasOwn(body, param)) {
        throw this.unsupportedParameter(param, 'this option is not forwarded upstream');
      }
    }
  }

  private validateResponsesInputItem(item: unknown, index: number): void {
    const inputItem = this.toRecord(item);
    if (!inputItem) {
      throw this.invalidRequest('input items must be objects', 'input');
    }

    const type = this.responsesInputItemType(inputItem);
    if (type === 'reasoning') {
      // Replayed reasoning is model-private context and cannot be represented upstream.
      return;
    }
    if (type === 'message') {
      this.validateResponsesMessage(inputItem);
      return;
    }
    if (type === 'function_call') {
      this.requireResponsesCallId(inputItem);
      this.requireNonEmptyString(inputItem.name, 'input.name');
      this.requireResponsesFunctionCallArguments(inputItem.arguments);
      return;
    }
    if (type === 'custom_tool_call_output') {
      throw this.unsupportedParameter(
        `input[${index}].type`,
        'custom_tool_call_output requires unsupported custom tools',
      );
    }
    if (type === 'function_call_output') {
      this.requireResponsesCallId(inputItem);
      this.validateResponsesOutput(inputItem.output);
      return;
    }
    if (type === 'local_shell_call') {
      this.requireResponsesCallId(inputItem);
      const action = this.toRecord(inputItem.action);
      const exec = this.toRecord(action?.exec);
      this.requireNonEmptyString(exec?.command, 'input.action.exec.command');
      return;
    }
    if (type === 'web_search_call') {
      this.requireResponsesCallId(inputItem);
      const action = this.toRecord(inputItem.action);
      this.requireNonEmptyString(action?.query, 'input.action.query');
      return;
    }
    throw this.invalidRequest('input contains an unsupported item type', 'input');
  }

  private responsesInputItemType(item: Record<string, unknown>): string | null {
    if (Object.hasOwn(item, 'type')) {
      return this.asString(item.type);
    }
    return item.role !== undefined && item.content !== undefined ? 'message' : null;
  }

  private requireResponsesFunctionCallArguments(value: unknown): string {
    if (!isString(value)) {
      throw this.invalidRequest('function_call arguments must be a string', 'input.arguments');
    }

    try {
      if (!this.toRecord(JSON.parse(value))) {
        throw this.invalidRequest(
          'function_call arguments must be a JSON object',
          'input.arguments',
        );
      }
    } catch (error) {
      if (error instanceof OpenAIProtocolException) {
        throw error;
      }
      throw this.invalidRequest('function_call arguments must be valid JSON', 'input.arguments');
    }

    return value;
  }

  private validateResponsesMessage(item: Record<string, unknown>): void {
    const role = this.asString(item.role);
    if (!role || !['user', 'assistant', 'system', 'developer'].includes(role)) {
      throw this.invalidRequest('message role is invalid', 'input.role');
    }
    if (isString(item.content)) {
      return;
    }
    if (!Array.isArray(item.content) || item.content.length === 0) {
      throw this.invalidRequest(
        'message content must be a string or a non-empty array',
        'input.content',
      );
    }
    for (const blockValue of item.content) {
      const block = this.toRecord(blockValue);
      const blockType = this.asString(block?.type);
      if (!block || !blockType) {
        throw this.invalidRequest('message content contains an invalid block', 'input.content');
      }
      if (blockType === 'input_text' || blockType === 'text' || blockType === 'output_text') {
        if (!isString(block.text)) {
          throw this.invalidRequest(
            'text content blocks require a string text value',
            'input.content',
          );
        }
        continue;
      }
      if (blockType === 'input_image' || blockType === 'image_url') {
        const imageUrl = this.resolveImageUrl(block);
        if (!imageUrl) {
          throw this.invalidRequest('image content blocks require an image URL', 'input.content');
        }
        this.validateImageDataUrl(imageUrl, 'input.content');
        continue;
      }
      throw this.invalidRequest(
        'message content contains an unsupported block type',
        'input.content',
      );
    }
  }

  private requireResponsesCallId(item: Record<string, unknown>): void {
    this.responsesCallId(item);
  }

  private responsesCallId(item: Record<string, unknown>): string {
    // Some existing clients use the legacy item id as the Responses call id.
    const callId = this.asString(item.call_id) ?? this.asString(item.id);
    this.requireNonEmptyString(callId, 'input.call_id');
    return callId;
  }

  private validateResponsesOutput(output: unknown): void {
    if (isString(output)) {
      return;
    }
    const outputRecord = this.toRecord(output);
    if (isString(outputRecord?.content)) {
      return;
    }
    throw this.invalidRequest(
      'tool call output must be a string or an object with string content',
      'input.output',
    );
  }

  private validateTools(
    tools: OpenAIChatRequest['tools'] | undefined,
    toolChoice: OpenAIChatRequest['tool_choice'] | undefined,
  ): void {
    if (
      tools &&
      (!Array.isArray(tools) ||
        tools.some(
          (tool) =>
            !isPlainObject(tool) || tool.type !== 'function' || !isString(tool.function?.name),
        ))
    ) {
      throw this.invalidRequest('tools must contain function declarations with names', 'tools');
    }
    if (
      toolChoice &&
      toolChoice !== 'auto' &&
      toolChoice !== 'none' &&
      toolChoice !== 'required' &&
      (!isPlainObject(toolChoice) ||
        toolChoice.type !== 'function' ||
        !isPlainObject(toolChoice.function) ||
        !isString(toolChoice.function.name) ||
        isEmpty(toolChoice.function.name.trim()))
    ) {
      throw this.invalidRequest('tool_choice is invalid', 'tool_choice');
    }
  }

  private validateChatMessageContent(
    message: OpenAIChatRequest['messages'][number],
    index: number,
  ): void {
    const { content } = message;
    if (content === undefined || content === null) {
      if (
        message.role === 'assistant' &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0
      ) {
        return;
      }
      throw this.invalidRequest('messages content is required', `messages[${index}].content`);
    }
    if (isString(content)) {
      return;
    }
    if (!Array.isArray(content)) {
      throw this.invalidRequest('messages contains unsupported content', 'messages');
    }
    for (const part of content) {
      if (!isPlainObject(part)) {
        throw this.invalidRequest('messages contains unsupported content', 'messages');
      }
      if (part.type === 'text' && isString(part.text)) {
        continue;
      }
      if (
        part.type === 'image_url' &&
        isString(part.image_url?.url) &&
        !isEmpty(part.image_url.url.trim())
      ) {
        this.validateImageDataUrl(part.image_url.url, 'messages');
        continue;
      }
      throw this.invalidRequest('messages contains unsupported content', 'messages');
    }
  }

  private validateAnthropicRequest(body: AnthropicChatRequest): void {
    this.requireJsonObject(body);
    this.requireNonEmptyString(body.model, 'model');
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw this.invalidRequest('messages must be a non-empty array', 'messages');
    }
    for (const message of body.messages) {
      if (
        !isPlainObject(message) ||
        !isString(message.role) ||
        !['user', 'assistant'].includes(message.role)
      ) {
        throw this.invalidRequest('messages contains an unsupported role', 'messages');
      }
      this.validateAnthropicContent(message.content);
    }
    this.validateAnthropicTools(body.tools);
    this.validateAnthropicSystem(body.system);
  }

  private validateAnthropicContent(content: unknown): void {
    if (isString(content)) {
      return;
    }
    if (!Array.isArray(content) || content.length === 0) {
      throw this.invalidRequest('messages contains unsupported content', 'messages');
    }
    for (const block of content) {
      if (!isPlainObject(block) || !isString(block.type)) {
        throw this.invalidRequest('messages contains unsupported content', 'messages');
      }
      if (block.type === 'text' && isString(block.text)) {
        continue;
      }
      if (block.type === 'thinking' && isString(block.thinking)) {
        continue;
      }
      if (
        block.type === 'image' &&
        isPlainObject(block.source) &&
        block.source.type === 'base64' &&
        isString(block.source.media_type) &&
        isString(block.source.data) &&
        this.isSupportedAnthropicImageMimeType(block.source.media_type) &&
        !this.hasInvalidBase64Data(block.source.data)
      ) {
        continue;
      }
      if (
        block.type === 'tool_use' &&
        isString(block.id) &&
        isString(block.name) &&
        isPlainObject(block.input)
      ) {
        continue;
      }
      if (block.type === 'tool_result' && isString(block.tool_use_id)) {
        if (
          block.content === undefined ||
          (Array.isArray(block.content) && block.content.length === 0)
        ) {
          continue;
        }
        this.validateAnthropicContent(block.content);
        continue;
      }
      if (block.type === 'redacted_thinking' && isString(block.data)) {
        continue;
      }
      throw this.invalidRequest('messages contains unsupported content', 'messages');
    }
  }

  private validateAnthropicTools(tools: AnthropicChatRequest['tools']): void {
    if (tools === undefined) {
      return;
    }
    if (
      !Array.isArray(tools) ||
      tools.some(
        (tool) =>
          !isPlainObject(tool) ||
          !isString(tool.name) ||
          isEmpty(tool.name.trim()) ||
          (tool.description !== undefined && !isString(tool.description)) ||
          (tool.input_schema !== undefined && !isPlainObject(tool.input_schema)) ||
          (tool.type !== undefined && !isString(tool.type)),
      )
    ) {
      throw this.invalidRequest('tools must contain named tool declarations', 'tools');
    }
  }

  private validateAnthropicSystem(system: AnthropicChatRequest['system']): void {
    if (system === undefined || isString(system)) {
      return;
    }
    if (
      !Array.isArray(system) ||
      system.some(
        (block) => !isPlainObject(block) || block.type !== 'text' || !isString(block.text),
      )
    ) {
      throw this.invalidRequest('system must be a string or text block array', 'system');
    }
  }

  private validateImageDataUrl(url: string, param: string): void {
    if (!/^data:/i.test(url)) {
      throw this.unsupportedParameter(
        param,
        'remote image URLs are not supported by this gateway; use a data URL',
      );
    }

    if (!parseImageDataUrl(url)) {
      throw this.invalidRequest(
        `${param} must contain a valid base64 image data URL`,
        param,
        'invalid_value',
      );
    }
  }

  private requireNonEmptyString(value: unknown, param: string): asserts value is string {
    if (!isString(value) || isEmpty(value.trim())) {
      throw this.invalidRequest(`${param} is required`, param);
    }
  }

  private requireJsonObject(value: unknown): asserts value is object {
    if (!isPlainObject(value)) {
      throw this.invalidRequest('request body must be a JSON object');
    }
  }

  private invalidRequest(message: string, param?: string, code?: string): OpenAIProtocolException {
    return new OpenAIProtocolException(message, HttpStatus.BAD_REQUEST, { param, code });
  }

  private validateImageOptions(input: ImageOptionInput, res: FastifyReply): boolean {
    const responseFormat = input.response_format ?? input.responseFormat;
    const outputFormat = input.output_format ?? input.outputFormat;
    const outputCompression = input.output_compression ?? input.outputCompression;
    const partialImages = input.partial_images ?? input.partialImages;
    const inputFidelity = input.input_fidelity ?? input.inputFidelity;

    if (input.model !== undefined) {
      try {
        this.requireNonEmptyString(input.model, 'model');
      } catch (error) {
        sendOpenAIProtocolError(res, error);
        return false;
      }
    }

    if (input.n !== undefined && input.n !== 1 && input.n !== '1') {
      this.sendUnsupportedImageOption(res, 'Only n=1 is supported by this proxy.', 'n');
      return false;
    }
    if (responseFormat !== undefined && responseFormat !== 'b64_json') {
      this.sendUnsupportedImageOption(
        res,
        'Only response_format=b64_json is supported by this proxy.',
        'response_format',
      );
      return false;
    }
    if (outputFormat !== undefined && outputFormat !== 'png') {
      this.sendUnsupportedImageOption(
        res,
        'Only output_format=png is supported by this proxy.',
        'output_format',
      );
      return false;
    }
    if (input.size !== undefined && input.size !== 'auto' && input.size !== '1024x1024') {
      this.sendUnsupportedImageOption(
        res,
        'Only size=auto and size=1024x1024 are supported by this proxy.',
        'size',
      );
      return false;
    }
    if (input.quality !== undefined && input.quality !== 'auto') {
      this.sendUnsupportedImageOption(
        res,
        'Only quality=auto is supported by this proxy.',
        'quality',
      );
      return false;
    }
    if (input.background !== undefined && input.background !== 'auto') {
      this.sendUnsupportedImageOption(
        res,
        'Only background=auto is supported by this proxy.',
        'background',
      );
      return false;
    }
    if (input.moderation !== undefined && input.moderation !== 'auto') {
      this.sendUnsupportedImageOption(
        res,
        'Only moderation=auto is supported by this proxy.',
        'moderation',
      );
      return false;
    }
    if (outputCompression !== undefined) {
      this.sendUnsupportedImageOption(
        res,
        'output_compression is not supported by this proxy.',
        'output_compression',
      );
      return false;
    }
    if (partialImages !== undefined && partialImages !== 0 && partialImages !== '0') {
      this.sendUnsupportedImageOption(
        res,
        'Only partial_images=0 is supported by this proxy.',
        'partial_images',
      );
      return false;
    }
    if (input.stream !== undefined && input.stream !== false && input.stream !== 'false') {
      if (input.stream === true || input.stream === 'true') {
        this.sendUnsupportedImageOption(
          res,
          'Streaming image generation is not supported by this endpoint.',
          'stream',
        );
        return false;
      }
      this.sendInvalidRequest(res, 'stream must be a boolean.', 'stream', 'invalid_value');
      return false;
    }
    if (input.style !== undefined) {
      this.sendUnsupportedImageOption(res, 'style is not supported by this proxy.', 'style');
      return false;
    }
    if (inputFidelity !== undefined) {
      this.sendUnsupportedImageOption(
        res,
        'input_fidelity is not supported by this proxy.',
        'input_fidelity',
      );
      return false;
    }
    if (input.user !== undefined) {
      this.sendUnsupportedImageOption(
        res,
        'user is not supported because this proxy cannot preserve end-user identifier semantics.',
        'user',
      );
      return false;
    }

    return true;
  }

  private sendUnsupportedImageOption(res: FastifyReply, message: string, param: string): void {
    this.sendInvalidRequest(res, message, param, 'unsupported_parameter');
  }

  private toLegacyTextCompletionsResponse(response: OpenAIChatResponse): Record<string, unknown> {
    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    const text = isString(content) ? content : '';

    const payload: Record<string, unknown> = {
      id: response.id,
      object: 'text_completion',
      created: response.created,
      model: response.model,
      choices: [
        {
          text,
          index: choice?.index ?? 0,
          logprobs: null,
          finish_reason: choice?.finish_reason ?? null,
        },
      ],
    };
    // Omit rather than zero-fill: the legacy surface has no way to say "unknown" other
    // than leaving the key out.
    if (response.usage) {
      payload.usage = response.usage;
    }
    return payload;
  }

  private toResponsesResponse(
    response: OpenAIChatResponse,
    configuration: OpenAIResponsesConfiguration,
  ): Record<string, unknown> {
    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    const text = isString(content) ? content : '';
    const finishReason = choice?.finish_reason?.toLowerCase();
    const incompleteReason =
      finishReason === 'length'
        ? 'max_output_tokens'
        : finishReason === 'content_filter' ||
            finishReason === 'safety' ||
            finishReason === 'recitation'
          ? 'content_filter'
          : null;
    const incomplete = incompleteReason !== null;
    const output: Array<Record<string, unknown>> = [];
    const allocatedOutputIds = new Set<string>();

    if (text) {
      output.push({
        id: this.allocateResponsesOutputId('msg', response.id, allocatedOutputIds),
        type: 'message',
        status: incomplete ? 'incomplete' : 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text,
            annotations: [],
          },
        ],
      });
    }

    for (const toolCall of choice?.message?.tool_calls ?? []) {
      output.push({
        id: this.allocateResponsesOutputId('fc', toolCall.id, allocatedOutputIds),
        type: 'function_call',
        status: 'completed',
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }

    return {
      id: this.normalizeResponsesId('resp', response.id),
      object: 'response',
      created_at: response.created,
      status: incomplete ? 'incomplete' : 'completed',
      error: null,
      incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
      model: response.model,
      output,
      ...configuration,
      metadata: { ...configuration.metadata },
      // The Responses contract types usage as nullable, so an unknown usage is reported
      // as null instead of a fabricated zero breakdown.
      usage: response.usage
        ? {
            input_tokens: response.usage.prompt_tokens,
            input_tokens_details: {
              cached_tokens: 0,
            },
            output_tokens: response.usage.completion_tokens,
            output_tokens_details: {
              reasoning_tokens: response.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            },
            total_tokens: response.usage.total_tokens,
          }
        : null,
    };
  }

  private normalizeResponsesId(
    prefix: 'resp' | 'msg' | 'fc',
    sourceId: string | undefined,
  ): string {
    const normalizedSource = (sourceId ?? 'generated')
      .replace(/^(?:chatcmpl|resp|msg|fc|call)[_-]?/i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${prefix}_${normalizedSource || 'generated'}`;
  }

  private allocateResponsesOutputId(
    prefix: 'msg' | 'fc',
    sourceId: string | undefined,
    allocatedIds: Set<string>,
  ): string {
    const normalizedId = this.normalizeResponsesId(prefix, sourceId);
    if (!allocatedIds.has(normalizedId)) {
      allocatedIds.add(normalizedId);
      return normalizedId;
    }

    let suffix = 2;
    let allocatedId = `${normalizedId}_${suffix}`;
    while (allocatedIds.has(allocatedId)) {
      suffix += 1;
      allocatedId = `${normalizedId}_${suffix}`;
    }
    allocatedIds.add(allocatedId);
    return allocatedId;
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

  private buildResponsesChatRequest(body: {
    model?: string;
    instructions?: string;
    input?: unknown;
    tools?: OpenAIChatRequest['tools'];
    tool_choice?: OpenAIChatRequest['tool_choice'];
    max_output_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
  }): OpenAIChatRequest {
    const messages: OpenAIChatRequest['messages'] = [];
    if (isString(body.instructions) && !isEmpty(body.instructions.trim())) {
      messages.push({
        role: 'system',
        content: body.instructions,
      });
    }

    const callIdToToolName = new Map<string, string>();
    const inputItems = Array.isArray(body.input) ? body.input : null;

    if (inputItems) {
      for (const item of inputItems) {
        const itemObj = this.toRecord(item);
        if (!itemObj) {
          continue;
        }

        const type = this.responsesInputItemType(itemObj);
        if (!type) {
          continue;
        }
        if (type === 'reasoning') {
          continue;
        }

        if (type === 'function_call' || type === 'local_shell_call' || type === 'web_search_call') {
          const callId =
            this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? `call_${Date.now()}`;
          const toolName =
            type === 'local_shell_call'
              ? 'shell'
              : type === 'web_search_call'
                ? 'builtin_web_search'
                : (this.asString(itemObj.name) ?? 'unknown');
          callIdToToolName.set(callId, toolName);
        }
      }

      let previousWasFunctionCall = false;
      for (const item of inputItems) {
        const itemObj = this.toRecord(item);
        if (!itemObj) {
          previousWasFunctionCall = false;
          continue;
        }

        const type = this.responsesInputItemType(itemObj);
        if (!type) {
          previousWasFunctionCall = false;
          continue;
        }
        if (type === 'reasoning') {
          continue;
        }

        if (type === 'message') {
          const role = this.asString(itemObj.role) ?? 'user';
          const content = this.normalizeResponsesMessageContent(itemObj.content);
          messages.push({ role, content });
          previousWasFunctionCall = false;
          continue;
        }

        if (type === 'function_call' || type === 'local_shell_call' || type === 'web_search_call') {
          const callId =
            this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? `call_${Date.now()}`;
          const toolName = callIdToToolName.get(callId) ?? 'unknown';
          const argumentsValue =
            type === 'function_call'
              ? this.requireResponsesFunctionCallArguments(itemObj.arguments)
              : JSON.stringify(this.resolveToolArguments(type, itemObj));
          const toolCall = {
            id: callId,
            type: 'function' as const,
            function: {
              name: toolName,
              arguments: argumentsValue,
            },
          };
          const previousMessage = messages.at(-1);
          if (previousWasFunctionCall && previousMessage?.role === 'assistant') {
            previousMessage.tool_calls?.push(toolCall);
          } else {
            messages.push({
              role: 'assistant',
              content: '',
              tool_calls: [toolCall],
            });
          }
          previousWasFunctionCall = true;
          continue;
        }

        if (type === 'function_call_output' || type === 'custom_tool_call_output') {
          const callId = this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? 'unknown';
          const output = itemObj.output;
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            name: callIdToToolName.get(callId) ?? 'unknown',
            content: this.normalizeResponsesOutput(output),
          });
          previousWasFunctionCall = false;
          continue;
        }

        previousWasFunctionCall = false;
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
      model: body.model ?? OPENAI_COMPATIBLE_DEFAULT_MODELS.responses,
      messages,
      tools: body.tools,
      tool_choice: body.tool_choice,
      max_tokens: body.max_output_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: body.stream,
    };
  }

  private createResponsesConfiguration(body: OpenAIResponsesRequest): OpenAIResponsesConfiguration {
    return {
      instructions:
        isString(body.instructions) && !isEmpty(body.instructions.trim())
          ? body.instructions
          : null,
      max_output_tokens: body.max_output_tokens ?? null,
      metadata: this.responsesMetadata(body.metadata),
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: null,
      store: false,
      temperature: body.temperature ?? 1,
      text: { format: { type: 'text' } },
      tool_choice: body.tool_choice ?? 'auto',
      tools: body.tools ? [...body.tools] : [],
      top_p: body.top_p ?? 1,
      truncation: 'disabled',
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

  private async readMultipartMediaInput(
    req: FastifyRequest,
    body: unknown,
    res: FastifyReply,
  ): Promise<MultipartMediaInput | null> {
    if (this.isMultipartContentType(req) && !this.hasMultipartBoundary(req)) {
      this.sendInvalidRequest(
        res,
        'Invalid boundary for multipart/form-data request.',
        undefined,
        'multipart_parse_error',
      );
      return null;
    }
    if (!this.hasMultipartBoundary(req)) {
      return { fields: {}, files: {} };
    }

    try {
      const attachedInput = await this.readAttachedMultipartMediaInput(body);
      if (attachedInput) {
        return attachedInput;
      }

      const request = req as FastifyRequest & {
        parts?: () => AsyncIterableIterator<
          MultipartFile | { type: 'field'; fieldname: string; value: string }
        >;
      };
      if (!isFunction(request.parts)) {
        return { fields: {}, files: {} };
      }

      const fields: Record<string, string | string[]> = {};
      const files: Record<string, InlineInput[]> = {};
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const data = (await part.toBuffer()).toString('base64');
          const entries = files[part.fieldname] ?? [];
          entries.push({ data, mimeType: part.mimetype || 'application/octet-stream' });
          files[part.fieldname] = entries;
          continue;
        }

        const fieldValue = isString(part.value) ? part.value : String(part.value ?? '');
        const existing = fields[part.fieldname];
        fields[part.fieldname] = existing
          ? Array.isArray(existing)
            ? [...existing, fieldValue]
            : [existing, fieldValue]
          : fieldValue;
      }
      return { fields, files };
    } catch (error) {
      if (isMultipartParserOrLimitError(error)) {
        this.sendInvalidRequest(res, error.message, undefined, 'multipart_parse_error');
        return null;
      }

      throw error;
    }
  }

  private async readAttachedMultipartMediaInput(
    body: unknown,
  ): Promise<MultipartMediaInput | null> {
    const entries = this.toRecord(body);
    if (!entries) {
      return null;
    }

    const fields: Record<string, string | string[]> = {};
    const files: Record<string, InlineInput[]> = {};
    let foundMultipartPart = false;
    for (const [fieldname, value] of Object.entries(entries)) {
      const values = Array.isArray(value) ? value : [value];
      for (const part of values) {
        const partRecord = this.toRecord(part);
        if (!partRecord || !isString(partRecord.type)) {
          continue;
        }
        foundMultipartPart = true;
        if (partRecord.type === 'file' && isFunction(partRecord.toBuffer)) {
          const data = (await (partRecord.toBuffer as () => Promise<Buffer>)()).toString('base64');
          const mimeType = this.asString(partRecord.mimetype) ?? 'application/octet-stream';
          files[fieldname] = [...(files[fieldname] ?? []), { data, mimeType }];
          continue;
        }
        if (partRecord.type === 'field' && isString(partRecord.value)) {
          const fieldValue = partRecord.value;
          const existing = fields[fieldname];
          fields[fieldname] = existing
            ? Array.isArray(existing)
              ? [...existing, fieldValue]
              : [existing, fieldValue]
            : fieldValue;
        }
      }
    }

    return foundMultipartPart ? { fields, files } : null;
  }

  private mergeMediaInput(
    body: {
      model?: string;
      prompt?: string;
      size?: string;
      quality?: string;
      n?: number | string;
      response_format?: string;
      output_format?: string;
      background?: string;
      moderation?: string;
      output_compression?: number | string;
      partial_images?: number | string;
      stream?: boolean | string;
      style?: string;
      input_fidelity?: string;
      user?: string;
      language?: string;
      temperature?: number | string;
      timestamp_granularities?: string | string[];
      image?: InlineInput;
      reference_images?: InlineInput[];
      mask?: InlineInput;
      file?: InlineInput;
      audio?: InlineInput;
    },
    multipart: MultipartMediaInput,
  ): MediaInput {
    const field = (name: string): string | undefined => {
      const value = multipart.fields[name];
      return Array.isArray(value) ? value.at(-1) : value;
    };
    const file = (name: string): InlineInput | undefined => multipart.files[name]?.[0];
    const files = (...names: string[]): InlineInput[] =>
      names.flatMap((name) => multipart.files[name] ?? []);
    const temperatureValue = field('temperature') ?? body.temperature;
    const parsedTemperature =
      typeof temperatureValue === 'number'
        ? temperatureValue
        : isString(temperatureValue) && temperatureValue.trim() !== ''
          ? Number(temperatureValue)
          : Number.NaN;
    const timestampGranularities = [
      ...this.asStringArray(body.timestamp_granularities),
      ...this.asStringArray(multipart.fields.timestamp_granularities),
      ...this.asStringArray(multipart.fields['timestamp_granularities[]']),
    ];

    return {
      model: field('model') ?? body.model,
      prompt: field('prompt') ?? body.prompt,
      size: field('size') ?? body.size,
      quality: field('quality') ?? body.quality,
      n: field('n') ?? (body.n === undefined ? undefined : String(body.n)),
      responseFormat: field('response_format') ?? body.response_format,
      outputFormat: field('output_format') ?? body.output_format,
      background: field('background') ?? body.background,
      moderation: field('moderation') ?? body.moderation,
      outputCompression:
        field('output_compression') ??
        (body.output_compression === undefined ? undefined : String(body.output_compression)),
      partialImages:
        field('partial_images') ??
        (body.partial_images === undefined ? undefined : String(body.partial_images)),
      stream: field('stream') ?? (body.stream === undefined ? undefined : String(body.stream)),
      style: field('style') ?? body.style,
      inputFidelity: field('input_fidelity') ?? body.input_fidelity,
      user: field('user') ?? body.user,
      language: field('language') ?? body.language,
      temperature: Number.isFinite(parsedTemperature) ? parsedTemperature : undefined,
      invalidTemperature:
        temperatureValue !== undefined &&
        (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 1),
      timestampGranularities,
      images:
        files('image', 'image[]').length > 0
          ? files('image', 'image[]')
          : body.image
            ? [body.image]
            : [],
      referenceImages:
        files('reference_images', 'reference_images[]').length > 0
          ? files('reference_images', 'reference_images[]')
          : (body.reference_images ?? []),
      mask: file('mask') ?? body.mask,
      file: file('file') ?? body.file,
      audio: file('audio') ?? body.audio,
    };
  }

  private asStringArray(value: string | string[] | undefined): string[] {
    if (Array.isArray(value)) {
      return value;
    }
    return value ? [value] : [];
  }

  private buildTranscriptionPrompt(prompt?: string, language?: string): string {
    const instruction = prompt ?? 'Please transcribe the provided speech audio accurately.';
    return language ? `${instruction} The expected language is ${language}.` : instruction;
  }

  private sendInvalidRequest(
    res: FastifyReply,
    message: string,
    param: string | undefined,
    code: string,
  ): void {
    res.status(HttpStatus.BAD_REQUEST).send({
      error: {
        message,
        type: 'invalid_request_error',
        param: param ?? null,
        code,
      },
    });
  }

  private collectImageContentParts(entries: Array<InlineInput | undefined>): OpenAIContentPart[] {
    const parts: OpenAIContentPart[] = [];
    for (const entry of entries) {
      const inlineData = this.resolveInlineData(entry, 'image/png');
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

  private validateInlineAudioInputs(
    inputs: Array<InlineInput | undefined>,
    param: string,
    res: FastifyReply,
  ): boolean {
    if (inputs.every((input) => this.isValidInlineMediaInput(input, 'audio'))) {
      return true;
    }

    this.sendInvalidRequest(
      res,
      param + ' must contain valid base64 data.',
      param,
      'invalid_value',
    );
    return false;
  }

  private validateInlineImageInputs(
    inputs: Array<InlineInput | undefined>,
    param: string,
    res: FastifyReply,
  ): boolean {
    if (inputs.every((input) => this.isValidInlineMediaInput(input, 'image'))) {
      return true;
    }

    this.sendInvalidRequest(
      res,
      param + ' must contain valid base64 data.',
      param,
      'invalid_value',
    );
    return false;
  }

  private hasInvalidBase64Data(input: InlineInput | undefined): boolean {
    if (!input) {
      return false;
    }

    const value = isString(input) ? input : input.data;
    if (!isString(value)) {
      return false;
    }

    const dataUri = value.match(/^data:[^;]+;base64,(?<data>.*)$/i);
    if (/^data:/i.test(value) && !dataUri) {
      return true;
    }

    const data = (dataUri?.groups?.data ?? value).replace(/\s+/g, '');
    return data.length === 0 || !isValidBase64(data);
  }

  private isValidInlineMediaInput(input: InlineInput | undefined, kind: MediaKind): boolean {
    if (!input) {
      return true;
    }

    const data = isString(input) ? input : input.data;
    if (!isString(data)) {
      return true;
    }
    if (/^data:/i.test(data)) {
      return kind === 'image' ? Boolean(parseImageDataUrl(data)) : Boolean(parseAudioDataUrl(data));
    }

    if (this.hasInvalidBase64Data(data)) {
      return false;
    }

    return isString(input)
      ? Boolean(this.detectMediaMimeType(data, kind))
      : this.hasSupportedMediaMimeType(input, kind);
  }

  private isSupportedAnthropicImageMimeType(mimeType: string): boolean {
    return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType.toLowerCase());
  }

  private hasSupportedMediaMimeType(input: Exclude<InlineInput, string>, kind: MediaKind): boolean {
    const mimeType = input.mimeType?.toLowerCase();
    if (!mimeType) {
      return false;
    }
    if (mimeType.startsWith(`${kind}/`)) {
      return true;
    }
    if (!['application/octet-stream', 'text/plain'].includes(mimeType) || !isString(input.data)) {
      return false;
    }

    return (
      !this.hasInvalidBase64Data(input.data) && Boolean(this.detectMediaMimeType(input.data, kind))
    );
  }

  private detectMediaMimeType(data: string, kind: MediaKind): string | null {
    const bytes = Buffer.from(data, 'base64');
    if (kind === 'image') {
      if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return 'image/png';
      }
      if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        return 'image/jpeg';
      }
      if (
        bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) ||
        bytes.subarray(0, 6).equals(Buffer.from('GIF89a'))
      ) {
        return 'image/gif';
      }
      if (
        bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
        bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
      ) {
        return 'image/webp';
      }
      return null;
    }

    if (
      bytes.subarray(0, 3).equals(Buffer.from('ID3')) ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    ) {
      return 'audio/mpeg';
    }
    if (
      bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
      bytes.subarray(8, 12).equals(Buffer.from('WAVE'))
    ) {
      return 'audio/wav';
    }
    if (bytes.subarray(0, 4).equals(Buffer.from('fLaC'))) {
      return 'audio/flac';
    }
    if (bytes.subarray(0, 4).equals(Buffer.from('OggS'))) {
      return 'audio/ogg';
    }
    if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
      return 'audio/webm';
    }
    if (bytes.subarray(4, 8).equals(Buffer.from('ftyp'))) {
      return 'audio/mp4';
    }
    return null;
  }

  private validateImageInputCount(
    images: InlineInput[],
    referenceImages: InlineInput[],
    res: FastifyReply,
  ): boolean {
    if (images.length + referenceImages.length <= 16) {
      return true;
    }

    this.sendInvalidRequest(
      res,
      'At most 16 image inputs are supported by this endpoint.',
      'image',
      'invalid_value',
    );
    return false;
  }

  private resolveInlineData(
    input: unknown,
    defaultMimeType = 'audio/mpeg',
  ): {
    mimeType: string;
    data: string;
  } | null {
    if (!input) {
      return null;
    }

    const kind: MediaKind = defaultMimeType.startsWith('image/') ? 'image' : 'audio';
    if (isString(input)) {
      const dataUrl = kind === 'image' ? parseImageDataUrl(input) : parseAudioDataUrl(input);
      if (dataUrl) {
        return {
          mimeType: dataUrl.mimeType,
          data: dataUrl.data,
        };
      }

      const dataUri = input.match(/^data:(?<mime>[^;]+);base64,(?<data>[A-Za-z0-9+/=]+)$/);
      if (dataUri?.groups?.mime && dataUri.groups.data) {
        return {
          mimeType: dataUri.groups.mime,
          data: dataUri.groups.data,
        };
      }

      const cleaned = input.replace(/\s+/g, '');
      const mimeType = this.detectMediaMimeType(cleaned, kind);
      if (cleaned.length > 0 && mimeType) {
        return {
          mimeType,
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
      const dataUrl = kind === 'image' ? parseImageDataUrl(data) : parseAudioDataUrl(data);
      if (dataUrl) {
        return dataUrl;
      }
      const declaredMimeType = this.asString(inputRecord.mimeType)?.toLowerCase();
      const mimeType =
        declaredMimeType && ['application/octet-stream', 'text/plain'].includes(declaredMimeType)
          ? (this.detectMediaMimeType(data, kind) ?? declaredMimeType)
          : (declaredMimeType ?? defaultMimeType);
      return {
        mimeType,
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

  private isObservableLike(value: unknown): value is Observable<unknown> {
    return isObjectLike(value) && isFunction((value as { subscribe?: unknown }).subscribe);
  }

  private writeSseResponse(
    res: FastifyReply,
    stream: Observable<unknown>,
    wireProtocol: 'openai' | 'responses' | 'anthropic' = 'openai',
  ): void {
    if (!res.raw || !isFunction(res.raw.writeHead) || !isFunction(res.raw.write)) {
      res.header('Content-Type', 'text/event-stream');
      res.header('Cache-Control', 'no-cache');
      res.header('Connection', 'keep-alive');
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
    });

    let nextResponsesSequenceNumber = 0;
    const subscription = stream.subscribe({
      next: (chunk) => {
        if (res.raw.writableEnded) {
          return;
        }
        const payload = isString(chunk) ? chunk : String(chunk ?? '');
        if (wireProtocol === 'responses') {
          const sequenceNumber = this.responsesSequenceNumber(payload);
          if (sequenceNumber !== null) {
            nextResponsesSequenceNumber = Math.max(nextResponsesSequenceNumber, sequenceNumber + 1);
          }
        }
        res.raw.write(payload);
      },
      error: (error) => {
        if (res.raw.writableEnded) {
          return;
        }
        const mapped = mapOpenAIProtocolError(error);
        const payload =
          wireProtocol === 'responses'
            ? {
                code: mapped.error.code ?? 'server_error',
                message: mapped.error.message,
                param: mapped.error.param,
                sequence_number: nextResponsesSequenceNumber,
                type: 'error',
              }
            : wireProtocol === 'anthropic'
              ? {
                  type: 'error',
                  error: {
                    type:
                      mapped.error.type === 'invalid_request_error'
                        ? 'invalid_request_error'
                        : 'api_error',
                    message: mapped.error.message,
                  },
                }
              : { error: mapped.error };
        res.raw.write(
          wireProtocol === 'responses' || wireProtocol === 'anthropic'
            ? `event: error\ndata: ${JSON.stringify(payload)}\n\n`
            : `data: ${JSON.stringify(payload)}\n\n`,
        );
        res.raw.end();
      },
      complete: () => {
        if (!res.raw.writableEnded) {
          res.raw.end();
        }
      },
    });

    res.raw.on('close', () => {
      subscription.unsubscribe();
    });
  }

  private responsesSequenceNumber(payload: string): number | null {
    const dataLine = payload.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return null;
    }
    try {
      const parsed = this.toRecord(JSON.parse(dataLine.slice('data:'.length).trim()));
      return isNumber(parsed?.sequence_number) ? parsed.sequence_number : null;
    } catch {
      return null;
    }
  }

  private async sendOpenAIImageGenerationResponse(
    request: OpenAIChatRequest,
    prompt: string,
    endpoint: '/v1/images/generations' | '/v1/images/edits',
    res: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.proxyService.handleChatCompletions(request);
      if (result instanceof Observable) {
        this.logProxyEndpointError(
          endpoint,
          HttpStatus.INTERNAL_SERVER_ERROR,
          'Streaming image generation is not supported by this endpoint',
        );
        sendOpenAIProtocolError(
          res,
          this.invalidRequest('Streaming image generation is not supported by this endpoint'),
        );
        return;
      }

      const content = result.choices?.[0]?.message?.content;
      const image = this.extractInlineBase64Image(isString(content) ? content : '');
      if (!image) {
        this.logProxyEndpointError(
          endpoint,
          HttpStatus.BAD_GATEWAY,
          'Upstream did not return inline image data',
        );
        sendOpenAIProtocolError(
          res,
          new OpenAIProtocolException(
            'Upstream did not return inline image data',
            HttpStatus.BAD_GATEWAY,
          ),
        );
        return;
      }

      res.status(HttpStatus.OK).send({
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            b64_json: image.data,
          },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';

      if (this.isProjectContextErrorMessage(message)) {
        try {
          const geminiRequest = this.buildGeminiImageRequest(request, prompt);
          const geminiResult = await this.proxyService.handleGeminiGenerateContent(
            request.model ?? 'gemini-3-pro-image',
            geminiRequest,
          );
          const fallbackImage = this.extractInlineBase64ImageFromGeminiResponse(geminiResult);
          if (fallbackImage) {
            res.status(HttpStatus.OK).send({
              created: Math.floor(Date.now() / 1000),
              data: [
                {
                  b64_json: fallbackImage.data,
                },
              ],
            });
            return;
          }
          sendOpenAIProtocolError(
            res,
            new OpenAIProtocolException(
              'Upstream did not return inline image data',
              HttpStatus.BAD_GATEWAY,
            ),
          );
          return;
        } catch (fallbackError) {
          this.sendOpenAIErrorResponse(res, endpoint, fallbackError);
          return;
        }
      }

      this.sendOpenAIErrorResponse(res, endpoint, error);
    }
  }

  private extractInlineBase64Image(content: string): {
    mimeType: string;
    data: string;
  } | null {
    const pattern = /data:(?<mime>[\w/+.-]+);base64,(?<data>[A-Za-z0-9+/=]+)/;
    const matched = content.match(pattern);
    if (!matched || !matched.groups) {
      return null;
    }

    return {
      mimeType: matched.groups.mime,
      data: matched.groups.data,
    };
  }

  private extractInlineBase64ImageFromGeminiResponse(response: GeminiResponse): {
    mimeType: string;
    data: string;
  } | null {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        return {
          mimeType: part.inlineData.mimeType ?? 'image/jpeg',
          data: part.inlineData.data,
        };
      }
      if (part.text) {
        const parsed = this.extractInlineBase64Image(part.text);
        if (parsed) {
          return parsed;
        }
      }
    }
    return null;
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

    return {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
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

    return this.isMultipartContentType(req) && contentType.toLowerCase().includes('boundary=');
  }

  private isMultipartContentType(req: FastifyRequest): boolean {
    const contentType = req.headers['content-type'];
    return isString(contentType) && contentType.toLowerCase().includes('multipart/form-data');
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
    const responseError = this.withOverriddenErrorMessage(error, overrideMessage);
    const mapped = mapOpenAIProtocolError(responseError);
    this.logProxyEndpointError(endpoint, mapped.status, mapped.error.message, error);
    sendOpenAIProtocolError(res, responseError);
  }

  private sendAnthropicErrorResponse(
    res: FastifyReply,
    endpoint: string,
    error: unknown,
    overrideMessage?: string,
  ): void {
    const responseError = this.withOverriddenErrorMessage(error, overrideMessage);
    const mapped = mapOpenAIProtocolError(responseError);
    this.logProxyEndpointError(endpoint, mapped.status, mapped.error.message, error);
    res.status(mapped.status).send({
      type: 'error',
      error: {
        type: mapped.error.type === 'invalid_request_error' ? 'invalid_request_error' : 'api_error',
        message: mapped.error.message,
      },
    });
  }

  private withOverriddenErrorMessage(error: unknown, overrideMessage?: string): unknown {
    if (!overrideMessage) {
      return error;
    }
    if (error instanceof UpstreamRequestError) {
      return new UpstreamRequestError({
        message: overrideMessage,
        status: error.status,
        headers: error.headers,
        body: error.body,
      });
    }
    if (error instanceof OpenAIProtocolException) {
      return new OpenAIProtocolException(overrideMessage, error.getStatus(), error.protocolError);
    }
    if (error instanceof Error) {
      const overriddenError = new Error(overrideMessage, { cause: error });
      return overriddenError;
    }
    return new Error(overrideMessage);
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
