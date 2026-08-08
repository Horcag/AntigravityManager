import { createHash } from 'node:crypto';
import { isString, sortBy } from 'lodash-es';
import { normalizeObjectJsonSchema } from './JsonSchemaUtils';
import { logger } from '@/shared/logging/logger';
import type { ClaudeRequest, FunctionDeclaration, GeminiToolDeclaration, Tool } from './types';

const TOOL_SCHEMA_CACHE_LIMIT = 100;
const TOOL_SCHEMA_CACHE_TTL_MS = 30 * 60 * 1000;

interface ToolSchemaCacheEntry {
  declarationsJson: string;
  hitCount: number;
  timestamp: number;
}

const toolSchemaCache = new Map<string, ToolSchemaCacheEntry>();

function toToolSchema(schema: unknown): Record<string, unknown> {
  return normalizeObjectJsonSchema(schema);
}

/**
 * Detects if networking tools are present
 * Checks tool list for web search related tools
 * Supports Claude Tool and Gemini GeminiToolDeclaration formats
 */
export function detectsNetworkingTool(tools?: (Tool | GeminiToolDeclaration)[]): boolean {
  if (!tools) {
    return false;
  }
  const keywords = [
    'web_search',
    'google_search',
    'web_search_20250305',
    'google_search_retrieval',
    'builtin_web_search',
  ];

  for (const tool of tools) {
    // Claude Tool format
    const toolName = (tool as { name?: unknown }).name;
    if (isString(toolName) && keywords.includes(toolName)) {
      return true;
    }
    const toolType = (tool as { type?: unknown }).type;
    if (isString(toolType) && keywords.includes(toolType)) {
      return true;
    }

    // OpenAI nested format (runtime check)
    const openaiTool = tool as { function?: { name?: string } };
    if (isString(openaiTool.function?.name) && keywords.includes(openaiTool.function.name)) {
      return true;
    }

    // Gemini GeminiToolDeclaration format
    if ('functionDeclarations' in tool && tool.functionDeclarations) {
      for (const decl of tool.functionDeclarations) {
        if (decl.name && keywords.includes(decl.name)) {
          return true;
        }
      }
    }

    // Gemini search tools
    if ('googleSearch' in tool && tool.googleSearch) {
      return true;
    }
    if ('googleSearchRetrieval' in tool && tool.googleSearchRetrieval) {
      return true;
    }
  }
  return false;
}

export function injectGoogleSearchTool(
  body: { tools?: GeminiToolDeclaration[] },
  mappedModel?: string,
) {
  if (!body.tools) {
    body.tools = [];
  }
  const toolsArr = body.tools;

  const hasFunctions = toolsArr.some((t) => t.functionDeclarations);
  if (hasFunctions) {
    // Not a silent drop: the caller's search request is served by the separate
    // one-shot call that {@link requiresSeparateWebSearchCall} flags.
    logger.info(
      `[Claude-Request] googleSearch cannot ride along with functionDeclarations on ${mappedModel ?? 'unknown-model'} (v1internal incompatible); serving it as a separate web-search call`,
    );
    return;
  }

  // Remove existing to avoid duplicates
  body.tools = toolsArr.filter((t) => !t.googleSearch && !t.googleSearchRetrieval);
  body.tools.push({ googleSearch: {} });
}

/**
 * build tools
 * convert claude tools to gemini function declarations
 */
