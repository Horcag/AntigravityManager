import { isEmpty, isString } from 'lodash-es';
import type { ClaudeRequest, ClaudeResponse } from '../../../antigravity/types';
import type {
  AnthropicChatRequest,
  AnthropicChatResponse,
} from '../../common/interfaces/request-interfaces';

/**
 * Restates an `/v1/messages` body as the internal `ClaudeRequest` the Gemini
 * mapper consumes, carrying the session key that keys thought signatures.
 */
export function toClaudeRequest(
  request: AnthropicChatRequest,
  signatureSessionKey?: string,
): ClaudeRequest {
  return {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    system: request.system,
    tools: request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      type: tool.type,
    })),
    stream: request.stream,
    max_tokens: request.max_tokens,
    stop_sequences: request.stop_sequences,
    temperature: request.temperature,
    top_p: request.top_p,
    top_k: request.top_k,
    thinking: request.thinking,
    output_config: request.output_config,
    metadata: {
      ...(request.metadata ?? {}),
      signature_session_key: signatureSessionKey,
    },
  };
}

export function toAnthropicChatResponse(
  response: ClaudeResponse,
  fallbackModel: string,
): AnthropicChatResponse {
  return {
    id: response.id,
    type: response.type,
    role: response.role,
    model: response.model || fallbackModel,
    content:
      response.content.length === 0 && response.refusal
        ? [{ type: 'text', text: response.refusal }]
        : response.content,
    stop_reason: response.stop_reason,
    stop_sequence: response.stop_sequence,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
      cache_read_input_tokens: response.usage?.cache_read_input_tokens,
      ...(response.usage?.server_tool_use
        ? { server_tool_use: response.usage.server_tool_use }
        : {}),
    },
  };
}

/**
 * The key thought signatures are stored under for this caller.
 *
 * Signatures are only replayable to the account and conversation that produced
 * them, so a request without any session hint gets no key and no reuse.
 */
export function extractAnthropicSessionKey(request: AnthropicChatRequest): string | undefined {
  const metadata = request.metadata;
  const sessionCandidate =
    metadata?.session_id ?? metadata?.sessionId ?? metadata?.user_id ?? metadata?.userId;
  if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
    return undefined;
  }
  return `anthropic:${sessionCandidate.trim()}`;
}
