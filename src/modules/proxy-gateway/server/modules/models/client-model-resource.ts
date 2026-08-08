import { MODEL_LIST_CREATED_AT, MODEL_LIST_OWNER } from '../../../antigravity/ModelMapping';

/**
 * Retrieve-model resource shapes and error envelopes for the two client
 * dialects that share `/v1/models/{id}`.
 *
 * Kept apart from the controller so both can be exercised without standing up
 * an HTTP server, the same way `unimplemented-route.ts` is split from its
 * filter.
 */

export interface OpenAIModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface AnthropicModelObject {
  id: string;
  type: 'model';
  display_name: string;
  created_at: string;
}

/** Exactly the entry `GET /v1/models` puts in its `data` array. */
export function toOpenAIModelObject(id: string): OpenAIModelObject {
  return {
    id,
    object: 'model',
    created: MODEL_LIST_CREATED_AT,
    owned_by: MODEL_LIST_OWNER,
  };
}

/**
 * The catalog carries no per-model marketing name, so `display_name` is the id
 * — the same thing `/v1beta/models` reports as `displayName`. Inventing a
 * prettier one here would make the three surfaces disagree about a model's
 * name.
 */
export function toAnthropicModelObject(id: string): AnthropicModelObject {
  return {
    id,
    type: 'model',
    display_name: id,
    created_at: new Date(MODEL_LIST_CREATED_AT * 1000).toISOString(),
  };
}

export interface OpenAIModelErrorEnvelope {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
}

export interface AnthropicModelErrorEnvelope {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
  request_id?: string;
}

/**
 * `code: 'model_not_found'` rather than the catch-all's `unknown_url`: the URL
 * *was* routed, the model behind it is what does not exist. A client can tell
 * "this proxy has no retrieve-model endpoint" from "this proxy does not serve
 * that model" only by that distinction.
 *
 * No near-match is ever substituted — the proxy is fail-closed and advertises
 * `x-antigravity-fallback-policy: none`.
 */
export function openAIModelNotFoundResponse(id: string): OpenAIModelErrorEnvelope {
  return {
    error: {
      message: `The model '${id}' does not exist or you do not have access to it.`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  };
}

export function anthropicModelNotFoundResponse(
  id: string,
  requestId?: string,
): AnthropicModelErrorEnvelope {
  return {
    type: 'error',
    error: {
      type: 'not_found_error',
      message: `model: ${id}`,
    },
    ...(requestId ? { request_id: requestId } : {}),
  };
}
