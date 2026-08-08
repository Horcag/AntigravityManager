import { isNumber, isString } from 'lodash-es';
import type {
  GeminiResponsesGroundingMetadata,
  GeminiResponsesStreamPart,
} from '../../../../antigravity/OpenAIResponsesStreamingMapper';
import { toRecord } from '../../../common/utils/json-record';
import type { GeminiUsageMetadata } from '../../../common/interfaces/request-interfaces';

/**
 * Narrows the untyped upstream SSE payload into the shapes the Responses
 * streaming mapper accepts. Anything the provider sends that does not match is
 * dropped rather than forwarded, so a malformed frame cannot reach the client.
 */
export function toResponsesStreamPart(value: unknown): GeminiResponsesStreamPart | null {
  const part = toRecord(value);
  if (!part) {
    return null;
  }

  const functionCallRecord = toRecord(part.functionCall);
  const functionName = isString(functionCallRecord?.name) ? functionCallRecord.name : null;
  const functionId = isString(functionCallRecord?.id) ? functionCallRecord.id : undefined;
  const inlineDataRecord = toRecord(part.inlineData);
  const inlineData =
    isString(inlineDataRecord?.mimeType) && isString(inlineDataRecord.data)
      ? {
          data: inlineDataRecord.data,
          mimeType: inlineDataRecord.mimeType,
        }
      : undefined;

  return {
    functionCall: functionName
      ? {
          ...(functionCallRecord && Object.hasOwn(functionCallRecord, 'args')
            ? { args: functionCallRecord.args }
            : {}),
          id: functionId,
          name: functionName,
        }
      : undefined,
    inlineData,
    text: isString(part.text) ? part.text : undefined,
    thought: part.thought === true,
    thoughtSignature: isString(part.thoughtSignature) ? part.thoughtSignature : undefined,
    thought_signature: isString(part.thought_signature) ? part.thought_signature : undefined,
  };
}

export function toResponsesGroundingMetadata(
  value: unknown,
): GeminiResponsesGroundingMetadata | null {
  const grounding = toRecord(value);
  if (!grounding) {
    return null;
  }

  const webSearchQueries = Array.isArray(grounding.webSearchQueries)
    ? grounding.webSearchQueries.filter(isString)
    : undefined;
  const groundingChunks = Array.isArray(grounding.groundingChunks)
    ? grounding.groundingChunks.flatMap((chunk) => {
        const web = toRecord(toRecord(chunk)?.web);
        if (!web) {
          return [];
        }
        return [
          {
            web: {
              title: isString(web.title) ? web.title : undefined,
              uri: isString(web.uri) ? web.uri : undefined,
            },
          },
        ];
      })
    : undefined;

  if (!webSearchQueries?.length && !groundingChunks?.length) {
    return null;
  }
  return { groundingChunks, webSearchQueries };
}

export function toGeminiUsageMetadata(value: unknown): GeminiUsageMetadata | undefined {
  const usageMetadata = toRecord(value);
  if (!usageMetadata) {
    return undefined;
  }

  return {
    cachedContentTokenCount: isNumber(usageMetadata.cachedContentTokenCount)
      ? usageMetadata.cachedContentTokenCount
      : undefined,
    candidatesTokenCount: isNumber(usageMetadata.candidatesTokenCount)
      ? usageMetadata.candidatesTokenCount
      : undefined,
    promptTokenCount: isNumber(usageMetadata.promptTokenCount)
      ? usageMetadata.promptTokenCount
      : undefined,
    thoughtsTokenCount: isNumber(usageMetadata.thoughtsTokenCount)
      ? usageMetadata.thoughtsTokenCount
      : undefined,
    totalTokenCount: isNumber(usageMetadata.totalTokenCount)
      ? usageMetadata.totalTokenCount
      : undefined,
    total_input_tokens: isNumber(usageMetadata.total_input_tokens)
      ? usageMetadata.total_input_tokens
      : undefined,
    total_output_tokens: isNumber(usageMetadata.total_output_tokens)
      ? usageMetadata.total_output_tokens
      : undefined,
    total_cached_tokens: isNumber(usageMetadata.total_cached_tokens)
      ? usageMetadata.total_cached_tokens
      : undefined,
    total_thought_tokens: isNumber(usageMetadata.total_thought_tokens)
      ? usageMetadata.total_thought_tokens
      : undefined,
    totalThoughtTokens: isNumber(usageMetadata.totalThoughtTokens)
      ? usageMetadata.totalThoughtTokens
      : undefined,
    total_tokens: isNumber(usageMetadata.total_tokens) ? usageMetadata.total_tokens : undefined,
    total_tool_use_tokens: isNumber(usageMetadata.total_tool_use_tokens)
      ? usageMetadata.total_tool_use_tokens
      : undefined,
    cachedTokens: isNumber(usageMetadata.cachedTokens) ? usageMetadata.cachedTokens : undefined,
  };
}
