import { Observable } from 'rxjs';

import { toOpenAIResponsesResponse } from '../../../antigravity/OpenAIResponsesResponseMapper';
import { ProxyController, type ResponsesRequestBody } from '../../proxy.controller';
import type { ProxyService } from '../../proxy.service';
import type { OpenAIChatRequest } from '../../common/interfaces/request-interfaces';
import { normalizeAnthropicMessagesRequest } from '../anthropic/anthropic-request-contract';
import { normalizeOpenAIChatRequest } from '../openai/chat/openai-request-contract';
import { expandFileReferences, type FileReferenceSurface } from '../files/file-reference-expander';
import type { FileContentStore } from '../files/file-content-store.service';
import type { OpenAIResponsesSessionStoreLike } from '../openai/responses/openai-responses-session.store';
import type { BatchJobRecord, BatchRequestError, BatchRequestRecord } from './batch-job.types';

/**
 * The slice of `ProxyService` a batch needs.
 *
 * Batches go through exactly the same handlers interactive requests use, so
 * account selection, model routing, retries and rate-limit tracking all apply
 * unchanged — there is no second path to upstream and no bypass of the lease
 * machinery.
 */
export interface BatchExecutionTarget {
  handleChatCompletions(request: OpenAIChatRequest, outputProtocol?: string): Promise<unknown>;
  handleAnthropicMessages(request: unknown): Promise<unknown>;
  handleGeminiGenerateContent(model: string, request: unknown): Promise<unknown>;
}

export interface BatchExecutionDeps {
  target: BatchExecutionTarget;
  fileStore?: FileContentStore;
  responsesSessions?: OpenAIResponsesSessionStoreLike;
}

export type BatchExecutionResult =
  | { outcome: 'succeeded'; response: unknown }
  | { outcome: 'errored'; error: BatchRequestError };

/**
 * Runs one request line to completion.
 *
 * Streaming is refused rather than silently dropped: a batch collects whole
 * results, so a body asking for `stream: true` is normalized to a single
 * response and the caller is told through the result shape, not through a
 * half-honoured stream.
 */
export async function executeBatchRequest(
  job: BatchJobRecord,
  request: BatchRequestRecord,
  deps: BatchExecutionDeps,
): Promise<BatchExecutionResult> {
  try {
    const response = await dispatch(job, request, deps);
    if (response instanceof Observable) {
      throw new Error('Batch requests cannot be streamed; remove "stream" from the request body');
    }
    return { outcome: 'succeeded', response };
  } catch (error) {
    return { outcome: 'errored', error: toBatchRequestError(error) };
  }
}

async function dispatch(
  job: BatchJobRecord,
  request: BatchRequestRecord,
  deps: BatchExecutionDeps,
): Promise<unknown> {
  if (job.dialect === 'gemini') {
    const body = await expand('gemini', request.body, deps);
    return deps.target.handleGeminiGenerateContent(request.target ?? job.endpoint, body);
  }

  if (job.dialect === 'anthropic') {
    const body = await expand('anthropic', request.body, deps);
    const normalized = normalizeAnthropicMessagesRequest(withoutStream(body));
    return deps.target.handleAnthropicMessages(normalized);
  }

  if (job.endpoint === '/v1/responses') {
    return runResponsesRequest(request, deps);
  }

  const body = await expand('openai-chat', request.body, deps);
  const normalized = normalizeOpenAIChatRequest(withoutStream(body) as OpenAIChatRequest);
  return deps.target.handleChatCompletions(normalized);
}

/**
 * Stored file handles are expanded before validation, exactly as the live
 * endpoints do it, so a batch line can reference an upload by handle.
 */
function expand<T>(surface: FileReferenceSurface, body: T, deps: BatchExecutionDeps): Promise<T> {
  return expandFileReferences(body, surface, deps.fileStore);
}

/**
 * `/v1/responses` inside a batch is prepared by the same code the live endpoint
 * uses.
 *
 * `ProxyController.prepareResponsesRequest` is the only implementation of the
 * Responses-to-Chat conversion, and duplicating ~250 lines of it here would
 * guarantee the two drift. The controller is a plain class whose constructor
 * takes the services it needs, so the batch path constructs one over the same
 * proxy service and the same session store rather than copying its body.
 */
async function runResponsesRequest(
  request: BatchRequestRecord,
  deps: BatchExecutionDeps,
): Promise<unknown> {
  const body = (await expand('openai-responses', request.body, deps)) as ResponsesRequestBody;
  const controller = new ProxyController(
    deps.target as unknown as ProxyService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    deps.responsesSessions,
  );
  const prepared = controller.prepareResponsesRequest(withoutStream(body) as ResponsesRequestBody);
  if (!prepared) {
    throw new Error(
      `previous_response_id '${String(body.previous_response_id ?? '')}' is not a stored response`,
    );
  }
  const response = await deps.target.handleChatCompletions(prepared.request, 'responses');
  return toOpenAIResponsesResponse(response as never, prepared.responseContext);
}

/** Batches never stream; the flag is removed before validation rejects it. */
function withoutStream(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }
  const { stream: _stream, ...rest } = body as Record<string, unknown>;
  return rest;
}

/**
 * Normalizes anything a handler can throw into the record a result line keeps.
 * The HTTP status is preserved because each dialect's result shape reports it.
 */
export function toBatchRequestError(error: unknown): BatchRequestError {
  const status =
    readNumber(error, 'httpStatus') ?? readNumber(error, 'status') ?? readNumber(error, 'code');
  const httpStatus = status && status >= 400 && status <= 599 ? status : 500;
  const code = readString(error, 'code') ?? readString(error, 'type') ?? defaultCode(httpStatus);
  return {
    message: error instanceof Error ? error.message : 'Batch request failed',
    code,
    httpStatus,
  };
}

function defaultCode(httpStatus: number): string {
  if (httpStatus === 404) {
    return 'not_found_error';
  }
  if (httpStatus === 429) {
    return 'rate_limit_error';
  }
  return httpStatus >= 500 ? 'api_error' : 'invalid_request_error';
}

function readNumber(error: unknown, key: string): number | undefined {
  const value = (error as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(error: unknown, key: string): string | undefined {
  const value = (error as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
