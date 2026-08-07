import { randomUUID } from 'node:crypto';

import {
  mergeOpenAIResponsesInputItems,
  normalizeOpenAIResponsesInputItems,
  OpenAIResponsesSessionStore,
  OpenAIResponsesSessionStoreImpl,
  type OpenAIResponsesSession,
  type OpenAIResponsesSessionStoreLike,
} from './openai-responses-session.store';

export type OpenAIResponsesWebSocketEvent = Record<string, unknown> & {
  type: string;
};

export type OpenAIResponsesWebSocketAction =
  | {
      events: OpenAIResponsesWebSocketEvent[];
      kind: 'local';
    }
  | {
      kind: 'request';
      previousResponseId?: string;
      request: Record<string, unknown>;
    }
  | {
      kind: 'cancel';
      responseId?: string;
    };

export class OpenAIResponsesWebSocketProtocolError extends Error {
  public readonly status = 400;
  public readonly type = 'invalid_request_error';

  public constructor(
    message: string,
    public readonly code: string,
    public readonly param?: string,
  ) {
    super(message);
    this.name = 'OpenAIResponsesWebSocketProtocolError';
  }
}

/**
 * Stateful adapter for the OpenAI Responses WebSocket protocol.
 *
 * The connection owns ephemeral `store=false` state while the injected store
 * makes normal responses available to HTTP and later WebSocket connections.
 * Gemini still receives a rebuilt transcript because its upstream transport is
 * stateless.
 */
export class OpenAIResponsesWebSocketProtocol {
  private readonly connectionStore = new OpenAIResponsesSessionStoreImpl();
  private lastResponseId = '';
  private pendingPreviousResponseId: string | null = null;
  private pendingSession: OpenAIResponsesSession | null = null;

  public constructor(
    private readonly persistentStore: OpenAIResponsesSessionStoreLike = OpenAIResponsesSessionStore,
  ) {}

  public accept(payload: unknown): OpenAIResponsesWebSocketAction {
    const event = toRecord(payload);
    if (!event) {
      throw protocolError('websocket request must be a JSON object', 'invalid_value', 'body');
    }

    const eventType = getString(event, 'type');
    if (!eventType) {
      throw protocolError('type is required', 'missing_required_parameter', 'type');
    }
    if (eventType === 'response.cancel') {
      return {
        kind: 'cancel',
        responseId: getOptionalString(event, 'response_id'),
      };
    }
    if (eventType !== 'response.create') {
      throw protocolError(
        `unsupported websocket request type: ${eventType}`,
        'unsupported_value',
        'type',
      );
    }
    if (event.stream !== undefined) {
      throw protocolError(
        'stream is implicit in WebSocket mode and must be omitted',
        'unsupported_parameter',
        'stream',
      );
    }
    if (event.background !== undefined) {
      throw protocolError(
        'background is not supported in WebSocket mode',
        'unsupported_parameter',
        'background',
      );
    }
    if (event.generate !== undefined && typeof event.generate !== 'boolean') {
      throw protocolError('generate must be a boolean', 'invalid_value', 'generate');
    }
    if (event.store !== undefined && typeof event.store !== 'boolean') {
      throw protocolError('store must be a boolean', 'invalid_value', 'store');
    }

    const prepared = this.prepareRequest(event, event.generate === false);
    if (event.generate === false) {
      this.pendingPreviousResponseId = prepared.previousResponseId ?? null;
      return {
        events: this.handlePrewarmLocally(prepared.request, prepared.session),
        kind: 'local',
      };
    }

    this.pendingPreviousResponseId = prepared.previousResponseId ?? null;
    this.pendingSession = prepared.session;
    return {
      kind: 'request',
      previousResponseId: prepared.previousResponseId,
      request: prepared.request,
    };
  }

  public complete(response: unknown): void {
    const responseRecord = toRecord(response);
    const pendingSession = this.pendingSession;
    if (!responseRecord || !pendingSession) {
      return;
    }

    const responseId = getString(responseRecord, 'id');
    const output = Array.isArray(responseRecord.output) ? responseRecord.output : [];
    if (!responseId) {
      this.fail();
      return;
    }

    this.saveSession(responseId, {
      ...pendingSession,
      inputItems: [...pendingSession.inputItems, ...output],
      prewarm: false,
    });
    this.pendingPreviousResponseId = null;
    this.pendingSession = null;
  }

  public fail(): void {
    if (this.pendingPreviousResponseId) {
      this.connectionStore.delete(this.pendingPreviousResponseId);
      if (this.lastResponseId === this.pendingPreviousResponseId) {
        this.lastResponseId = '';
      }
    }
    this.pendingPreviousResponseId = null;
    this.pendingSession = null;
  }

  public cancel(): void {
    this.pendingPreviousResponseId = null;
    this.pendingSession = null;
  }

  public getPreviousResponseId(): string {
    return this.lastResponseId;
  }

