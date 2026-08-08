import { isPlainObject, isString } from 'lodash-es';

import { resolveModelVariant } from '../../../antigravity/model-variant-registry';
import type {
  AnthropicChatRequest,
  AnthropicContent,
  AnthropicCountTokensRequest,
  AnthropicMessage,
} from '../../common/interfaces/request-interfaces';
import {
  OpenAIMediaRequestError,
  parseInlineMediaInput,
} from '../openai/media/openai-media-request-contract';

export const ANTHROPIC_MESSAGES_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
export const ANTHROPIC_IMAGE_BYTES_LIMIT = 5 * 1024 * 1024;

type AnthropicRequestErrorCode =
  | 'invalid_value'
  | 'missing_required_parameter'
  | 'unsupported_parameter';

export class AnthropicRequestValidationError extends Error {
  public readonly status = 400;
  public readonly type = 'invalid_request_error';

  public constructor(
    message: string,
    public readonly param: string,
    public readonly code: AnthropicRequestErrorCode,
  ) {
    super(message);
    this.name = 'AnthropicRequestValidationError';
  }
}

interface MessageValidationResult {
  message: AnthropicMessage;
  toolResultIds: string[];
  toolUseIds: string[];
}

const TOP_LEVEL_FIELDS = new Set([
  'frequency_penalty',
  'max_tokens',
  'messages',
  'metadata',
  'model',
  'output_config',
  'presence_penalty',
  'seed',
  'stop_sequences',
  'stream',
  'system',
  'temperature',
  'thinking',
  'tool_choice',
  'tools',
  'top_k',
  'top_p',
]);

/** `count_tokens` shares the Messages body minus every generation-only field. */
const COUNT_TOKENS_TOP_LEVEL_FIELDS = new Set([
  'messages',
  'model',
  'system',
  'thinking',
  'tool_choice',
  'tools',
]);

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function normalizeAnthropicMessagesRequest(request: unknown): AnthropicChatRequest {
  const raw = asRecord(request, 'body');
  const model = requireNonEmptyString(raw.model, 'model');
  const maxTokens = requirePositiveInteger(raw.max_tokens, 'max_tokens');
  const tools = validateTools(raw.tools);
  const messages = validateMessages(raw.messages);

  validateSystem(raw.system);
  validateNumberRange(raw.temperature, 'temperature', 0, 1);
  validateNumberRange(raw.top_p, 'top_p', 0, 1);
  validateOptionalNonNegativeInteger(raw.top_k, 'top_k');
  validateOptionalBoolean(raw.stream, 'stream');
  const stopSequences = validateStopSequences(raw.stop_sequences);
  validateMetadata(raw.metadata);
  const thinkingType = validateThinking(raw.thinking, maxTokens);
  validateOutputConfig(raw.output_config);
  validateToolChoice(raw.tool_choice, tools, thinkingType);
  validateModelCapabilities(raw, model);
  validateUnsupportedSamplingExtensions(raw);
  validateKnownFields(raw);

  return {
    ...(raw as unknown as AnthropicChatRequest),
    model,
    max_tokens: maxTokens,
    messages,
    ...(stopSequences ? { stop_sequences: stopSequences } : {}),
  };
}

/**
 * Validates `POST /v1/messages/count_tokens`.
 *
 * Runs the same block, tool and system validators as the Messages contract so a body that counts
 * here is a body that would also generate here. `max_tokens` is absent by design, which removes the
 * only bound `thinking.budget_tokens` is checked against.
 */
export function normalizeAnthropicCountTokensRequest(
  request: unknown,
): AnthropicCountTokensRequest {
  const raw = asRecord(request, 'body');
  const model = requireNonEmptyString(raw.model, 'model');
  const tools = validateTools(raw.tools);
  const messages = validateMessages(raw.messages);

  validateSystem(raw.system);
  const thinkingType = validateThinking(raw.thinking, Number.MAX_SAFE_INTEGER);
  validateToolChoice(raw.tool_choice, tools, thinkingType);
  validateModelCapabilities(raw, model);
  for (const field of Object.keys(raw)) {
    if (!COUNT_TOKENS_TOP_LEVEL_FIELDS.has(field)) {
      unsupported(field, `${field} is not part of the Anthropic count_tokens contract`);
    }
  }

  return {
    ...(raw as unknown as AnthropicCountTokensRequest),
    model,
    messages,
  };
}

