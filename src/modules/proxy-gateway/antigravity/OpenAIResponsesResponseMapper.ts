import type {
  OpenAIChatResponse,
  OpenAIToolCall,
} from '../server/common/interfaces/request-interfaces';
import { optimizeApplyPatch, validateApplyPatchV4A } from './ApplyPatchPreflight';
import { extractCustomToolInput, isCustomToolCall } from './CustomToolCall';
import { toOpenAIResponsesUsage } from './OpenAIUsageMapper';

type ResponsesToolOutput =
  | {
      diagnostic: string;
    }
  | {
      item: Record<string, unknown>;
    };

export interface OpenAIResponsesResponseContext {
  instructions?: string;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
  parallelToolCalls?: boolean;
  previousResponseId?: string;
  reasoning?: Record<string, unknown>;
  store?: boolean;
  temperature?: number;
  text?: Record<string, unknown>;
  toolChoice?: unknown;
  tools?: unknown[];
  topP?: number;
  truncation?: string;
}

type ResponsesOutputStatus = 'completed' | 'incomplete';

function toResponsesToolOutputItem(
  toolCall: OpenAIToolCall,
  status: ResponsesOutputStatus,
): ResponsesToolOutput {
  const functionCall = toolCall.function ?? {
    name: 'apply_patch',
    arguments: JSON.stringify(toolCall.operation ?? {}),
  };
  const callId = toolCall.call_id ?? toolCall.id;
  const namespaceFields = toolCall.namespace ? { namespace: toolCall.namespace } : {};
  if (toolCall.custom_input !== undefined || isCustomToolCall(functionCall.name)) {
    const rawInput =
      toolCall.custom_input ??
      extractCustomToolInput(functionCall.name, parseToolArguments(functionCall.arguments));
    const input = isCustomToolCall(functionCall.name)
      ? optimizeApplyPatch(rawInput).input
      : rawInput;
    if (isCustomToolCall(functionCall.name)) {
      const validationError = validateApplyPatchV4A(input);
      if (validationError) {
        return {
          diagnostic: `[apply_patch rejected: invalid V4A syntax at line ${validationError.line}: ${validationError.message}]`,
        };
      }
    }

    return {
      item: {
        call_id: callId,
        id: toolCall.id,
        input,
        name: functionCall.name,
        ...namespaceFields,
        status,
        type: 'custom_tool_call',
      },
    };
  }

  return {
    item: {
      arguments: functionCall.arguments,
      call_id: callId,
      id: toolCall.id,
      name: functionCall.name,
      ...namespaceFields,
      status,
      type: 'function_call',
    },
  };
}

function parseToolArguments(argumentsString: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsString);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Raw apply_patch input is handled by extractCustomToolInput's string fallback.
  }

  return {
    input: argumentsString,
  };
}

export function toOpenAIResponsesId(id: string): string {
  if (id.startsWith('resp_')) {
    return id;
  }
  const chatCompletionMatch = /^chatcmpl[-_](.+)$/.exec(id);
  return chatCompletionMatch ? `resp_${chatCompletionMatch[1]}` : `resp_${id}`;
}

export function toOpenAIResponsesResponse(
  response: OpenAIChatResponse,
  context: OpenAIResponsesResponseContext = {},
): Record<string, unknown> {
  const choice = response.choices[0];
  const output: Record<string, unknown>[] = [];
  const content = choice?.message.content;
  const reasoningContent = choice?.message.reasoning_content;
  const refusal = choice?.message.refusal;
  const responseId = toOpenAIResponsesId(response.id);
  const incompleteReason = toIncompleteReason(choice?.finish_reason);
  const status: ResponsesOutputStatus = incompleteReason ? 'incomplete' : 'completed';

  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
    output.push({
      content: [{ text: reasoningContent, type: 'reasoning_text' }],
      id: `rs_${responseId.slice('resp_'.length)}`,
      status,
      summary: [{ text: reasoningContent, type: 'summary_text' }],
      type: 'reasoning',
    });
  }

  if ((typeof content === 'string' && content.length > 0) || refusal) {
    output.push({
      content: refusal
        ? [
            {
              refusal,
              type: 'refusal',
            },
          ]
        : [
            {
              annotations: [],
              text: content,
              type: 'output_text',
            },
          ],
      id: `msg_${responseId.slice('resp_'.length)}`,
      role: 'assistant',
      status,
      type: 'message',
    });
  }

  for (const toolCall of choice?.message.tool_calls ?? []) {
    const mapped = toResponsesToolOutputItem(toolCall, status);
    if ('diagnostic' in mapped) {
      output.push({
        content: [{ annotations: [], text: mapped.diagnostic, type: 'output_text' }],
        id: `msg_${toolCall.id}`,
        role: 'assistant',
        status,
        type: 'message',
      });
    } else {
      output.push(mapped.item);
    }
  }

  return {
    background: false,
    created_at: response.created,
    error: null,
    id: responseId,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    instructions: context.instructions ?? null,
    max_output_tokens: context.maxOutputTokens ?? null,
    metadata: context.metadata ?? {},
    model: response.model,
    object: 'response',
    output,
    parallel_tool_calls: context.parallelToolCalls ?? true,
    previous_response_id: context.previousResponseId ?? null,
    reasoning: context.reasoning ?? null,
    status,
    store: context.store ?? true,
    temperature: context.temperature,
    text: context.text,
    tool_choice: context.toolChoice,
    tools: context.tools ?? [],
    top_p: context.topP,
    truncation: context.truncation ?? 'disabled',
    type: 'response',
    usage: response.usage ? toOpenAIResponsesUsage(response.usage) : undefined,
  };
}

function toIncompleteReason(finishReason: string | null | undefined): string | null {
  const normalized = finishReason?.toLowerCase();
  if (normalized === 'length' || normalized === 'max_tokens') {
    return 'max_output_tokens';
  }
  if (
    normalized === 'content_filter' ||
    normalized === 'safety' ||
    normalized === 'recitation' ||
    normalized === 'blocklist' ||
    normalized === 'prohibited_content' ||
    normalized === 'spii'
  ) {
    return 'content_filter';
  }
  return null;
}