  private prepareRequest(
    payload: Record<string, unknown>,
    prewarm: boolean,
  ): {
    previousResponseId?: string;
    request: Record<string, unknown>;
    session: OpenAIResponsesSession;
  } {
    const previousResponseId = normalizePreviousResponseId(payload.previous_response_id);
    const previousSession = previousResponseId
      ? (this.connectionStore.get(previousResponseId) ??
        this.persistentStore.get(previousResponseId))
      : null;
    if (previousResponseId && !previousSession) {
      throw protocolError(
        `Unknown or expired previous_response_id: ${previousResponseId}`,
        'previous_response_not_found',
        'previous_response_id',
      );
    }

    if (!previousResponseId) {
      this.connectionStore.clear();
      this.lastResponseId = '';
    }

    const model = getOptionalString(payload, 'model') ?? previousSession?.model;
    if (!model) {
      throw protocolError(
        'model is required for a new WebSocket response chain',
        'missing_required_parameter',
        'model',
      );
    }
    if (payload.instructions !== undefined && typeof payload.instructions !== 'string') {
      throw protocolError('instructions must be a string', 'invalid_value', 'instructions');
    }
    if (payload.tools !== undefined && !Array.isArray(payload.tools)) {
      throw protocolError('tools must be an array', 'invalid_value', 'tools');
    }

    const currentInput = normalizeOpenAIResponsesInputItems(payload.input);
    const inputItems = mergeOpenAIResponsesInputItems(
      previousSession?.inputItems ?? [],
      currentInput,
      previousSession?.toolCallItems,
    );
    const inheritedDefaults = previousSession?.prewarm
      ? { ...(previousSession.requestDefaults ?? {}) }
      : pickStableContinuationDefaults(previousSession);
    const request: Record<string, unknown> = {
      ...inheritedDefaults,
      ...payload,
      input: inputItems,
      model,
      stream: true,
    };
    delete request.type;
    delete request.generate;
    delete request.background;
    delete request.previous_response_id;

    const instructions =
      typeof payload.instructions === 'string'
        ? payload.instructions
        : previousSession?.prewarm
          ? previousSession.instructions
          : undefined;
    if (instructions === undefined) {
      delete request.instructions;
    } else {
      request.instructions = instructions;
    }

    const tools = Array.isArray(payload.tools)
      ? (payload.tools as OpenAIResponsesSession['tools'])
      : previousSession?.tools;
    if (tools === undefined) {
      delete request.tools;
    } else {
      request.tools = tools;
    }

    const session: OpenAIResponsesSession = {
      inputItems,
      instructions,
      model,
      prewarm,
      requestDefaults: toRequestDefaults(request),
      store: payload.store !== false,
      tools,
      toolCallItems: previousSession?.toolCallItems,
    };
    return {
      ...(previousResponseId ? { previousResponseId } : {}),
      request,
      session,
    };
  }

  private handlePrewarmLocally(
    request: Record<string, unknown>,
    session: OpenAIResponsesSession,
  ): OpenAIResponsesWebSocketEvent[] {
    const responseId = `resp_prewarm_${randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const responseBase = {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      background: false,
      error: null,
      incomplete_details: null,
      output: [],
      model: session.model,
      previous_response_id: this.pendingPreviousResponseId,
    };
    const created: OpenAIResponsesWebSocketEvent = {
      type: 'response.created',
      sequence_number: 0,
      response: { ...responseBase, status: 'in_progress' },
    };
    const completed: OpenAIResponsesWebSocketEvent = {
      type: 'response.completed',
      sequence_number: 1,
      response: {
        ...responseBase,
        status: 'completed',
        usage: {
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 0,
        },
      },
    };

    this.saveSession(responseId, {
      ...session,
      inputItems: Array.isArray(request.input) ? [...request.input] : [],
      prewarm: true,
    });
    this.pendingPreviousResponseId = null;
    this.pendingSession = null;
    return [created, completed];
  }

  private saveSession(responseId: string, session: OpenAIResponsesSession): void {
    this.connectionStore.clear();
    this.connectionStore.save(responseId, session);
    if (session.store !== false) {
      this.persistentStore.save(responseId, session);
    }
    this.lastResponseId = responseId;
  }
}

function normalizePreviousResponseId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw protocolError(
      'previous_response_id must be a non-empty string or null',
      'invalid_value',
      'previous_response_id',
    );
  }
  return value;
}

function pickStableContinuationDefaults(
  session: OpenAIResponsesSession | null,
): Record<string, unknown> {
  if (!session) {
    return {};
  }
  const defaults: Record<string, unknown> = { model: session.model };
  if (session.tools !== undefined) {
    defaults.tools = session.tools;
  }
  const toolChoice = session.requestDefaults?.tool_choice;
  if (toolChoice !== undefined) {
    defaults.tool_choice = toolChoice;
  }
  return defaults;
}

function toRequestDefaults(request: Record<string, unknown>): Record<string, unknown> {
  const defaults = { ...request };
  for (const field of ['input', 'stream', 'store']) {
    delete defaults[field];
  }
  return defaults;
}

function protocolError(message: string, code: string, param?: string): never {
  throw new OpenAIResponsesWebSocketProtocolError(message, code, param);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getOptionalString(
  record: Record<string, unknown> | null,
  field: string,
): string | undefined {
  return getString(record, field) ?? undefined;
}