function validateMessages(value: unknown): AnthropicMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    missing('messages', 'messages must be a non-empty array');
  }
  if (value.length > 100_000) {
    invalid('messages', 'messages supports at most 100000 entries');
  }

  const messages: AnthropicMessage[] = [];
  const seenToolUseIds = new Set<string>();
  let pendingToolUseIds = new Set<string>();

  for (const [messageIndex, messageValue] of value.entries()) {
    const result = validateMessage(messageValue, messageIndex, seenToolUseIds);

    if (pendingToolUseIds.size > 0) {
      validatePendingToolResults(result, messageIndex, pendingToolUseIds);
      pendingToolUseIds = new Set<string>();
    } else if (result.toolResultIds.length > 0) {
      invalid(
        `messages.${messageIndex}.content`,
        'tool_result blocks must immediately follow their matching assistant tool_use blocks',
      );
    }

    if (result.toolUseIds.length > 0) {
      pendingToolUseIds = new Set(result.toolUseIds);
    }
    messages.push(result.message);
  }

  if (pendingToolUseIds.size > 0) {
    invalid(
      `messages.${messages.length - 1}.content`,
      'every tool_use block requires a matching tool_result in the next user message',
    );
  }

  return messages;
}

function validateMessage(
  value: unknown,
  messageIndex: number,
  seenToolUseIds: Set<string>,
): MessageValidationResult {
  const param = `messages.${messageIndex}`;
  const message = asRecord(value, param);
  validateObjectFields(message, param, ['content', 'role']);
  const role = requireExactNonEmptyString(message.role, `${param}.role`);
  if (role !== 'user' && role !== 'assistant') {
    invalid(
      `${param}.role`,
      'Messages roles must be user or assistant; use the top-level system field for instructions',
    );
  }

  if (isString(message.content)) {
    return {
      message: { role, content: message.content },
      toolResultIds: [],
      toolUseIds: [],
    };
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    invalid(`${param}.content`, 'message content must be a string or a non-empty block array');
  }

  const toolResultIds: string[] = [];
  const toolUseIds: string[] = [];
  let encounteredNonToolResult = false;

  for (const [blockIndex, blockValue] of message.content.entries()) {
    const blockParam = `${param}.content.${blockIndex}`;
    const block = validateContentBlock(blockValue, role, blockParam, seenToolUseIds);
    if (block.type === 'tool_use') {
      toolUseIds.push(block.id);
    }
    if (block.type === 'tool_result') {
      if (encounteredNonToolResult) {
        invalid(
          `${param}.content`,
          'tool_result blocks must come before text or image blocks in their user message',
        );
      }
      toolResultIds.push(block.tool_use_id);
    } else {
      encounteredNonToolResult = true;
    }
  }

  return {
    message: value as AnthropicMessage,
    toolResultIds,
    toolUseIds,
  };
}

