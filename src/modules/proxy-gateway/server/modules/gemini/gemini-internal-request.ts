import { isString } from 'lodash-es';
import type { GeminiInternalRequest } from '../../../antigravity/types';
import type { GeminiRequest } from '../../common/interfaces/request-interfaces';

/**
 * Copies a public Gemini request body into the `v1internal` inner request.
 *
 * Only the fields the internal transport accepts are carried across, and empty
 * system-instruction parts are dropped because the provider rejects them.
 */
export function toInternalGeminiRequest(request: GeminiRequest): GeminiInternalRequest['request'] {
  const internalRequest: GeminiInternalRequest['request'] = {
    contents: request.contents,
  };

  if (request.generationConfig) {
    internalRequest.generationConfig = request.generationConfig;
  }
  if (request.tools) {
    internalRequest.tools = request.tools;
  }
  if (request.toolConfig) {
    internalRequest.toolConfig = request.toolConfig;
  }
  if (request.safetySettings) {
    internalRequest.safetySettings = request.safetySettings;
  }

  if (request.systemInstruction) {
    const textParts = (request.systemInstruction.parts ?? [])
      .filter((part): part is { text: string } => isString(part.text) && part.text.length > 0)
      .map((part) => ({ text: part.text }));
    if (textParts.length > 0) {
      internalRequest.systemInstruction = { parts: textParts };
    }
  }

  return internalRequest;
}

export function createGeminiInternalRequest(params: {
  requestId: string;
  model: string;
  request: GeminiRequest;
  projectId: string | undefined;
  requestType: string;
  requestUserAgent: string;
}): GeminiInternalRequest {
  const normalizedProjectId = params.projectId?.trim();

  const internalRequest: GeminiInternalRequest = {
    requestId: params.requestId,
    request: toInternalGeminiRequest(params.request),
    model: params.model,
    userAgent: params.requestUserAgent,
    requestType: params.requestType,
  };

  if (normalizedProjectId) {
    internalRequest.project = normalizedProjectId;
  }

  if (params.requestType !== 'image_gen') {
    internalRequest.enabledCreditTypes = ['GOOGLE_ONE_AI'];
  }

  return internalRequest;
}