export function buildTools(
  tools: Tool[] | undefined,
  hasWebSearch: boolean,
  mappedModel: string,
): GeminiToolDeclaration[] | null {
  if (!tools || tools.length === 0) {
    return null;
  }

  const hasGoogleSearch = hasWebSearch || tools.some(isGoogleSearchTool);
  const cacheKey = computeToolSchemaCacheKey(tools);
  let functionDeclarations = cacheKey ? lookupToolSchemaCache(cacheKey) : null;

  if (!functionDeclarations) {
    functionDeclarations = [];
    for (const tool of tools) {
      if (isGoogleSearchTool(tool)) {
        continue;
      }
      if (tool.name) {
        const inputSchema = toToolSchema(tool.input_schema);
        functionDeclarations.push({
          name: tool.name,
          description: tool.description,
          parameters: inputSchema,
        });
      }
    }

    if (cacheKey) {
      cacheToolSchemas(cacheKey, functionDeclarations);
    }
  }

  functionDeclarations = sortBy(functionDeclarations, (declaration) => declaration.name);

  const toolList: GeminiToolDeclaration[] = [];
  if (functionDeclarations.length > 0) {
    toolList.push({ functionDeclarations });
    if (hasGoogleSearch) {
      // Not a silent drop: the caller's search request is served by the
      // separate one-shot call that {@link requiresSeparateWebSearchCall} flags.
      logger.info(
        `[Claude-Request] googleSearch cannot ride along with functionDeclarations on ${mappedModel} (v1internal incompatible); serving it as a separate web-search call`,
      );
    }
  } else if (hasGoogleSearch) {
    toolList.push({ googleSearch: {} });
  }

  if (toolList.length > 0) {
    return toolList;
  }
  return null;
}

export function isGoogleSearchTool(tool: Tool): boolean {
  return (
    tool.name === 'web_search' ||
    tool.name === 'google_search' ||
    tool.name === 'builtin_web_search' ||
    tool.type === 'web_search_20250305' ||
    tool.type === 'builtin_web_search'
  );
}

export function buildToolConfig(toolChoice: ClaudeRequest['tool_choice']): {
  functionCallingConfig: {
    mode: string;
    allowedFunctionNames?: string[];
  };
} {
  let mode = 'VALIDATED';
  let allowedFunctionNames: string[] | undefined;
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') {
      mode = 'NONE';
    } else if (toolChoice === 'auto') {
      mode = 'AUTO';
    } else {
      mode = 'ANY';
    }
  } else if (toolChoice) {
    if (toolChoice.type === 'none') {
      mode = 'NONE';
    } else if (toolChoice.type === 'auto') {
      mode = 'AUTO';
    } else {
      mode = 'ANY';
      const selectedName = toolChoice.name || toolChoice.function?.name;
      if (selectedName?.trim()) {
        allowedFunctionNames = [selectedName.trim()];
      }
    }
  }

  return {
    functionCallingConfig: {
      mode,
      ...(allowedFunctionNames ? { allowedFunctionNames } : {}),
    },
  };
}

function computeToolSchemaCacheKey(tools: Tool[]): string | null {
  try {
    const rawJson = JSON.stringify(tools);
    if (!rawJson) {
      return null;
    }
    return createHash('sha256').update(rawJson).digest('hex');
  } catch {
    return null;
  }
}

function lookupToolSchemaCache(key: string): FunctionDeclaration[] | null {
  const entry = toolSchemaCache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.timestamp > TOOL_SCHEMA_CACHE_TTL_MS) {
    toolSchemaCache.delete(key);
    return null;
  }

  try {
    const declarations = JSON.parse(entry.declarationsJson) as FunctionDeclaration[];
    if (!Array.isArray(declarations)) {
      toolSchemaCache.delete(key);
      return null;
    }
    entry.hitCount += 1;
    logger.debug(
      `[ToolSchemaCache] HIT hash=${key.slice(0, 16)} hitCount=${entry.hitCount} declarations=${declarations.length}`,
    );
    return declarations;
  } catch {
    toolSchemaCache.delete(key);
    return null;
  }
}

function cacheToolSchemas(key: string, declarations: FunctionDeclaration[]): void {
  try {
    toolSchemaCache.set(key, {
      declarationsJson: JSON.stringify(declarations),
      hitCount: 0,
      timestamp: Date.now(),
    });
  } catch {
    return;
  }

  evictToolSchemaCache();
  logger.debug(
    `[ToolSchemaCache] INSERT hash=${key.slice(0, 16)} declarations=${declarations.length}`,
  );
}

function evictToolSchemaCache(): void {
  const oldestAllowed = Date.now() - TOOL_SCHEMA_CACHE_TTL_MS;
  for (const [key, entry] of toolSchemaCache) {
    if (entry.timestamp < oldestAllowed) {
      toolSchemaCache.delete(key);
    }
  }

  while (toolSchemaCache.size > TOOL_SCHEMA_CACHE_LIMIT) {
    const oldestKey = toolSchemaCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    toolSchemaCache.delete(oldestKey);
  }
}
