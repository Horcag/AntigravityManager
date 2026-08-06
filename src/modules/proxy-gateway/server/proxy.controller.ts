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
    },
    @Res() res: FastifyReply,
  ) {
    this.requireNonEmptyString(body.prompt, 'prompt');
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
      image?: string | { data?: string; mimeType?: string };
      reference_images?: Array<string | { data?: string; mimeType?: string }>;
      mask?: string | { data?: string; mimeType?: string };
    },
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    this.requireNonEmptyString(body.prompt, 'prompt');
    if (!this.hasMultipartBoundary(req)) {
      sendOpenAIProtocolError(res, this.invalidRequest('Invalid multipart/form-data boundary'));
      return;
    }

    const imageParts = this.collectImageContentParts([
      body.image,
      body.mask,
      ...(body.reference_images ?? []),
    ]);

    const request: OpenAIChatRequest = {
      model: body.model ?? 'gemini-3-pro-image',
      messages: [
        {
          role: 'user',
          content:
            imageParts.length > 0
              ? [
                  {
                    type: 'text',
                    text:
                      body.prompt ?? 'Please edit this image based on the provided instruction.',
                  },
                  ...imageParts,
                ]
              : (body.prompt ?? 'Please edit this image based on the provided instruction.'),
        },
      ],
      stream: false,
      size: body.size,
      quality: body.quality,
    };

    await this.sendOpenAIImageGenerationResponse(request, body.prompt ?? '', res);
  }

  @Post('audio/transcriptions')
  async audioTranscriptions(
    @Body()
    body: {
      model?: string;
      prompt?: string;
      file?: string | { data?: string; mimeType?: string };
      audio?: string | { data?: string; mimeType?: string };
    },
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    this.requireNonEmptyString(body.model, 'model');
    if (!this.hasMultipartBoundary(req)) {
      sendOpenAIProtocolError(res, this.invalidRequest('Invalid multipart/form-data boundary'));
      return;
    }

    const inlineAudio = this.resolveInlineData(body.file ?? body.audio);
    if (!inlineAudio) {
      sendOpenAIProtocolError(
        res,
        this.invalidRequest(
          "Missing 'file' or 'audio' input. Provide base64 content or a data URL.",
        ),
      );
      return;
    }

    try {
      const result = await this.proxyService.handleGeminiGenerateContent(body.model, {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: body.prompt ?? 'Please transcribe the provided speech audio accurately.',
              },
              {
                inlineData: inlineAudio,
              },
            ],
          },
        ],
      });

      const text = result.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('')
        .trim();

      res.status(HttpStatus.OK).send({
        text: text ?? '',
      });
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

  private collectImageContentParts(
    entries: Array<string | { data?: string; mimeType?: string } | undefined>,
  ): OpenAIContentPart[] {
    const parts: OpenAIContentPart[] = [];
    for (const entry of entries) {
      const inlineData = this.resolveInlineData(entry);
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

  private resolveInlineData(input: unknown): {
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
          mimeType: 'audio/mpeg',
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
        mimeType: this.asString(inputRecord.mimeType) ?? 'audio/mpeg',
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
          const inlineData = this.resolveInlineData(imageUrl);
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
