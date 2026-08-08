import { isPlainObject } from 'lodash-es';

import type { OpenAIChatRequest } from '../../../common/interfaces/request-interfaces';
import { OpenAIRequestValidationError } from '../chat/openai-request-contract';

export interface ResponsesRequestBody {
  background?: boolean;
  include?: string[];
  model?: string;
  instructions?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  previous_response_id?: string;
  parallel_tool_calls?: boolean;
  reasoning?: {
    effort?: string;
    summary?: string;
  };
  store?: boolean;
  text?: Record<string, unknown>;
  tools?: OpenAIChatRequest['tools'];
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  service_tier?: string;
  tool_choice?: OpenAIChatRequest['tool_choice'];
  stream?: boolean;
  truncation?: string;
  user?: string;
}

export function normalizeOpenAIResponsesRequest(
  request: ResponsesRequestBody,
): ResponsesRequestBody {
  const raw = asRecord(request, 'body');
  const model = normalizeOptionalNonEmptyString(raw.model, 'model');
  const previousResponseId = normalizeOptionalNonEmptyString(
    raw.previous_response_id,
    'previous_response_id',
  );
  if (!model && !previousResponseId) {
    missing('model', 'model is required when previous_response_id is not supplied');
  }

  if (raw.input !== undefined && typeof raw.input !== 'string' && !Array.isArray(raw.input)) {
    invalid('input', 'input must be a string or an array of Responses input items');
  }
  validateOptionalString(raw.instructions, 'instructions');
  validateOptionalBoolean(raw.stream, 'stream');
  validateOptionalBoolean(raw.store, 'store');
  validateOptionalBoolean(raw.background, 'background');
  if (raw.background === true) {
    unsupported('background', 'background Responses are not implemented by this proxy');
  }
  validateOptionalBoolean(raw.parallel_tool_calls, 'parallel_tool_calls');
  if (raw.parallel_tool_calls === false && Array.isArray(raw.tools) && raw.tools.length > 0) {
    unsupported(
      'parallel_tool_calls',
      'parallel_tool_calls=false cannot be enforced by the Gemini transport',
    );
  }
  if (raw.tools !== undefined && !Array.isArray(raw.tools)) {
    invalid('tools', 'tools must be an array');
  }

  validateNumberRange(raw.temperature, 'temperature', 0, 2);
  validateNumberRange(raw.top_p, 'top_p', 0, 1);
  validateNumberRange(raw.presence_penalty, 'presence_penalty', -2, 2);
  validateNumberRange(raw.frequency_penalty, 'frequency_penalty', -2, 2);
  validatePositiveInteger(raw.max_output_tokens, 'max_output_tokens');
  validateOptionalInteger(raw.seed, 'seed');
  validateMetadata(raw.metadata);
  validateInclude(raw.include);
  validateReasoning(raw.reasoning);
  validateText(raw.text);
  validateOptionalString(raw.user, 'user');

  if (raw.truncation !== undefined) {
    if (raw.truncation !== 'disabled') {
      unsupported('truncation', 'only truncation=disabled is implemented by this proxy');
    }
  }
  if (
    raw.service_tier !== undefined &&
    (typeof raw.service_tier !== 'string' || !['auto', 'default'].includes(raw.service_tier))
  ) {
    unsupported('service_tier', 'only service_tier=auto/default is supported');
  }

  validateKnownFields(raw);
  return {
    ...(request as ResponsesRequestBody),
    ...(model ? { model } : {}),
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
  };
}

export interface OpenAIResponsesErrorBody {
  error: {
    code: string;
    message: string;
    param: string;
    type: string;
  };
}

/**
 * The error OpenAI returns when a response id is unknown or has aged out.
 *
 * Clients treat this as a protocol failure and start a fresh conversation
 * deliberately; silently serving an empty chain instead reads to the user as
 * the assistant losing its memory.
 */
