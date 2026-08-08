import { isEmpty, isNil, isString } from 'lodash-es';
import { ApplyPatchFailureCompactor } from '../../../../antigravity/ApplyPatchFailureCompaction';
import { toCustomToolArguments } from '../../../../antigravity/CustomToolCall';
import { asString, toRecord } from '../../../common/utils/json-record';
import type {
  OpenAIChatRequest,
  OpenAIToolCall,
} from '../../../common/interfaces/request-interfaces';
import type { OpenAIResponsesResponseContext } from '../../../../antigravity/OpenAIResponsesResponseMapper';
import {
  mapResponsesReasoningEffort,
  normalizeOpenAIResponsesRequest,
  type ResponsesRequestBody,
} from './openai-responses-request-contract';
import {
  mergeOpenAIResponsesInputItems,
  normalizeOpenAIResponsesInputItems,
  type OpenAIResponsesSession,
  type OpenAIResponsesSessionStoreLike,
} from './openai-responses-session.store';
import {
  normalizeResponsesInput,
  normalizeResponsesMessageContent,
  normalizeResponsesOutput,
  resolveToolArguments,
} from './openai-responses-input-normalizers';

export interface PreparedResponsesRequest {
  request: OpenAIChatRequest;
  responseContext: OpenAIResponsesResponseContext;
  session: OpenAIResponsesSession;
}

/**
 * Turns a `/v1/responses` body into the chat request the proxy actually serves,
 * the context needed to render the answer back in Responses shape, and the
 * session to store it under.
 *
 * Returns null when the body names a `previous_response_id` the store does not
 * know, which the caller answers as a 404 rather than silently starting a new
 * chain.
 */
export function prepareResponsesRequest(
  body: ResponsesRequestBody,
  sessions: OpenAIResponsesSessionStoreLike,
): PreparedResponsesRequest | null {
  const normalizedBody = normalizeOpenAIResponsesRequest(body);
  const currentInputItems = normalizeOpenAIResponsesInputItems(normalizedBody.input);
  const previousSession = normalizedBody.previous_response_id
    ? sessions.get(normalizedBody.previous_response_id)
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
  const request = buildResponsesChatRequest({
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

/**
 * Replays a Responses item list as a Chat Completions message list.
 *
 * 1. First pass indexes call ids to tool names, because an output item can
 *    precede nothing but still needs the name its call carried.
 * 2. Second pass emits the messages, skipping the calls an `incomplete`
 *    `custom_tool_call` opened — replaying those would ask the model to answer
 *    a call the client abandoned.
 */
function buildResponsesChatRequest(body: ResponsesRequestBody): OpenAIChatRequest {
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
      const itemObj = toRecord(item);
      if (!itemObj) {
        continue;
      }

      const type = asString(itemObj.type);
      if (!type) {
        continue;
      }

      if (
        type === 'function_call' ||
        type === 'local_shell_call' ||
        type === 'web_search_call' ||
        type === 'custom_tool_call'
      ) {
        const callId = asString(itemObj.call_id) ?? asString(itemObj.id) ?? `call_${Date.now()}`;
        if (
          type === 'custom_tool_call' &&
          asString(itemObj.status)?.toLowerCase() === 'incomplete'
        ) {
          incompleteCustomCallIds.add(callId);
          continue;
        }

        const toolName =
          type === 'local_shell_call'
            ? 'shell'
            : type === 'web_search_call'
              ? 'builtin_web_search'
              : (asString(itemObj.name) ?? 'unknown');
        callIdToToolName.set(callId, toolName);
      }
    }

    for (const item of inputItems) {
      const itemObj = toRecord(item);
      if (!itemObj) {
        continue;
      }

      const type = asString(itemObj.type);
      if (!type) {
        continue;
      }

      if (type === 'message') {
        const role = asString(itemObj.role) ?? 'user';
        const content = normalizeResponsesMessageContent(itemObj.content);
        messages.push({ role, content });
        continue;
      }

      if (
        type === 'function_call' ||
        type === 'local_shell_call' ||
        type === 'web_search_call' ||
        type === 'custom_tool_call'
      ) {
        const callId = asString(itemObj.call_id) ?? asString(itemObj.id) ?? `call_${Date.now()}`;
        if (incompleteCustomCallIds.has(callId)) {
          continue;
        }

        const toolName = callIdToToolName.get(callId) ?? 'unknown';
        const customInput =
          type === 'custom_tool_call' ? (asString(itemObj.input) ?? '') : undefined;
        const args =
          customInput === undefined
            ? resolveToolArguments(type, itemObj)
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
        const callId = asString(itemObj.call_id) ?? asString(itemObj.id) ?? 'unknown';
        if (incompleteCustomCallIds.has(callId)) {
          continue;
        }
        if (type === 'custom_tool_call_output' && !callIdToToolName.has(callId)) {
          continue;
        }

        const toolName = callIdToToolName.get(callId) ?? 'unknown';
        const normalizedOutput = normalizeResponsesOutput(itemObj.output);
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
      content: normalizeResponsesInput(body.input),
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
    response_format: toResponsesChatResponseFormat(body.text),
    store: body.store,
    metadata: body.metadata as Record<string, string> | undefined,
    service_tier: body.service_tier,
    user: body.user,
    stream: body.stream,
    extra: {
      ...(body.metadata ?? {}),
      include: body.include,
      previous_response_id: body.previous_response_id,
      text_verbosity: asString(body.text?.verbosity) ?? undefined,
      truncation: body.truncation,
      user_id: body.user,
    },
  };
}

function toResponsesChatResponseFormat(
  text: Record<string, unknown> | undefined,
): OpenAIChatRequest['response_format'] {
  const format = toRecord(text?.format);
  if (!format) {
    return undefined;
  }
  const type = asString(format.type);
  if (type !== 'json_schema') {
    return type ? { type } : undefined;
  }
  return {
    type,
    json_schema: {
      name: asString(format.name) ?? undefined,
      description: asString(format.description) ?? undefined,
      schema: toRecord(format.schema) ?? undefined,
      strict: typeof format.strict === 'boolean' ? format.strict : undefined,
    },
  };
}
