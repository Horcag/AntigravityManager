import { isPlainObject, isString } from 'lodash-es';
import { resolveModelVariant } from '../../../../antigravity/model-variant-registry';

import type {
  OpenAIChatRequest,
  OpenAICompletionRequest,
  OpenAIMessage,
} from '../../../common/interfaces/request-interfaces';

type OpenAIRequestErrorCode =
  | 'invalid_value'
  | 'missing_required_parameter'
  | 'unsupported_parameter';

export class OpenAIRequestValidationError extends Error {
  public readonly status = 400;
  public readonly type = 'invalid_request_error';

  public constructor(
    message: string,
    public readonly param: string,
    public readonly code: OpenAIRequestErrorCode,
  ) {
    super(message);
    this.name = 'OpenAIRequestValidationError';
  }
}

export function normalizeOpenAIChatRequest(request: OpenAIChatRequest): OpenAIChatRequest {
  const raw = asRecord(request, 'body');
  const model = requireNonEmptyString(raw.model, 'model');
  const messages = normalizeMessages(raw.messages);

  validateNumberRange(raw.temperature, 'temperature', 0, 2);
  validateNumberRange(raw.top_p, 'top_p', 0, 1);
  validateNumberRange(raw.presence_penalty, 'presence_penalty', -2, 2);
  validateNumberRange(raw.frequency_penalty, 'frequency_penalty', -2, 2);
  validateOptionalInteger(raw.seed, 'seed');
  validatePositiveInteger(raw.n, 'n');
  validatePositiveInteger(raw.max_tokens, 'max_tokens');
  validatePositiveInteger(raw.max_completion_tokens, 'max_completion_tokens');

  if (
    raw.max_tokens !== undefined &&
    raw.max_completion_tokens !== undefined &&
    raw.max_tokens !== raw.max_completion_tokens
  ) {
    invalid(
      'max_completion_tokens',
      'max_tokens and max_completion_tokens must match when both are supplied',
    );
  }

  validateOptionalBoolean(raw.stream, 'stream');
  validateStreamOptions(raw.stream_options, raw.stream === true);
  validateOptionalBoolean(raw.parallel_tool_calls, 'parallel_tool_calls');
  if (raw.parallel_tool_calls === false && Array.isArray(raw.tools) && raw.tools.length > 0) {
    unsupported(
      'parallel_tool_calls',
      'parallel_tool_calls=false cannot be enforced by the Gemini transport',
    );
  }

  validateOptionalBoolean(raw.logprobs, 'logprobs');
  validateIntegerRange(raw.top_logprobs, 'top_logprobs', 0, 20);
  if (raw.top_logprobs !== undefined && raw.logprobs !== true) {
    invalid('top_logprobs', 'top_logprobs requires logprobs=true');
  }
  if (raw.stream === true && raw.logprobs === true) {
    unsupported('logprobs', 'streaming logprobs are not exposed reliably by the Gemini transport');
  }

  validateLogitBias(raw.logit_bias);
  validateOptionalBoolean(raw.store, 'store');
  if (raw.store === true) {
    unsupported('store', 'stored Chat Completions are not implemented by this proxy');
  }
  validateMetadata(raw.metadata);
  validateOptionalString(raw.user, 'user');
  validateServiceTier(raw.service_tier);
  validateReasoningControls(raw.thinking, raw.reasoning_effort);
  validateModelCapabilities(raw, model);
  if (raw.extra !== undefined) {
    asRecord(raw.extra, 'extra');
  }
  validateResponseFormat(raw.response_format);
  validateUnsupportedChatFields(raw);
  validateKnownChatFields(raw);

  return {
    ...(request as OpenAIChatRequest),
    model,
    messages,
    max_tokens: (raw.max_completion_tokens ?? raw.max_tokens) as number | undefined,
    stop: normalizeStop(raw.stop),
  };
}

