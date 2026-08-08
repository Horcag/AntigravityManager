import { isPlainObject } from 'lodash-es';
import { mapClaudeModelToGemini } from './ModelMapping';
import { resolveRequestConfig } from './claude-request-config';
import {
  buildContents,
  buildSystemInstruction,
  extractEmbeddedSystemMessages,
} from './claude-request-contents';
import { buildInternalRequestBody, reorderInnerRequestForCache } from './claude-request-envelope';
import { buildGenerationConfig } from './claude-request-generation-config';
import {
  isGeminiFlashModel,
  shouldEnableThinkingByDefault,
  targetModelSupportsThinking,
} from './claude-request-model-traits';
import { resolveSafetySettings } from './claude-request-safety-settings';
import {
  createSignatureLookup,
  hasValidSignatureForFunctionCalls,
  type RequestSignatureState,
} from './claude-request-signatures';
import {
  buildToolConfig,
  buildTools,
  detectsNetworkingTool,
  injectGoogleSearchTool,
} from './claude-request-tools';
import { logger } from '@/shared/logging/logger';
import {
  ClaudeRequest,
  Tool,
  GeminiInternalRequest,
  GeminiContent,
  GeminiToolDeclaration,
  GenerationConfig,
  SafetySetting,
} from './types';

export type { RequestSignatureState } from './claude-request-signatures';

/**
 * Transforms Claude request into Gemini internal request format
 * @param claudeReq Claude API request
 * @param projectId Gemini Project ID
 * @returns Gemini internal request format
 */
export function transformClaudeRequestIn(
  claudeReq: ClaudeRequest,
  projectId?: string,
  userAgent?: string,
  resolvedModel?: string,
  signatureState?: RequestSignatureState,
): GeminiInternalRequest {
  const { extraSystemMessages, messages } = extractEmbeddedSystemMessages(claudeReq.messages);
  // Check for networking tools (server tool or built-in tool)
  const hasWebSearchTool = detectsNetworkingTool(claudeReq.tools);

  // Map to store tool_use id -> name mapping
  const toolIdToName = new Map<string, string>();

  // 1. System Instruction
  const systemInstruction = buildSystemInstruction(
    claudeReq.system,
    extraSystemMessages,
    claudeReq.tools,
  );

  // Map model name
  const mappedModel = mapClaudeModelToGemini(resolvedModel ?? claudeReq.model);

  // Convert Claude tools to Tool array for networking detection
  const normalizedTools: Tool[] | undefined = claudeReq.tools
    ? (JSON.parse(JSON.stringify(claudeReq.tools)) as Tool[])
    : undefined;

  // Resolve grounding config
  const requestConfig = resolveRequestConfig(
    claudeReq.model,
    mappedModel,
    normalizedTools,
    claudeReq.metadata,
  );
  const signatureLookup = createSignatureLookup(signatureState, requestConfig.finalModel);

  const allowDummyThought = requestConfig.finalModel.startsWith('gemini-');

  // 4. Generation Config & Thinking
  const thinkingType = (claudeReq.thinking?.type ?? '').toLowerCase();
  const autoThinkingEnabled =
    !claudeReq.thinking && shouldEnableThinkingByDefault(requestConfig.finalModel, claudeReq.model);
  let isThinkingEnabled =
    thinkingType === 'enabled' || thinkingType === 'adaptive' || autoThinkingEnabled;

  if (isThinkingEnabled && !targetModelSupportsThinking(requestConfig.finalModel)) {
    logger.warn(
      `[Thinking-Mode] Target model ${requestConfig.finalModel} does not support thinking. Disabling thinking mode.`,
    );
    isThinkingEnabled = false;
  }

  if (isThinkingEnabled) {
    const hasFunctionCalls = messages.some((m) => {
      if (Array.isArray(m.content)) {
        return m.content.some((b) => b.type === 'tool_use');
      }
      return false;
    });

    if (hasFunctionCalls && !hasValidSignatureForFunctionCalls(messages, signatureLookup)) {
      if (!isGeminiFlashModel(requestConfig.finalModel)) {
        isThinkingEnabled = false;
      }
    }
  }

  const generationConfig = buildGenerationConfig(
    claudeReq,
    hasWebSearchTool,
    requestConfig.finalModel,
    isThinkingEnabled,
  );
  // Update thinking config based on the final decision
  if (!isThinkingEnabled && generationConfig.thinkingConfig) {
    delete generationConfig.thinkingConfig;
  }

  // 2. Contents (Messages)
  const contents = buildContents(
    messages,
    toolIdToName,
    isThinkingEnabled,
    allowDummyThought,
    requestConfig.finalModel,
    signatureLookup,
  );

  // 3. Tools
  const tools = buildTools(claudeReq.tools, hasWebSearchTool, requestConfig.finalModel);

  // Build inner request
  const innerRequest: {
    contents: GeminiContent[];
    safetySettings?: SafetySetting[];
    systemInstruction?: { parts: { text: string }[] };
    generationConfig?: GenerationConfig;
    tools?: GeminiToolDeclaration[];
    toolConfig?: {
      functionCallingConfig: {
        mode: string;
        allowedFunctionNames?: string[];
      };
    };
  } = {
    contents,
  };

  const safetySettings = resolveSafetySettings(requestConfig.finalModel);
  if (safetySettings.length > 0) {
    innerRequest.safetySettings = safetySettings;
  }

  deepCleanUndefined(innerRequest);

  if (systemInstruction) {
    innerRequest.systemInstruction = systemInstruction;
  }

  if (generationConfig && Object.keys(generationConfig).length > 0) {
    innerRequest.generationConfig = generationConfig;
  }

  if (tools) {
    innerRequest.tools = tools;
    innerRequest.toolConfig = buildToolConfig(claudeReq.tool_choice);
  }

  // Inject googleSearch tool if needed (and not already done by buildTools)
  if (requestConfig.injectGoogleSearch && !hasWebSearchTool) {
    injectGoogleSearchTool(innerRequest, requestConfig.finalModel);
  }

  // Inject imageConfig if present (for image generation models)
  if (requestConfig.imageConfig) {
    // 1. Remove tools (image generation does not support tools)
    delete innerRequest.tools;
    // 2. Remove systemInstruction (image generation does not support system prompts)
    delete innerRequest.systemInstruction;

    // 3. Clean generationConfig
    const imageGenerationConfig = innerRequest.generationConfig || {};
    delete imageGenerationConfig.thinkingConfig;
    delete imageGenerationConfig.responseMimeType;
    delete imageGenerationConfig.responseModalities;
    imageGenerationConfig.imageConfig = requestConfig.imageConfig;
    innerRequest.generationConfig = imageGenerationConfig;
  }

  const reorderedInnerRequest = reorderInnerRequestForCache(
    innerRequest as GeminiInternalRequest['request'],
  );
  const body = buildInternalRequestBody({
    requestConfig,
    innerRequest: reorderedInnerRequest,
    projectId,
    userAgent,
  });

  return body;
}

/**
 * deep clean undefined values
 * recursively delete all properties with undefined values
 * @param obj
 */
function deepCleanUndefined(obj: unknown): void {
  if (Array.isArray(obj)) {
    obj.forEach(deepCleanUndefined);
  } else if (isPlainObject(obj)) {
    const record = obj as Record<string, unknown>;
    Object.keys(record).forEach((key) => {
      if (record[key] === undefined) delete record[key];
      else deepCleanUndefined(record[key]);
    });
  }
}
