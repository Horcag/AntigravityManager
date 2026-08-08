import { isNil, isNumber, isString } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import { transformResponse } from '../../../../antigravity/ClaudeResponseMapper';
import type { StreamingSignatureState } from '../../../../antigravity/ClaudeStreamingMapper';
import {
  extractCustomToolInput,
  isCustomToolCall,
  toCustomToolArguments,
} from '../../../../antigravity/CustomToolCall';
import { optimizeApplyPatch } from '../../../../antigravity/ApplyPatchPreflight';
import { toOpenAIUsage } from '../../../../antigravity/OpenAIUsageMapper';
import { resolveShellToolName } from '../../../../antigravity/ShellToolName';
import { splitNamespaceToolName } from '../../../../antigravity/ToolNamespace';
import {
  attachWebSearchResults,
  buildOpenAIUrlCitationAnnotations,
} from '../../../../antigravity/openai-web-search';
import {
  toWebSearchResultSet,
  type WebSearchResultSet,
} from '../../../../antigravity/web-search-results';
import type { ClaudeResponse, GroundingMetadata } from '../../../../antigravity/types';
import { toRecord } from '../../../common/utils/json-record';
import type {
  GeminiResponse,
  OpenAIChatLogprobs,
  OpenAIChatResponse,
} from '../../../common/interfaces/request-interfaces';

export function mapGeminiFinishReasonToOpenAIFinishReason(finishReason?: string): string | null {
  if (!finishReason) {
    return null;
  }

  const normalized = finishReason.toUpperCase();
  if (normalized === 'STOP') {
    return 'stop';
  }
  if (normalized === 'MAX_TOKENS') {
    return 'length';
  }
  if (
    normalized === 'SAFETY' ||
    normalized === 'RECITATION' ||
    normalized === 'BLOCKLIST' ||
    normalized === 'PROHIBITED_CONTENT' ||
    normalized === 'SPII' ||
    normalized === 'IMAGE_SAFETY' ||
    normalized === 'IMAGE_PROHIBITED_CONTENT'
  ) {
    return 'content_filter';
  }

  return 'stop';
}

export function mapAnthropicStopReasonToOpenAIFinishReason(
  stopReason?: string | null,
): string | null {
  if (!stopReason) {
    return null;
  }

  if (stopReason === 'end_turn') {
    return 'stop';
  }
  if (stopReason === 'max_tokens') {
    return 'length';
  }
  if (stopReason === 'tool_use') {
    return 'tool_calls';
  }
  if (stopReason === 'refusal') {
    return 'content_filter';
  }

  return stopReason;
}

function normalizeToolCallArguments(input: unknown): string {
  if (isString(input)) {
    return input;
  }
  if (isNil(input)) {
    return '{}';
  }

  try {
    return JSON.stringify(input);
  } catch {
    return '{}';
  }
}

export function convertClaudeToOpenAIResponse(
  claudeResponse: ClaudeResponse,
  model: string,
  clientToolNames?: ReadonlySet<string>,
): OpenAIChatResponse {
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [convertClaudeToOpenAIChoice(claudeResponse, 0, clientToolNames)],
    usage: toOpenAIUsage(claudeResponse.usage),
  };
}

/**
 * Renders a buffered upstream answer as a chat completion.
 *
 * Each candidate is mapped through the Claude response mapper on its own so a
 * multi-candidate answer produces independent choices, and usage is taken from
 * the first candidate because upstream reports it once per response.
 */
export function convertGeminiToOpenAIResponse(
  geminiResponse: GeminiResponse,
  model: string,
  clientToolNames?: ReadonlySet<string>,
  signatureState?: StreamingSignatureState,
  serviceTier?: string,
  topLogprobs = 0,
  webSearch = false,
): OpenAIChatResponse {
  const candidates =
    geminiResponse.candidates && geminiResponse.candidates.length > 0
      ? geminiResponse.candidates
      : [undefined];
  const choices = candidates.map((candidate, fallbackIndex) => {
    const candidateResponse: GeminiResponse = {
      ...geminiResponse,
      candidates: candidate ? [candidate] : [],
    };
    const claudeResponse = transformResponse(candidateResponse, signatureState, { webSearch });
    const candidateIndex = isNumber(candidate?.index) ? candidate.index : fallbackIndex;
    return convertClaudeToOpenAIChoice(
      claudeResponse,
      candidateIndex,
      clientToolNames,
      toOpenAIChatLogprobs(candidate?.logprobsResult, topLogprobs),
      webSearch
        ? toWebSearchResultSet(candidate?.groundingMetadata as GroundingMetadata | undefined)
        : null,
    );
  });
  const usageSource = transformResponse(
    { ...geminiResponse, candidates: candidates[0] ? [candidates[0]] : [] },
    undefined,
  );

  const openaiResponse: OpenAIChatResponse = {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    usage: toOpenAIUsage(usageSource.usage),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  };

  const groundingResultSet = webSearch
    ? toWebSearchResultSet(candidates[0]?.groundingMetadata as GroundingMetadata | undefined)
    : null;
  return groundingResultSet
    ? attachWebSearchResults(openaiResponse, groundingResultSet)
    : openaiResponse;
}