export function normalizeOpenAICompletionRequest(body: OpenAICompletionRequest): {
  prompt: string;
  request: OpenAIChatRequest;
} {
  const raw = asRecord(body, 'body');
  const model = requireNonEmptyString(raw.model, 'model');
  const prompt = normalizeCompletionPrompt(raw.prompt);

  validateNumberRange(raw.temperature, 'temperature', 0, 2);
  validateNumberRange(raw.top_p, 'top_p', 0, 1);
  validateNumberRange(raw.presence_penalty, 'presence_penalty', -2, 2);
  validateNumberRange(raw.frequency_penalty, 'frequency_penalty', -2, 2);
  validateOptionalInteger(raw.seed, 'seed');
  validatePositiveInteger(raw.max_tokens, 'max_tokens');
  validatePositiveInteger(raw.n, 'n');
  validateOptionalBoolean(raw.stream, 'stream');
  validateStreamOptions(raw.stream_options, raw.stream === true);
  validateOptionalString(raw.user, 'user');
  validateLogitBias(raw.logit_bias);

  if (raw.best_of !== undefined) {
    validatePositiveInteger(raw.best_of, 'best_of');
    if (raw.best_of !== 1) {
      unsupported('best_of', 'best_of>1 ranking is not available through the Gemini transport');
    }
  }
  if (raw.echo === true) {
    unsupported('echo', 'echo=true is not available through the Gemini transport');
  }
  validateOptionalBoolean(raw.echo, 'echo');
  if (raw.suffix !== undefined && raw.suffix !== null && raw.suffix !== '') {
    unsupported('suffix', 'suffix insertion is not available through the Gemini transport');
  }
  if (raw.logprobs !== undefined && raw.logprobs !== null) {
    unsupported(
      'logprobs',
      'legacy Completions logprobs are not exposed by this compatibility endpoint',
    );
  }
  validateKnownCompletionFields(raw);

  return {
    prompt,
    request: {
      model,
      messages: [{ role: 'user', content: prompt }],
      n: raw.n as number | undefined,
      max_tokens: raw.max_tokens as number | undefined,
      temperature: raw.temperature as number | undefined,
      top_p: raw.top_p as number | undefined,
      presence_penalty: raw.presence_penalty as number | undefined,
      frequency_penalty: raw.frequency_penalty as number | undefined,
      seed: raw.seed as number | undefined,
      stop: normalizeStop(raw.stop),
      stream: raw.stream as boolean | undefined,
      stream_options: raw.stream_options as OpenAIChatRequest['stream_options'],
      user: raw.user as string | undefined,
    },
  };
}

function validateKnownCompletionFields(raw: Record<string, unknown>): void {
  const knownFields = new Set([
    'best_of',
    'echo',
    'frequency_penalty',
    'logit_bias',
    'logprobs',
    'max_tokens',
    'model',
    'n',
    'presence_penalty',
    'prompt',
    'seed',
    'stop',
    'stream',
    'stream_options',
    'suffix',
    'temperature',
    'top_p',
    'user',
  ]);
  for (const field of Object.keys(raw)) {
    if (!knownFields.has(field)) {
      unsupported(field, `${field} is not implemented by this legacy Completions adapter`);
    }
  }
}

function normalizeMessages(value: unknown): OpenAIMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    missing('messages', 'messages must be a non-empty array');
  }

  const allowedRoles = new Set(['assistant', 'developer', 'system', 'tool', 'user']);
  return value.map((message, index) => {
    const record = asRecord(message, `messages.${index}`);
    const role = requireNonEmptyString(record.role, `messages.${index}.role`);
    if (!allowedRoles.has(role)) {
      invalid(`messages.${index}.role`, `unsupported message role: ${role}`);
    }
    if (record.content === null) {
      if (
        role !== 'assistant' ||
        !Array.isArray(record.tool_calls) ||
        record.tool_calls.length === 0
      ) {
        invalid(
          `messages.${index}.content`,
          'null content is only valid for an assistant message with tool_calls',
        );
      }
    } else if (!isString(record.content) && !Array.isArray(record.content)) {
      invalid(
        `messages.${index}.content`,
        'message content must be a string, an array of content parts, or null',
      );
    }
    if (Array.isArray(record.content)) {
      if (record.content.length === 0) {
        invalid(`messages.${index}.content`, 'message content parts must not be empty');
      }
      for (const [partIndex, partValue] of record.content.entries()) {
        validateMessageContentPart(partValue, `messages.${index}.content.${partIndex}`);
      }
    }
    validateOptionalString(record.name, `messages.${index}.name`);
    if (role === 'tool') {
      requireNonEmptyString(record.tool_call_id, `messages.${index}.tool_call_id`);
    }
    return message as OpenAIMessage;
  });
}