function validateContentBlock(
  value: unknown,
  role: string,
  param: string,
  seenToolUseIds: Set<string>,
): AnthropicContent {
  const block = asRecord(value, param);
  const type = requireExactNonEmptyString(block.type, `${param}.type`);

  if (type === 'text') {
    validateObjectFields(block, param, ['cache_control', 'text', 'type']);
    if (!isString(block.text)) {
      invalid(`${param}.text`, 'text blocks require a string text field');
    }
    validateCacheControl(block.cache_control, `${param}.cache_control`);
    return value as AnthropicContent;
  }

  if (type === 'image') {
    validateObjectFields(block, param, ['cache_control', 'source', 'type']);
    if (role !== 'user') {
      invalid(`${param}.type`, 'image input blocks are only valid in user messages');
    }
    validateImageSource(block.source, `${param}.source`);
    validateCacheControl(block.cache_control, `${param}.cache_control`);
    return value as AnthropicContent;
  }

  if (type === 'document') {
    validateObjectFields(block, param, ['cache_control', 'context', 'source', 'title', 'type']);
    if (role !== 'user') {
      invalid(`${param}.type`, 'document input blocks are only valid in user messages');
    }
    validateDocumentSource(block.source, `${param}.source`);
    validateOptionalString(block.title, `${param}.title`);
    validateCacheControl(block.cache_control, `${param}.cache_control`);
    return value as AnthropicContent;
  }

  if (type === 'thinking') {
    validateObjectFields(block, param, ['cache_control', 'signature', 'thinking', 'type']);
    if (role !== 'assistant') {
      invalid(`${param}.type`, 'thinking blocks are only valid in assistant messages');
    }
    if (!isString(block.thinking)) {
      invalid(`${param}.thinking`, 'thinking blocks require a string thinking field');
    }
    validateOptionalString(block.signature, `${param}.signature`);
    validateCacheControl(block.cache_control, `${param}.cache_control`);
    return value as AnthropicContent;
  }

  if (type === 'redacted_thinking') {
    unsupported(
      `${param}.type`,
      'redacted_thinking ciphertext cannot be translated into a Gemini thought signature',
    );
  }

  if (type === 'tool_use') {
    validateObjectFields(block, param, [
      'cache_control',
      'id',
      'input',
      'name',
      'signature',
      'type',
    ]);
    if (role !== 'assistant') {
      invalid(`${param}.type`, 'tool_use blocks are only valid in assistant messages');
    }
    const id = requireExactNonEmptyString(block.id, `${param}.id`);
    requireExactNonEmptyString(block.name, `${param}.name`);
    asRecord(block.input, `${param}.input`);
    validateOptionalString(block.signature, `${param}.signature`);
    validateCacheControl(block.cache_control, `${param}.cache_control`);
    if (seenToolUseIds.has(id)) {
      invalid(`${param}.id`, `duplicate tool_use id: ${id}`);
    }
    seenToolUseIds.add(id);
    return value as AnthropicContent;
  }

  if (type === 'tool_result') {
    validateObjectFields(block, param, [
      'cache_control',
      'content',
      'is_error',
      'tool_use_id',
      'type',
    ]);
    if (role !== 'user') {
      invalid(`${param}.type`, 'tool_result blocks are only valid in user messages');
    }
    requireExactNonEmptyString(block.tool_use_id, `${param}.tool_use_id`);
    validateOptionalBoolean(block.is_error, `${param}.is_error`);
    validateToolResultContent(block.content, `${param}.content`);
    validateCacheControl(block.cache_control, `${param}.cache_control`);
    return value as AnthropicContent;
  }

  unsupported(`${param}.type`, `content block type ${type} is not implemented by this proxy`);
}

function validatePendingToolResults(
  result: MessageValidationResult,
  messageIndex: number,
  pendingToolUseIds: Set<string>,
): void {
  if (result.message.role !== 'user') {
    invalid(
      `messages.${messageIndex}.role`,
      'assistant tool_use blocks must be followed by a user tool_result message',
    );
  }
  const results = new Set(result.toolResultIds);
  if (results.size !== result.toolResultIds.length) {
    invalid(`messages.${messageIndex}.content`, 'tool_result ids must not be duplicated');
  }
  if (
    results.size !== pendingToolUseIds.size ||
    [...pendingToolUseIds].some((id) => !results.has(id))
  ) {
    invalid(
      `messages.${messageIndex}.content`,
      'the next user message must return exactly one tool_result for every pending tool_use id',
    );
  }
}

function validateToolResultContent(value: unknown, param: string): void {
  if (value === undefined || isString(value)) {
    return;
  }
  if (!Array.isArray(value)) {
    invalid(param, 'tool_result content must be a string or an array of text and image blocks');
  }
  for (const [index, nestedValue] of value.entries()) {
    const nestedParam = `${param}.${index}`;
    const nested = asRecord(nestedValue, nestedParam);
    if (nested.type === 'text') {
      validateObjectFields(nested, nestedParam, ['cache_control', 'text', 'type']);
      if (!isString(nested.text)) {
        invalid(`${nestedParam}.text`, 'nested text blocks require a string text field');
      }
      validateCacheControl(nested.cache_control, `${nestedParam}.cache_control`);
      continue;
    }
    if (nested.type === 'image') {
      validateObjectFields(nested, nestedParam, ['cache_control', 'source', 'type']);
      validateImageSource(nested.source, `${nestedParam}.source`);
      validateCacheControl(nested.cache_control, `${nestedParam}.cache_control`);
      continue;
    }
    unsupported(
      `${nestedParam}.type`,
      'tool_result content supports only text and base64 image blocks through this proxy',
    );
  }
}

