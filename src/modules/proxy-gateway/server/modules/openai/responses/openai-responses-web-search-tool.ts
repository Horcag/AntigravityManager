import { isPlainObject, isString } from 'lodash-es';

import type { OpenAITool } from '../../../common/interfaces/request-interfaces';

/**
 * Hosted-tool handling for `POST /v1/responses`.
 *
 * `{"type":"web_search"}` and its older `web_search_preview` spellings map onto
 * the upstream `{ googleSearch: {} }` tool. Everything else OpenAI hosts —
 * file search, the code interpreter, image generation, computer use, remote MCP
 * — has no upstream counterpart at all, and until now fell through the tool
 * converter and was dropped without a word. A caller that asked for a hosted
 * tool and got an answer produced without it cannot tell the difference, so
 * these are rejected by name instead.
 */

export interface OpenAIResponsesToolFailures {
  invalid(param: string, message: string): never;
  unsupported(param: string, message: string): never;
}

/** Every spelling of the search tool this surface accepts. */
export const RESPONSES_WEB_SEARCH_TOOL_TYPES: ReadonlySet<string> = new Set([
  'web_search',
  'web_search_preview',
  'web_search_preview_2025_03_11',
  'web_search_2025_08_26',
]);

/**
 * Hosted tools with no client-side meaning at all, so a dropped one is simply
 * gone. `local_shell` and MCP tools are deliberately absent: those name work the
 * client performs, and this proxy already maps them onto ordinary tool calls.
 */
const UNSUPPORTED_HOSTED_TOOLS: ReadonlyArray<{ type: string; reason: string }> = [
  {
    type: 'code_interpreter',
    reason:
      'the upstream accepts a codeExecution tool and then returns no executableCode or codeExecutionResult parts, so the tool is not actually served',
  },
  { type: 'file_search', reason: 'this proxy hosts no vector stores to search' },
  {
    type: 'image_generation',
    reason: 'image generation is served by /v1/images, not as a Responses tool',
  },
  { type: 'computer_use_preview', reason: 'the Gemini transport exposes no computer-use surface' },
];

/**
 * Validates the `tools` array and reports whether search was requested.
 *
 * Only the hosted types are judged here: ordinary `function` and `custom` tools
 * keep flowing through the existing converter untouched.
 */
export function validateResponsesTools(
  tools: OpenAITool[] | undefined,
  fail: OpenAIResponsesToolFailures,
): boolean {
  let webSearch = false;

  for (const [index, tool] of (tools ?? []).entries()) {
    const param = `tools.${index}`;
    if (!isPlainObject(tool)) {
      fail.invalid(param, `${param} must be an object`);
    }
    const type = (tool as OpenAITool).type;
    if (!isString(type)) {
      continue;
    }

    if (RESPONSES_WEB_SEARCH_TOOL_TYPES.has(type)) {
      validateWebSearchToolOptions(tool as Record<string, unknown>, param, fail);
      webSearch = true;
      continue;
    }

    const unsupportedTool = UNSUPPORTED_HOSTED_TOOLS.find((entry) => entry.type === type);
    if (unsupportedTool) {
      fail.unsupported(
        `${param}.type`,
        `hosted tool ${type} is not supported: ${unsupportedTool.reason}`,
      );
    }
  }

  return webSearch;
}

function validateWebSearchToolOptions(
  tool: Record<string, unknown>,
  param: string,
  fail: OpenAIResponsesToolFailures,
): void {
  // Rejected, not dropped: `googleSearch` takes no parameters upstream.
  if (tool.search_context_size !== undefined) {
    fail.unsupported(
      `${param}.search_context_size`,
      'the upstream googleSearch tool has no context-size control, so search_context_size cannot be applied',
    );
  }
  if (tool.user_location !== undefined) {
    fail.unsupported(
      `${param}.user_location`,
      'the upstream googleSearch tool takes no user location, so user_location cannot be applied',
    );
  }
  if (tool.filters !== undefined) {
    fail.unsupported(
      `${param}.filters`,
      'the upstream googleSearch tool has no domain filters, so filters cannot be enforced',
    );
  }
  for (const field of Object.keys(tool)) {
    if (!['filters', 'search_context_size', 'type', 'user_location'].includes(field)) {
      fail.unsupported(`${param}.${field}`, `${param}.${field} is not implemented by this proxy`);
    }
  }
}
