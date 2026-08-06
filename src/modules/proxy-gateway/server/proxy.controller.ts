import {
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
import { isEmpty, isFunction, isNil, isObjectLike, isPlainObject, isString } from 'lodash-es';
import { ProxyService } from './proxy.service';
import { Observable } from 'rxjs';
import {
  OpenAIChatRequest,
  AnthropicChatRequest,
  OpenAIChatResponse,
  OpenAIContentPart,
  GeminiRequest,
  GeminiResponse,
} from './interfaces/request-interfaces';
import { ProxyGuard } from './proxy.guard';
import {
  getOpenAICompatibleModels,
  MODEL_LIST_CREATED_AT,
  MODEL_LIST_OWNER,
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

interface ImageOptionInput {
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
    body: {
      model?: string;
      prompt?: string | string[];
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      stream?: boolean;
    },
    @Res() res: FastifyReply,
  ) {
    this.requireNonEmptyString(body.model, 'model');
    this.validateCompletionPrompt(body.prompt);
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
      stream: body.stream,
    };
    try {
      const result = await this.proxyService.handleChatCompletions(request);
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
    this.requireNonEmptyString(body.model, 'model');
    this.validateResponsesInput(body.input);
    this.validateTools(body.tools, body.tool_choice);
    const request = this.buildResponsesChatRequest(body);

    try {
      const result = await this.proxyService.handleChatCompletions(request, 'responses');
      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      }

      const response = result as OpenAIChatResponse;
      res.status(HttpStatus.OK).send(this.toResponsesResponse(response));
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
    this.requireNonEmptyString(body.prompt, 'prompt');
    if (!this.validateImageOptions(body, res)) {
      return;
    }
    const request: OpenAIChatRequest = {
      model: body.model ?? 'gemini-3-pro-image',
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

    await this.sendOpenAIImageGenerationResponse(request, body.prompt ?? '', res);
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
      model: input.model ?? 'gemini-3-pro-image',
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

    await this.sendOpenAIImageGenerationResponse(request, input.prompt ?? '', res);
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
      timestamp_granularities?: string[];
      file?: InlineInput;
      audio?: InlineInput;
    },
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
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
    try {
      const result = await this.proxyService.handleAnthropicMessages(body);

      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
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

  private validateChatRequest(body: OpenAIChatRequest): void {
    this.requireNonEmptyString(body.model, 'model');
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw this.invalidRequest('messages must be a non-empty array', 'messages');
    }
    for (const message of body.messages) {
      if (
        !message ||
        !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
      ) {
        throw this.invalidRequest('messages contains an unsupported role', 'messages');
      }
      if (!this.isValidMessageContent(message.content)) {
        throw this.invalidRequest('messages contains unsupported content', 'messages');
      }
    }
    this.validateTools(body.tools, body.tool_choice);
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
  }

  private validateResponsesInput(input: unknown): void {
    if (isString(input) && !isEmpty(input.trim())) {
      return;
    }
    if (Array.isArray(input) && input.length > 0) {
      return;
    }
    throw this.invalidRequest('input must be non-empty', 'input');
  }

  private validateTools(
    tools: OpenAIChatRequest['tools'] | undefined,
    toolChoice: OpenAIChatRequest['tool_choice'] | undefined,
  ): void {
    if (
      tools &&
      (!Array.isArray(tools) ||
        tools.some((tool) => tool.type !== 'function' || !tool.function?.name))
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

  private isValidMessageContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): boolean {
    if (isString(content) || content === null) {
      return true;
    }
    return (
      Array.isArray(content) &&
      content.every(
        (part) =>
          (part.type === 'text' && isString(part.text)) ||
          (part.type === 'image_url' &&
            isString(part.image_url?.url) &&
            !isEmpty(part.image_url.url.trim())),
      )
    );
  }

  private requireNonEmptyString(value: unknown, param: string): asserts value is string {
    if (!isString(value) || isEmpty(value.trim())) {
      throw this.invalidRequest(`${param} is required`, param);
    }
  }

  private invalidRequest(message: string, param?: string): OpenAIProtocolException {
    return new OpenAIProtocolException(message, HttpStatus.BAD_REQUEST, { param });
  }

  private validateImageOptions(input: ImageOptionInput, res: FastifyReply): boolean {
    const responseFormat = input.response_format ?? input.responseFormat;
    const outputFormat = input.output_format ?? input.outputFormat;
    const outputCompression = input.output_compression ?? input.outputCompression;
    const partialImages = input.partial_images ?? input.partialImages;
    const inputFidelity = input.input_fidelity ?? input.inputFidelity;

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
    if (input.stream === true || input.stream === 'true') {
      this.sendUnsupportedImageOption(
        res,
        'Streaming image generation is not supported by this endpoint.',
        'stream',
      );
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

    return {
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
      usage: response.usage,
    };
  }

  private toResponsesResponse(response: OpenAIChatResponse): Record<string, unknown> {
    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    const text = isString(content) ? content : '';
    const output: Array<Record<string, unknown>> = [];

    if (text) {
      output.push({
        id: this.normalizeResponsesId('msg', response.id),
        type: 'message',
        status: 'completed',
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
        id: this.normalizeResponsesId('fc', toolCall.id),
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
      status: 'completed',
      error: null,
      incomplete_details: null,
      model: response.model,
      output,
      parallel_tool_calls: true,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        input_tokens_details: {
          cached_tokens: 0,
        },
        output_tokens: response.usage?.completion_tokens ?? 0,
        output_tokens_details: {
          reasoning_tokens: 0,
        },
        total_tokens: response.usage?.total_tokens ?? 0,
      },
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

        const type = this.asString(itemObj.type);
        if (!type) {
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

        if (type === 'function_call' || type === 'local_shell_call' || type === 'web_search_call') {
          const callId =
            this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? `call_${Date.now()}`;
          const toolName = callIdToToolName.get(callId) ?? 'unknown';
          const args = this.resolveToolArguments(type, itemObj);
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: callId,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          });
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
      tool_choice: body.tool_choice,
      max_tokens: body.max_output_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: body.stream,
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
      timestamp_granularities?: string[];
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
    const files = (name: string): InlineInput[] => multipart.files[name] ?? [];
    const temperatureValue = field('temperature') ?? body.temperature;
    const parsedTemperature =
      typeof temperatureValue === 'number'
        ? temperatureValue
        : isString(temperatureValue) && temperatureValue.trim() !== ''
          ? Number(temperatureValue)
          : Number.NaN;
    const timestampGranularities = [
      ...(body.timestamp_granularities ?? []),
      ...this.asStringArray(multipart.fields.timestamp_granularities),
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
      images: files('image').length > 0 ? files('image') : body.image ? [body.image] : [],
      referenceImages:
        files('reference_images').length > 0
          ? files('reference_images')
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
        ...(param ? { param } : {}),
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
      'invalid_request_error',
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

  private isObservableLike(value: unknown): value is Observable<unknown> {
    return isObjectLike(value) && isFunction((value as { subscribe?: unknown }).subscribe);
  }

  private writeSseResponse(res: FastifyReply, stream: Observable<unknown>): void {
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

    const subscription = stream.subscribe({
      next: (chunk) => {
        if (res.raw.writableEnded) {
          return;
        }
        const payload = isString(chunk) ? chunk : String(chunk ?? '');
        res.raw.write(payload);
      },
      error: (error) => {
        if (res.raw.writableEnded) {
          return;
        }
        const mapped = mapOpenAIProtocolError(error);
        res.raw.write(
          `data: ${JSON.stringify({
            error: mapped.error,
          })}\n\n`,
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

  private async sendOpenAIImageGenerationResponse(
    request: OpenAIChatRequest,
    prompt: string,
    res: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.proxyService.handleChatCompletions(request);
      if (result instanceof Observable) {
        this.logProxyEndpointError(
          '/v1/images/generations',
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
          '/v1/images/generations',
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
          this.sendOpenAIErrorResponse(res, '/v1/images/generations', fallbackError);
          return;
        }
      }

      this.sendOpenAIErrorResponse(res, '/v1/images/generations', error);
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