/**
 * Document sources reaching this point are always inline base64: a
 * `{"type":"file","file_id":…}` source is resolved against the local file store
 * before validation runs. URL sources stay unsupported because nothing here
 * fetches remote content.
 */
function validateDocumentSource(value: unknown, param: string): void {
  const source = asRecord(value, param);
  validateObjectFields(source, param, ['data', 'media_type', 'type']);
  if (source.type !== 'base64') {
    unsupported(
      `${param}.type`,
      'document sources must be base64, or a file_id issued by this proxy',
    );
  }
  requireNonEmptyString(source.media_type, `${param}.media_type`);
  if (!isString(source.data)) {
    invalid(`${param}.data`, 'base64 document sources require string data');
  }
}

function validateImageSource(value: unknown, param: string): void {
  const source = asRecord(value, param);
  validateObjectFields(source, param, ['data', 'media_type', 'type']);
  if (source.type !== 'base64') {
    unsupported(`${param}.type`, 'only base64 image sources are supported');
  }
  const mediaType = requireNonEmptyString(source.media_type, `${param}.media_type`).toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mediaType)) {
    unsupported(
      `${param}.media_type`,
      'Gemini transport supports Anthropic image input as image/jpeg, image/png, or image/webp',
    );
  }
  if (!isString(source.data)) {
    invalid(`${param}.data`, 'base64 image sources require string data');
  }
  try {
    parseInlineMediaInput(source, {
      kind: 'image',
      maxBytes: ANTHROPIC_IMAGE_BYTES_LIMIT,
      param: `${param}.data`,
    });
  } catch (error) {
    if (error instanceof OpenAIMediaRequestError) {
      invalid(`${param}.data`, error.message);
    }
    throw error;
  }
}

function validateSystem(value: unknown): void {
  if (value === undefined || isString(value)) {
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    invalid('system', 'system must be a string or a non-empty array of text blocks');
  }
  for (const [index, blockValue] of value.entries()) {
    const param = `system.${index}`;
    const block = asRecord(blockValue, param);
    validateObjectFields(block, param, ['cache_control', 'text', 'type']);
    if (block.type !== 'text') {
      unsupported(`${param}.type`, 'system supports only text blocks through this proxy');
    }
    if (!isString(block.text)) {
      invalid(`${param}.text`, 'system text blocks require a string text field');
    }
    validateCacheControl(block.cache_control, `${param}.cache_control`);
  }
}

function validateTools(value: unknown): Set<string> {
  const names = new Set<string>();
  if (value === undefined) {
    return names;
  }
  if (!Array.isArray(value)) {
    invalid('tools', 'tools must be an array');
  }
  for (const [index, toolValue] of value.entries()) {
    const param = `tools.${index}`;
    const tool = asRecord(toolValue, param);
    validateObjectFields(tool, param, [
      'cache_control',
      'defer_loading',
      'description',
      'input_schema',
      'name',
      'strict',
      'type',
    ]);
    if (tool.type !== undefined) {
      unsupported(
        `${param}.type`,
        'Anthropic server tools are not exposed by the Gemini compatibility transport',
      );
    }
    const name = requireExactNonEmptyString(tool.name, `${param}.name`);
    if (names.has(name)) {
      invalid(`${param}.name`, `duplicate tool name: ${name}`);
    }
    names.add(name);
    validateOptionalString(tool.description, `${param}.description`);
    asRecord(tool.input_schema, `${param}.input_schema`);
    validateCacheControl(tool.cache_control, `${param}.cache_control`);
    if (tool.strict !== undefined) {
      unsupported(`${param}.strict`, 'strict tool schema enforcement is not available upstream');
    }
    if (tool.defer_loading !== undefined) {
      unsupported(`${param}.defer_loading`, 'deferred tool loading is not available upstream');
    }
  }
  return names;
}

