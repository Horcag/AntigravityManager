import { v4 as uuidv4 } from 'uuid';
import type { ResolvedRequestConfig } from './claude-request-config';
import type { GeminiInternalRequest } from './types';
import {
  buildUserAgent,
  FALLBACK_VERSION,
  resolveLocalInstalledVersion,
} from '@/modules/proxy-gateway/server/common/utils/request-user-agent';

const AGENT_CREDIT_TYPES = ['GOOGLE_ONE_AI'];

function createOfficialRequestId(): string {
  const timestampMs = Date.now();
  const randomHex = uuidv4().replace(/-/g, '').slice(0, 8);
  return `agent/${timestampMs}/${randomHex}`;
}

/**
 * Builds the `v1internal` envelope.
 *
 * Deliberately carries no session identifier. An Anthropic client's advisory
 * `metadata.user_id` (and the OpenAI `user` field that lands in the same place)
 * used to be forwarded as `sessionId`, which the provider answers with
 * `Invalid JSON payload received. Unknown name "sessionId": Cannot find field.`
 * — a 400 on the whole request. No accepted destination for it exists on this
 * transport, and both fields are advisory in their own APIs, so they are
 * dropped here rather than costing the caller the request.
 */
export function buildInternalRequestBody(params: {
  requestConfig: ResolvedRequestConfig;
  innerRequest: GeminiInternalRequest['request'];
  projectId?: string;
  userAgent?: string;
}): GeminiInternalRequest {
  const normalizedProjectId = params.projectId?.trim();
  const discoveryVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;
  const isAgentRequest = params.requestConfig.requestType !== 'image_gen';
  const body: GeminiInternalRequest = {
    ...(normalizedProjectId ? { project: normalizedProjectId } : {}),
    request: params.innerRequest,
    model: params.requestConfig.finalModel,
    userAgent: params.userAgent?.trim() || buildUserAgent(discoveryVersion),
    requestType: isAgentRequest ? 'agent' : 'image_gen',
    ...(isAgentRequest ? { enabledCreditTypes: [...AGENT_CREDIT_TYPES] } : {}),
    requestId: createOfficialRequestId(),
  };

  return body;
}

/**
 * Keep the large, repeatable request prefix before dynamic conversation contents.
 * Property order is preserved by JSON.stringify in the request transport.
 */
export function reorderInnerRequestForCache(
  innerRequest: GeminiInternalRequest['request'],
): GeminiInternalRequest['request'] {
  const reordered: Partial<GeminiInternalRequest['request']> = {};

  if (innerRequest.systemInstruction) {
    reordered.systemInstruction = innerRequest.systemInstruction;
  }
  if (innerRequest.tools) {
    reordered.tools = innerRequest.tools;
  }
  if (innerRequest.toolConfig) {
    reordered.toolConfig = innerRequest.toolConfig;
  }
  if (innerRequest.generationConfig) {
    reordered.generationConfig = innerRequest.generationConfig;
  }
  if (innerRequest.safetySettings) {
    reordered.safetySettings = innerRequest.safetySettings;
  }

  reordered.contents = innerRequest.contents ?? [];

  const reorderedRecord = reordered as Record<string, unknown>;
  for (const [key, value] of Object.entries(innerRequest)) {
    if (!(key in reorderedRecord)) {
      reorderedRecord[key] = value;
    }
  }

  return reordered as GeminiInternalRequest['request'];
}
