import { isEmpty, isPlainObject, isString } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import { toCustomToolArguments } from '../../../../antigravity/CustomToolCall';
import { sanitizeSystemInstructionForCache } from '../../../../antigravity/StablePromptPrefix';
import { flattenOpenAITools } from '../../../../antigravity/ToolNamespace';
import type { ClaudeRequest } from '../../../../antigravity/types';
import type {
  AnthropicContent,
  OpenAIChatRequest,
} from '../../../common/interfaces/request-interfaces';
import { convertOpenAIToolsToAnthropicTools } from './openai-tool-conversion';

/**
 * Restates an OpenAI chat body as the internal `ClaudeRequest`.
 *
 * The proxy has exactly one upstream shape, so both public surfaces converge
 * here first. System and developer turns collapse into one deduplicated system
 * prompt because the provider takes a single system instruction, and tool
 * results become the `tool_result` user blocks the Anthropic shape uses.
 */
export function convertOpenAIToClaude(
  request: OpenAIChatRequest,
  signatureSessionKey?: string,
): ClaudeRequest {
  const messages = request.messages || [];
  const systemPromptParts: string[] = [];
  const seenSystemPromptKeys = new Set<string>();
  const anthropicMessages: ClaudeRequest['messages'] = [];
  const addSystemPrompt = (text: string) => {
    const trimmed = text.trim();
    const key = sanitizeSystemInstructionForCache(trimmed).split(/\s+/).join(' ');
    if (key && !seenSystemPromptKeys.has(key)) {
      seenSystemPromptKeys.add(key);
      systemPromptParts.push(trimmed);
    }
  };

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const systemText = extractOpenAITextContent(msg.content);
      if (systemText) {
        addSystemPrompt(systemText);
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolResultText = extractOpenAITextContent(msg.content) || '';
      anthropicMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || msg.name || `tool-result-${uuidv4()}`,
            content: toolResultText,
            is_error: false,
          },
        ],
      });
      continue;
    }

    const contentBlocks = convertOpenAIPartsToAnthropicContent(msg.content);

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        const functionName =
          toolCall.function?.name ??
          (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
        if (!functionName) {
          continue;
        }
        contentBlocks.push({
          type: 'tool_use',
          id: toolCall.call_id || toolCall.id,
          name: functionName,
          input:
            toolCall.custom_input === undefined
              ? (toolCall.operation ??
                parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'))
              : toCustomToolArguments(functionName, toolCall.custom_input),
        });
      }
    }

    anthropicMessages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: contentBlocks.length > 0 ? contentBlocks : '',
    });
  }

  const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join('\n') : undefined;

  return {
    model: request.model,
    messages: anthropicMessages,
    system: systemPrompt,
    tools: convertOpenAIToolsToAnthropicTools(
      request.tools,
      request.web_search_options !== undefined,
    ),
    thinking: request.thinking
      ? {
          type: request.thinking.type ?? 'enabled',
          budget_tokens: request.thinking.budget_tokens,
          effort: request.thinking.effort,
        }
      : undefined,
    max_tokens: request.max_completion_tokens ?? request.max_tokens,
    candidate_count: request.n,
    stop_sequences: typeof request.stop === 'string' ? [request.stop] : request.stop,
    temperature: request.temperature,
    top_p: request.top_p,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    seed: request.seed,
    response_format: request.response_format,
    response_logprobs: request.logprobs,
    top_logprobs: request.top_logprobs,
    tool_choice: request.tool_choice,
    stream: request.stream,
    metadata: {
      ...(request.metadata ?? {}),
      ...(request.extra ?? {}),
      ...(request.user ? { user_id: request.user } : {}),
      source: 'openai',
      signature_session_key: signatureSessionKey,
    },
  };
}

export function convertOpenAIPartsToAnthropicContent(
  content: OpenAIChatRequest['messages'][number]['content'],
): AnthropicContent[] {
  if (isString(content)) {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: AnthropicContent[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url;
      const dataUri = url.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
      if (dataUri?.groups?.mime && dataUri.groups.data) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: dataUri.groups.mime,
            data: dataUri.groups.data,
          },
        });
      } else {
        blocks.push({ type: 'text', text: `[image_url] ${url}` });
      }
      continue;
    }

    if (part.type === 'file' && part.file?.file_data) {
      // Expanded file handles arrive here as a base64 data URL. Images keep
      // their image block; anything else becomes a document block, which the
      // Claude mapper turns into the same `inlineData` part either way.
      const dataUri = part.file.file_data.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
      if (dataUri?.groups?.mime && dataUri.groups.data) {
        const source = {
          type: 'base64' as const,
          media_type: dataUri.groups.mime,
          data: dataUri.groups.data,
        };
        blocks.push(
          dataUri.groups.mime.startsWith('image/')
            ? { type: 'image', source }
            : {
                type: 'document',
                source,
                ...(part.file.filename ? { title: part.file.filename } : {}),
              },
        );
      }
    }
  }
  return blocks;
}

export function extractOpenAITextContent(
  content: OpenAIChatRequest['messages'][number]['content'],
): string {
  if (isString(content)) {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n');
}

export function parseOpenAIFunctionArguments(argumentsString: string): Record<string, unknown> {
  if (isEmpty(argumentsString.trim())) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsString);
    if (isPlainObject(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: argumentsString };
  }
}

/**
 * The tool names the client actually declared.
 *
 * Used to map a namespaced upstream tool name back to the name the caller will
 * recognise, so a renamed shell tool still matches its own declaration.
 */
export function extractOpenAIToolNames(tools: OpenAIChatRequest['tools']): ReadonlySet<string> {
  const names = new Set<string>();

  for (const tool of flattenOpenAITools(tools) ?? []) {
    const name = isString(tool.function?.name)
      ? tool.function.name
      : isString(tool.name)
        ? tool.name
        : undefined;
    if (name) {
      names.add(name);
    }
  }

  return names;
}

/** See {@link extractAnthropicSessionKey}: the same key, from the OpenAI shape. */
export function extractOpenAISessionKey(request: OpenAIChatRequest): string | undefined {
  const metadata = request.metadata;
  const extra = request.extra;
  const sessionCandidate =
    request.user ??
    metadata?.session_id ??
    metadata?.sessionId ??
    metadata?.user_id ??
    metadata?.userId ??
    extra?.session_id ??
    extra?.sessionId ??
    extra?.user_id ??
    extra?.userId;
  if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
    return undefined;
  }
  return `openai:${sessionCandidate.trim()}`;
}
