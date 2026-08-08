import { isPlainObject, isString } from 'lodash-es';

import { ANTHROPIC_WEB_SEARCH_TOOL_TYPE } from '../../../antigravity/anthropic-web-search-blocks';

/**
 * The `tools` allow-list for `POST /v1/messages`.
 *
 * The contract used to reject every entry carrying a `type`, which was wrong in
 * both directions. It rejected `{"type":"custom", ...}` — an ordinary
 * client-side tool in Anthropic's own spec — and it rejected the one server
 * tool this transport can genuinely serve, `web_search_20250305`, which maps
 * onto the upstream `{ googleSearch: {} }` tool.
 *
 * Everything else stays rejected, but by name and with the measured reason.
 * `code_execution` and `web_fetch` are the interesting cases: the upstream
 * accepts `codeExecution` and `urlContext` with a 200 and then serves neither
 * (no `executableCode` part; `CANNOT_FETCH` for URLs). Forwarding them would
 * turn a capability the caller asked for into an answer that quietly lacks it.
 *
 * The failure helpers are injected rather than imported so this module does not
 * have to import back from the contract that imports it.
 */

/** Raising side of the contract, supplied by the caller. */
export interface AnthropicContractFailures {
  invalid(param: string, message: string): never;
  unsupported(param: string, message: string): never;
  /** Validates a `cache_control` object, or throws through the helpers above. */
  validateCacheControl(value: unknown, param: string): void;
}

export interface AnthropicWebSearchToolRequest {
  /** Name the client gave the tool; echoed back on the `server_tool_use` block. */
  name: string;
  /**
   * Honoured rather than rejected: this transport issues at most one upstream
   * search per request, so any bound of one or more is satisfied by
   * construction. It is kept so the value can be reported back untouched.
   */
  maxUses?: number;
}

export interface AnthropicToolsValidation {
  /** Declared tool names, for `tool_choice` cross-checking. */
  names: Set<string>;
  webSearch: AnthropicWebSearchToolRequest | null;
}

const CLIENT_TOOL_FIELDS = [
  'cache_control',
  'defer_loading',
  'description',
  'input_schema',
  'name',
  'strict',
  'type',
] as const;

const WEB_SEARCH_TOOL_FIELDS = [
  'allowed_domains',
  'blocked_domains',
  'cache_control',
  'max_uses',
  'name',
  'type',
  'user_location',
] as const;

/**
 * Why each rejected server tool is rejected.
 *
 * Prefix-matched because Anthropic versions the types (`code_execution_20250522`,
 * `text_editor_20250728`, …) and a new date suffix must not turn a considered
 * rejection into an "unknown tool" shrug.
 */
const UNSUPPORTED_SERVER_TOOLS: ReadonlyArray<{ prefix: string; reason: string }> = [
  {
    prefix: 'code_execution',
    reason:
      'the upstream accepts a codeExecution tool and then returns no executableCode or codeExecutionResult parts, so the tool is not actually served',
  },
  {
    prefix: 'bash_code_execution',
    reason:
      'the upstream accepts a codeExecution tool and then returns no executableCode or codeExecutionResult parts, so the tool is not actually served',
  },
  {
    prefix: 'text_editor_code_execution',
    reason:
      'the upstream accepts a codeExecution tool and then returns no executableCode or codeExecutionResult parts, so the tool is not actually served',
  },
  {
    prefix: 'web_fetch',
    reason:
      'the upstream accepts a urlContext tool and then answers CANNOT_FETCH, so page fetching is not actually served',
  },
  {
    prefix: 'computer_',
    reason: 'the Gemini transport exposes no computer-use surface',
  },
  {
    prefix: 'bash_',
    reason: 'the Gemini transport exposes no server-side shell',
  },
  {
    prefix: 'text_editor_',
    reason: 'the Gemini transport exposes no server-side text editor',
  },
  {
    prefix: 'memory',
    reason: 'the Gemini transport exposes no server-side memory store',
  },
];

function describeUnsupportedServerTool(type: string): string {
  const known = UNSUPPORTED_SERVER_TOOLS.find((entry) => type.startsWith(entry.prefix));
  return known
    ? `server tool ${type} is not supported: ${known.reason}`
    : `server tool ${type} is not supported by the Gemini compatibility transport`;
}