function validateMessageContentPart(value: unknown, param: string): void {
  const part = asRecord(value, param);
  const type = requireNonEmptyString(part.type, `${param}.type`);
  if (type === 'text') {
    if (!isString(part.text)) {
      invalid(`${param}.text`, 'text content parts require a string text field');
    }
    return;
  }
  if (type === 'image_url') {
    const image = asRecord(part.image_url, `${param}.image_url`);
    const url = requireNonEmptyString(image.url, `${param}.image_url.url`);
    if (!/^data:image\/[\w.+-]+;base64,/i.test(url)) {
      unsupported(
        `${param}.image_url.url`,
        'remote image URLs are not fetched; provide a base64 image data URL',
      );
    }
    if (image.detail !== undefined && image.detail !== 'auto') {
      unsupported(`${param}.image_url.detail`, 'only image detail=auto is supported');
    }
    return;
  }
  unsupported(`${param}.type`, `content part type ${type} is not implemented by this proxy`);
}

function normalizeCompletionPrompt(value: unknown): string {
  if (value === undefined || value === null) {
    missing('prompt', 'prompt is required');
  }
  if (isString(value)) {
    return value;
  }
  if (!Array.isArray(value)) {
    invalid('prompt', 'prompt must be a string or a supported prompt array');
  }
  if (value.length === 0) {
    missing('prompt', 'prompt must contain one string');
  }
  if (value.every(isString)) {
    if (value.length > 1) {
      unsupported(
        'prompt',
        'batched prompt arrays are not available through this Gemini compatibility endpoint',
      );
    }
    return value[0] ?? '';
  }
  unsupported(
    'prompt',
    'token-id prompts cannot be decoded safely without the original OpenAI tokenizer',
  );
}

function normalizeStop(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const values = isString(value) ? [value] : value;
  if (!Array.isArray(values) || values.some((entry) => !isString(entry))) {
    invalid('stop', 'stop must be a string or an array of strings');
  }
  if (values.length > 4) {
    invalid('stop', 'stop supports at most 4 sequences');
  }
  return [...values];
}

function validateResponseFormat(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const format = asRecord(value, 'response_format');
  const type = format.type ?? 'text';
  if (!isString(type) || !['text', 'json_object', 'json_schema'].includes(type)) {
    invalid('response_format.type', 'supported values are text, json_object, and json_schema');
  }
  if (type !== 'json_schema') {
    return;
  }
  const jsonSchema = asRecord(format.json_schema, 'response_format.json_schema');
  requireNonEmptyString(jsonSchema.name, 'response_format.json_schema.name');
  asRecord(jsonSchema.schema, 'response_format.json_schema.schema');
  validateOptionalBoolean(jsonSchema.strict, 'response_format.json_schema.strict');
}

function validateUnsupportedChatFields(raw: Record<string, unknown>): void {
  for (const param of [
    'audio',
    'function_call',
    'functions',
    'prediction',
    'quality',
    'size',
    'web_search_options',
  ]) {
    if (raw[param] !== undefined) {
      unsupported(param, `${param} is not implemented by this Chat Completions adapter`);
    }
  }
  if (raw.modalities !== undefined) {
    if (
      !Array.isArray(raw.modalities) ||
      raw.modalities.length !== 1 ||
      raw.modalities[0] !== 'text'
    ) {
      unsupported('modalities', 'only text Chat Completions are implemented by this endpoint');
    }
  }
}

function validateKnownChatFields(raw: Record<string, unknown>): void {
  const knownFields = new Set([
    'audio',
    'extra',
    'frequency_penalty',
    'function_call',
    'functions',
    'logit_bias',
    'logprobs',
    'max_completion_tokens',
    'max_tokens',
    'messages',
    'metadata',
    'modalities',
    'model',
    'n',
    'parallel_tool_calls',
    'prediction',
    'presence_penalty',
    'quality',
    'reasoning_effort',
    'response_format',
    'seed',
    'service_tier',
    'size',
    'stop',
    'store',
    'stream',
    'stream_options',
    'temperature',
    'thinking',
    'tool_choice',
    'tools',
    'top_logprobs',
    'top_p',
    'user',
    'web_search_options',
  ]);
  for (const field of Object.keys(raw)) {
    if (!knownFields.has(field)) {
      unsupported(field, `${field} is not implemented by this Chat Completions adapter`);
    }
  }
}