function convertClaudeToOpenAIChoice(
  claudeResponse: ClaudeResponse,
  index: number,
  clientToolNames?: ReadonlySet<string>,
  logprobs: OpenAIChatLogprobs | null = null,
  webSearchResultSet: WebSearchResultSet | null = null,
): OpenAIChatResponse['choices'][number] {
  const contentBlocks = Array.isArray(claudeResponse?.content) ? claudeResponse.content : [];

  const textContent = contentBlocks
    .filter(
      (
        block,
      ): block is Extract<ClaudeResponse['content'][number], { type: 'text'; text: string }> =>
        block?.type === 'text',
    )
    .map((block) => block.text || '')
    .join('');

  const reasoningContent = contentBlocks
    .filter(
      (
        block,
      ): block is Extract<
        ClaudeResponse['content'][number],
        { type: 'thinking'; thinking: string }
      > => block?.type === 'thinking',
    )
    .map((block) => block.thinking || '')
    .join('');

  const toolCalls = contentBlocks
    .filter(
      (
        block,
      ): block is Extract<
        ClaudeResponse['content'][number],
        { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      > => block?.type === 'tool_use',
    )
    .map((block, toolIndex: number) => {
      const splitName = splitNamespaceToolName(block.name || 'unknown_tool');
      const functionName = clientToolNames
        ? resolveShellToolName(splitName.name, clientToolNames)
        : splitName.name;
      const argumentsInput = isCustomToolCall(functionName)
        ? toCustomToolArguments(
            functionName,
            optimizeApplyPatch(extractCustomToolInput(functionName, block.input)).input,
          )
        : block.input;
      return {
        id: block.id || `tool-call-${toolIndex}`,
        type: 'function' as const,
        function: {
          name: functionName,
          arguments: normalizeToolCallArguments(argumentsInput),
        },
        namespace: splitName.namespace,
      };
    });

  const annotations = buildOpenAIUrlCitationAnnotations(textContent, webSearchResultSet);

  return {
    index,
    message: {
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      reasoning_content: reasoningContent || undefined,
      refusal: claudeResponse.refusal,
      ...(annotations.length > 0 ? { annotations } : {}),
    },
    logprobs,
    finish_reason: mapAnthropicStopReasonToOpenAIFinishReason(claudeResponse.stop_reason),
  };
}

function toOpenAIChatLogprobs(value: unknown, topLogprobs: number): OpenAIChatLogprobs | null {
  const result = toRecord(value);
  const chosenCandidates = Array.isArray(result?.chosenCandidates) ? result.chosenCandidates : [];
  const topCandidates = Array.isArray(result?.topCandidates) ? result.topCandidates : [];
  const content = chosenCandidates.flatMap((chosenValue, index) => {
    const chosen = toRecord(chosenValue);
    if (!chosen || !isString(chosen.token) || !isNumber(chosen.logProbability)) {
      return [];
    }
    const topGroup = toRecord(topCandidates[index]);
    const alternatives = Array.isArray(topGroup?.candidates)
      ? topGroup.candidates.slice(0, topLogprobs)
      : [];
    const mappedTopLogprobs = alternatives.flatMap((alternativeValue) => {
      const alternative = toRecord(alternativeValue);
      if (!alternative || !isString(alternative.token) || !isNumber(alternative.logProbability)) {
        return [];
      }
      return [
        {
          token: alternative.token,
          logprob: alternative.logProbability,
          bytes: Array.from(Buffer.from(alternative.token, 'utf8')),
        },
      ];
    });
    return [
      {
        token: chosen.token,
        logprob: chosen.logProbability,
        bytes: Array.from(Buffer.from(chosen.token, 'utf8')),
        top_logprobs: mappedTopLogprobs,
      },
    ];
  });

  return content.length > 0 ? { content } : null;
}