function validateToolChoice(
  value: unknown,
  toolNames: Set<string>,
  thinkingType: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (isString(value)) {
    if (!['auto', 'any', 'none'].includes(value)) {
      invalid('tool_choice', 'tool_choice string must be auto, any, or none');
    }
    if (thinkingType && thinkingType !== 'disabled' && value === 'any') {
      invalid('tool_choice', 'thinking only supports auto or none tool choice');
    }
    if (value === 'any' && toolNames.size === 0) {
      invalid('tool_choice', 'tool_choice=any requires at least one declared tool');
    }
    return;
  }
  const choice = asRecord(value, 'tool_choice');
  validateObjectFields(choice, 'tool_choice', ['disable_parallel_tool_use', 'name', 'type']);
  const type = requireExactNonEmptyString(choice.type, 'tool_choice.type');
  if (!['auto', 'any', 'none', 'tool'].includes(type)) {
    invalid('tool_choice.type', 'tool_choice.type must be auto, any, none, or tool');
  }
  validateOptionalBoolean(
    choice.disable_parallel_tool_use,
    'tool_choice.disable_parallel_tool_use',
  );
  if (choice.disable_parallel_tool_use === true) {
    unsupported(
      'tool_choice.disable_parallel_tool_use',
      'disable_parallel_tool_use=true cannot be enforced by the Gemini transport',
    );
  }
  if (type === 'tool') {
    const name = requireExactNonEmptyString(choice.name, 'tool_choice.name');
    if (!toolNames.has(name)) {
      invalid('tool_choice.name', `tool_choice references an undefined tool: ${name}`);
    }
  }
  if (type === 'any' && toolNames.size === 0) {
    invalid('tool_choice.type', 'tool_choice.type=any requires at least one declared tool');
  }
  if (thinkingType && thinkingType !== 'disabled' && (type === 'any' || type === 'tool')) {
    invalid('tool_choice.type', 'thinking only supports auto or none tool choice');
  }
}

function validateThinking(value: unknown, maxTokens: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const thinking = asRecord(value, 'thinking');
  validateObjectFields(thinking, 'thinking', ['budget_tokens', 'display', 'effort', 'type']);
  const type = requireExactNonEmptyString(thinking.type, 'thinking.type');
  if (!['adaptive', 'disabled', 'enabled'].includes(type)) {
    unsupported('thinking.type', 'thinking.type must be adaptive, disabled, or enabled');
  }
  if (thinking.display !== undefined) {
    unsupported('thinking.display', 'thinking display selection is not available upstream');
  }
  if (thinking.effort !== undefined) {
    validateEffort(thinking.effort, 'thinking.effort');
  }
  if (type === 'enabled') {
    if (!Number.isInteger(thinking.budget_tokens) || (thinking.budget_tokens as number) < 1024) {
      invalid('thinking.budget_tokens', 'enabled thinking requires at least 1024 budget_tokens');
    }
    if ((thinking.budget_tokens as number) >= maxTokens) {
      invalid('thinking.budget_tokens', 'thinking.budget_tokens must be lower than max_tokens');
    }
  } else if (thinking.budget_tokens !== undefined) {
    invalid('thinking.budget_tokens', `thinking.type=${type} does not accept budget_tokens`);
  }
  return type;
}

function validateOutputConfig(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const config = asRecord(value, 'output_config');
  if (config.format !== undefined) {
    unsupported(
      'output_config.format',
      'Anthropic structured output schemas are not available through the Gemini transport',
    );
  }
  if (config.effort !== undefined) {
    validateEffort(config.effort, 'output_config.effort');
  }
  for (const field of Object.keys(config)) {
    if (field !== 'effort' && field !== 'format') {
      unsupported(`output_config.${field}`, `output_config.${field} is not implemented`);
    }
  }
}