export function validateAnthropicTools(
  value: unknown,
  fail: AnthropicContractFailures,
): AnthropicToolsValidation {
  const names = new Set<string>();
  let webSearch: AnthropicWebSearchToolRequest | null = null;

  if (value === undefined) {
    return { names, webSearch };
  }
  if (!Array.isArray(value)) {
    fail.invalid('tools', 'tools must be an array');
  }

  for (const [index, toolValue] of value.entries()) {
    const param = `tools.${index}`;
    if (!isPlainObject(toolValue)) {
      fail.invalid(param, `${param} must be an object`);
    }
    const tool = toolValue as Record<string, unknown>;
    const type = tool.type;
    if (type !== undefined && !isString(type)) {
      fail.invalid(`${param}.type`, `${param}.type must be a string`);
    }

    if (isString(type) && type === ANTHROPIC_WEB_SEARCH_TOOL_TYPE) {
      if (webSearch) {
        fail.invalid(`${param}.type`, 'web search may only be declared once');
      }
      webSearch = validateWebSearchTool(tool, param, fail);
      registerName(names, webSearch.name, param, fail);
      continue;
    }

    if (isString(type) && type !== 'custom') {
      fail.unsupported(`${param}.type`, describeUnsupportedServerTool(type));
    }

    registerName(names, requireToolName(tool.name, `${param}.name`, fail), param, fail);
    validateClientTool(tool, param, fail);
  }

  return { names, webSearch };
}

function registerName(
  names: Set<string>,
  name: string,
  param: string,
  fail: AnthropicContractFailures,
): void {
  if (names.has(name)) {
    fail.invalid(`${param}.name`, `duplicate tool name: ${name}`);
  }
  names.add(name);
}

function validateClientTool(
  tool: Record<string, unknown>,
  param: string,
  fail: AnthropicContractFailures,
): void {
  rejectUnknownFields(tool, param, CLIENT_TOOL_FIELDS, fail);
  if (tool.description !== undefined && !isString(tool.description)) {
    fail.invalid(`${param}.description`, `${param}.description must be a string`);
  }
  if (!isPlainObject(tool.input_schema)) {
    fail.invalid(`${param}.input_schema`, `${param}.input_schema must be an object`);
  }
  fail.validateCacheControl(tool.cache_control, `${param}.cache_control`);
  if (tool.strict !== undefined) {
    fail.unsupported(`${param}.strict`, 'strict tool schema enforcement is not available upstream');
  }
  if (tool.defer_loading !== undefined) {
    fail.unsupported(`${param}.defer_loading`, 'deferred tool loading is not available upstream');
  }
}

function validateWebSearchTool(
  tool: Record<string, unknown>,
  param: string,
  fail: AnthropicContractFailures,
): AnthropicWebSearchToolRequest {
  rejectUnknownFields(tool, param, WEB_SEARCH_TOOL_FIELDS, fail);
  const name = requireToolName(tool.name, `${param}.name`, fail);
  fail.validateCacheControl(tool.cache_control, `${param}.cache_control`);

  // Rejected, not dropped. `googleSearch` takes no parameters upstream, so none
  // of these can be enforced, and a search that quietly ignored a domain filter
  // would be worse than one that never ran.
  if (tool.allowed_domains !== undefined) {
    fail.unsupported(
      `${param}.allowed_domains`,
      'the upstream googleSearch tool has no domain allow-list, so allowed_domains cannot be enforced',
    );
  }
  if (tool.blocked_domains !== undefined) {
    fail.unsupported(
      `${param}.blocked_domains`,
      'the upstream googleSearch tool has no domain block-list, so blocked_domains cannot be enforced',
    );
  }
  if (tool.user_location !== undefined) {
    fail.unsupported(
      `${param}.user_location`,
      'the upstream googleSearch tool takes no user location, so user_location cannot be applied',
    );
  }

  let maxUses: number | undefined;
  if (tool.max_uses !== undefined) {
    if (!Number.isInteger(tool.max_uses) || (tool.max_uses as number) < 1) {
      fail.invalid(`${param}.max_uses`, `${param}.max_uses must be a positive integer`);
    }
    maxUses = tool.max_uses as number;
  }

  return { name, ...(maxUses === undefined ? {} : { maxUses }) };
}

function requireToolName(value: unknown, param: string, fail: AnthropicContractFailures): string {
  if (!isString(value) || value.trim().length === 0) {
    fail.invalid(param, `${param} is required and must be a non-empty string`);
  }
  if (value !== value.trim()) {
    fail.invalid(param, `${param} must not contain leading or trailing whitespace`);
  }
  return value;
}

function rejectUnknownFields(
  tool: Record<string, unknown>,
  param: string,
  allowedFields: readonly string[],
  fail: AnthropicContractFailures,
): void {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(tool)) {
    if (!allowed.has(field)) {
      fail.unsupported(`${param}.${field}`, `${param}.${field} is not implemented by this proxy`);
    }
  }
}