function validateReasoningControls(thinkingValue: unknown, effortValue: unknown): void {
  if (effortValue !== undefined) {
    if (!isString(effortValue) || !['low', 'medium', 'high'].includes(effortValue)) {
      unsupported('reasoning_effort', 'supported values are low, medium, and high');
    }
  }
  if (thinkingValue === undefined) {
    return;
  }
  const thinking = asRecord(thinkingValue, 'thinking');
  if (
    thinking.type !== undefined &&
    (!isString(thinking.type) || !['enabled', 'adaptive'].includes(thinking.type))
  ) {
    unsupported('thinking.type', 'supported values are enabled and adaptive');
  }
  validatePositiveInteger(thinking.budget_tokens, 'thinking.budget_tokens');
  if (thinking.effort !== undefined) {
    if (!isString(thinking.effort) || !['low', 'medium', 'high'].includes(thinking.effort)) {
      unsupported('thinking.effort', 'supported values are low, medium, and high');
    }
  }
}

function validateModelCapabilities(raw: Record<string, unknown>, model: string): void {
  const thinking = isPlainObject(raw.thinking)
    ? (raw.thinking as Record<string, unknown>)
    : undefined;
  const variant = resolveModelVariant({
    model,
    budgetTokens: typeof thinking?.budget_tokens === 'number' ? thinking.budget_tokens : undefined,
    effort: isString(raw.reasoning_effort)
      ? raw.reasoning_effort
      : isString(thinking?.effort)
        ? thinking.effort
        : undefined,
  });
  if (!variant) {
    return;
  }
  if (Array.isArray(raw.tools) && raw.tools.length > 0 && !variant.supportsTools) {
    unsupported('tools', `model ${model} does not support tool calls`);
  }
  if (
    (raw.thinking !== undefined || raw.reasoning_effort !== undefined) &&
    variant.thinkingBudget === 0
  ) {
    unsupported(
      raw.thinking !== undefined ? 'thinking' : 'reasoning_effort',
      `model ${model} does not support reasoning controls`,
    );
  }
}

function validateStreamOptions(value: unknown, streaming: boolean): void {
  if (value === undefined) {
    return;
  }
  const options = asRecord(value, 'stream_options');
  if (!streaming) {
    invalid('stream_options', 'stream_options may only be set when stream=true');
  }
  validateOptionalBoolean(options.include_usage, 'stream_options.include_usage');
  for (const key of Object.keys(options)) {
    if (key !== 'include_usage') {
      unsupported(
        `stream_options.${key}`,
        `stream_options.${key} is not implemented by this proxy`,
      );
    }
  }
}

function validateLogitBias(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const bias = asRecord(value, 'logit_bias');
  if (Object.keys(bias).length > 0) {
    unsupported('logit_bias', 'logit_bias is not available through the Gemini transport');
  }
}

function validateMetadata(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const metadata = asRecord(value, 'metadata');
  if (Object.keys(metadata).length > 16) {
    invalid('metadata', 'metadata supports at most 16 entries');
  }
  for (const [key, entry] of Object.entries(metadata)) {
    if (!isString(entry)) {
      invalid(`metadata.${key}`, 'metadata values must be strings');
    }
  }
}

function validateServiceTier(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isString(value) || !['auto', 'default'].includes(value)) {
    unsupported('service_tier', 'only service_tier=auto/default can be represented by this proxy');
  }
}

function validateNumberRange(
  value: unknown,
  param: string,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(param, `${param} must be a number between ${minimum} and ${maximum}`);
  }
}

function validateIntegerRange(
  value: unknown,
  param: string,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(param, `${param} must be an integer between ${minimum} and ${maximum}`);
  }
}

function validatePositiveInteger(value: unknown, param: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    invalid(param, `${param} must be a positive integer`);
  }
}

function validateOptionalInteger(value: unknown, param: string): void {
  if (value !== undefined && !Number.isInteger(value)) {
    invalid(param, `${param} must be an integer`);
  }
}

function validateOptionalBoolean(value: unknown, param: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    invalid(param, `${param} must be a boolean`);
  }
}

function validateOptionalString(value: unknown, param: string): void {
  if (value !== undefined && !isString(value)) {
    invalid(param, `${param} must be a string`);
  }
}

function asRecord(value: unknown, param: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    invalid(param, `${param} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, param: string): string {
  if (!isString(value) || value.trim().length === 0) {
    missing(param, `${param} is required and must be a non-empty string`);
  }
  return value.trim();
}

function missing(param: string, message: string): never {
  throw new OpenAIRequestValidationError(message, param, 'missing_required_parameter');
}

function invalid(param: string, message: string): never {
  throw new OpenAIRequestValidationError(message, param, 'invalid_value');
}

function unsupported(param: string, message: string): never {
  throw new OpenAIRequestValidationError(message, param, 'unsupported_parameter');
}