function validateModelCapabilities(raw: Record<string, unknown>, model: string): void {
  const thinking = isPlainObject(raw.thinking)
    ? (raw.thinking as Record<string, unknown>)
    : undefined;
  const outputConfig = isPlainObject(raw.output_config)
    ? (raw.output_config as Record<string, unknown>)
    : undefined;
  const variant = resolveModelVariant({
    model,
    budgetTokens: typeof thinking?.budget_tokens === 'number' ? thinking.budget_tokens : undefined,
    effort: isString(outputConfig?.effort) ? outputConfig.effort : undefined,
  });
  if (!variant) {
    return;
  }
  if (Array.isArray(raw.tools) && raw.tools.length > 0 && !variant.supportsTools) {
    unsupported('tools', `model ${model} does not support tool calls`);
  }
  if (raw.thinking !== undefined && thinking?.type !== 'disabled' && variant.thinkingBudget === 0) {
    unsupported('thinking', `model ${model} does not support thinking controls`);
  }
}

function validateStopSequences(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => !isString(entry) || entry.length === 0)) {
    invalid('stop_sequences', 'stop_sequences must be an array of non-empty strings');
  }
  if (value.length > 4) {
    invalid('stop_sequences', 'stop_sequences supports at most 4 sequences');
  }
  if (new Set(value).size !== value.length) {
    invalid('stop_sequences', 'stop_sequences must not contain duplicates');
  }
  return [...value];
}

function validateMetadata(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const metadata = asRecord(value, 'metadata');
  for (const [key, entry] of Object.entries(metadata)) {
    if (!['sessionId', 'session_id', 'userId', 'user_id'].includes(key)) {
      unsupported(`metadata.${key}`, `metadata.${key} is not implemented by this proxy`);
    }
    if (!isString(entry) || entry.length > 500) {
      invalid(`metadata.${key}`, 'metadata identifiers must be strings of at most 500 characters');
    }
  }
}

function validateCacheControl(value: unknown, param: string): void {
  if (value === undefined) {
    return;
  }
  const cache = asRecord(value, param);
  validateObjectFields(cache, param, ['ttl', 'type']);
  if (cache.type !== 'ephemeral') {
    invalid(`${param}.type`, 'cache_control.type must be ephemeral');
  }
  if (cache.ttl !== undefined && !['5m', '1h'].includes(String(cache.ttl))) {
    invalid(`${param}.ttl`, 'cache_control.ttl must be 5m or 1h');
  }
}

function validateUnsupportedSamplingExtensions(raw: Record<string, unknown>): void {
  for (const field of ['frequency_penalty', 'presence_penalty', 'seed']) {
    if (raw[field] !== undefined) {
      unsupported(field, `${field} is not part of the Anthropic Messages contract`);
    }
  }
}

function validateKnownFields(raw: Record<string, unknown>): void {
  for (const field of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.has(field)) {
      unsupported(field, `${field} is not implemented by this Anthropic Messages adapter`);
    }
  }
}

function validateObjectFields(
  raw: Record<string, unknown>,
  param: string,
  allowedFields: readonly string[],
): void {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(raw)) {
    if (!allowed.has(field)) {
      unsupported(`${param}.${field}`, `${param}.${field} is not implemented by this proxy`);
    }
  }
}

function validateEffort(value: unknown, param: string): void {
  if (!isString(value) || !['low', 'medium', 'high', 'max'].includes(value)) {
    invalid(param, `${param} must be low, medium, high, or max`);
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

function validateOptionalNonNegativeInteger(value: unknown, param: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
    invalid(param, `${param} must be a non-negative integer`);
  }
}

function requirePositiveInteger(value: unknown, param: string): number {
  if (value === undefined) {
    missing(param, `${param} is required`);
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    invalid(param, `${param} must be a positive integer`);
  }
  return value as number;
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

function requireExactNonEmptyString(value: unknown, param: string): string {
  const normalized = requireNonEmptyString(value, param);
  if (value !== normalized) {
    invalid(param, `${param} must not contain leading or trailing whitespace`);
  }
  return normalized;
}

function missing(param: string, message: string): never {
  throw new AnthropicRequestValidationError(message, param, 'missing_required_parameter');
}

function invalid(param: string, message: string): never {
  throw new AnthropicRequestValidationError(message, param, 'invalid_value');
}

function unsupported(param: string, message: string): never {
  throw new AnthropicRequestValidationError(message, param, 'unsupported_parameter');
}
