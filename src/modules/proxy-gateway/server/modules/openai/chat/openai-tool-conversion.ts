import { isPlainObject, isString } from 'lodash-es';

import {
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
} from '../../../../antigravity/anthropic-web-search-blocks';
import { isCustomToolCall } from '../../../../antigravity/CustomToolCall';
import { normalizeObjectJsonSchema } from '../../../../antigravity/JsonSchemaUtils';
import { flattenOpenAITools } from '../../../../antigravity/ToolNamespace';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '../../../common/interfaces/request-interfaces';

/**
 * OpenAI tool declarations, restated as Anthropic ones.
 *
 * Both OpenAI-shaped surfaces funnel through the Anthropic request mapper, so
 * this is the single place where an OpenAI caller's search request — however it
 * spelled it — becomes the one server tool the upstream can serve.
 */

/** Every spelling either OpenAI surface uses for the built-in search tool. */
const SEARCH_TOOL_TYPES = new Set([
  'web_search_20250305',
  'web_search',
  'web_search_preview',
  'web_search_preview_2025_03_11',
  'web_search_2025_08_26',
  'google_search',
  'google_search_retrieval',
  'builtin_web_search',
]);

const APPLY_PATCH_SCHEMA = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      description:
        'The exact freeform V4A patch text to pass to Codex apply_patch. It must start with *** Begin Patch and end with *** End Patch. Do not wrap it in a shell command or command array.',
    },
  },
  required: ['input'],
};

const FALLBACK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    content: {
      type: 'string',
      description: 'The raw content or patch to be applied',
    },
  },
  required: ['content'],
};

function webSearchTool(name: string): NonNullable<AnthropicChatRequest['tools']>[number] {
  return {
    name,
    type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
    input_schema: { type: 'object', properties: {} },
  };
}

export function convertOpenAIToolsToAnthropicTools(
  tools: OpenAIChatRequest['tools'],
  webSearchOptions = false,
): AnthropicChatRequest['tools'] {
  if ((!tools || tools.length === 0) && !webSearchOptions) {
    return undefined;
  }

  const result: NonNullable<AnthropicChatRequest['tools']> = [];
  if (webSearchOptions) {
    // `web_search_options` is Chat Completions' switch for the same built-in
    // search the Responses and Anthropic surfaces declare as a tool, so it
    // becomes one here and rides the single existing mapping into
    // `{ googleSearch: {} }`.
    result.push(webSearchTool(ANTHROPIC_WEB_SEARCH_TOOL_NAME));
  }

  for (const tool of flattenOpenAITools(tools) ?? []) {
    if (!tool) {
      continue;
    }

    const toolType = isString(tool.type) ? tool.type.toLowerCase() : '';
    const functionName = isString(tool.function?.name)
      ? tool.function.name
      : isString(tool.name)
        ? tool.name
        : '';
    const isSearchTool =
      SEARCH_TOOL_TYPES.has(toolType) || SEARCH_TOOL_TYPES.has(functionName.toLowerCase());

    if (isSearchTool) {
      // One search tool only: a request may name it both in `tools` and through
      // `web_search_options`, and two entries would be mapped into two
      // `googleSearch` tools the upstream rejects.
      if (!result.some((declared) => declared.type === ANTHROPIC_WEB_SEARCH_TOOL_TYPE)) {
        result.push(webSearchTool(functionName || 'builtin_web_search'));
      }
      continue;
    }

    if (!functionName) {
      continue;
    }

    const parameters = isCustomToolCall(functionName)
      ? APPLY_PATCH_SCHEMA
      : (tool.function?.parameters ??
        (isPlainObject(tool.parameters)
          ? (tool.parameters as Record<string, unknown>)
          : FALLBACK_TOOL_SCHEMA));

    result.push({
      name: functionName,
      description:
        tool.function?.description ?? (isString(tool.description) ? tool.description : undefined),
      input_schema: normalizeObjectJsonSchema(parameters),
    });
  }

  return result.length > 0 ? result : undefined;
}