export function buildResponseNotFoundError(
  responseId: string,
  param: 'id' | 'previous_response_id' = 'previous_response_id',
): OpenAIResponsesErrorBody {
  const subject = param === 'id' ? 'Response' : 'Previous response';
  return {
    error: {
      code: param === 'id' ? 'response_not_found' : 'previous_response_not_found',
      message: `${subject} with id '${responseId}' not found.`,
      param,
      type: 'invalid_request_error',
    },
  };
}

export function mapResponsesReasoningEffort(
  effort: string | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (effort === 'minimal' || effort === 'low') {
    return 'low';
  }
  if (effort === 'medium') {
    return 'medium';
  }
  if (effort === 'high' || effort === 'xhigh') {
    return 'high';
  }
  return undefined;
}

function validateKnownFields(raw: Record<string, unknown>): void {
  const known = new Set([
    'background',
    'frequency_penalty',
    'include',
    'input',
    'instructions',
    'max_output_tokens',
    'metadata',
    'model',
    'parallel_tool_calls',
    'presence_penalty',
    'previous_response_id',
    'reasoning',
    'seed',
    'service_tier',
    'store',
    'stream',
    'temperature',
    'text',
    'tool_choice',
    'tools',
    'top_p',
    'truncation',
    'user',
  ]);
  for (const field of Object.keys(raw)) {
    if (!known.has(field)) {
      unsupported(field, `${field} is not implemented by this Responses adapter`);
    }
  }
}

function validateReasoning(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const reasoning = asRecord(value, 'reasoning');
  if (
    reasoning.effort !== undefined &&
    (typeof reasoning.effort !== 'string' ||
      !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoning.effort))
  ) {
    unsupported(
      'reasoning.effort',
      'supported reasoning efforts are none, minimal, low, medium, high, and xhigh',
    );
  }
  if (
    reasoning.summary !== undefined &&
    (typeof reasoning.summary !== 'string' || reasoning.summary !== 'auto')
  ) {
    unsupported('reasoning.summary', 'only reasoning.summary=auto is supported');
  }
  for (const field of Object.keys(reasoning)) {
    if (field !== 'effort' && field !== 'summary') {
      unsupported(`reasoning.${field}`, `reasoning.${field} is not implemented`);
    }
  }
}

function validateText(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const text = asRecord(value, 'text');
  if (text.verbosity !== undefined) {
    if (typeof text.verbosity !== 'string' || !['low', 'medium', 'high'].includes(text.verbosity)) {
      invalid('text.verbosity', 'text.verbosity must be low, medium, or high');
    }
  }
  if (text.format !== undefined) {
    const format = asRecord(text.format, 'text.format');
    if (
      typeof format.type !== 'string' ||
      !['text', 'json_object', 'json_schema'].includes(format.type)
    ) {
      invalid('text.format.type', 'supported formats are text, json_object, and json_schema');
    }
    if (format.type === 'json_schema') {
      normalizeOptionalNonEmptyString(format.name, 'text.format.name', true);
      asRecord(format.schema, 'text.format.schema');
      validateOptionalBoolean(format.strict, 'text.format.strict');
    }
  }
  for (const field of Object.keys(text)) {
    if (field !== 'format' && field !== 'verbosity') {
      unsupported(`text.${field}`, `text.${field} is not implemented`);
    }
  }
}

function validateInclude(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    invalid('include', 'include must be an array of strings');
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
    if (typeof entry !== 'string') {
      invalid(`metadata.${key}`, 'metadata values must be strings');
    }
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

function validatePositiveInteger(value: unknown, param: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1)) {
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
  if (value !== undefined && typeof value !== 'string') {
    invalid(param, `${param} must be a string`);
  }
}

function normalizeOptionalNonEmptyString(
  value: unknown,
  param: string,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      missing(param, `${param} is required and must be a non-empty string`);
    }
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(param, `${param} must be a non-empty string`);
  }
  return value.trim();
}

function asRecord(value: unknown, param: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    invalid(param, `${param} must be an object`);
  }
  return value as Record<string, unknown>;
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
