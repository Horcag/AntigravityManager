import type { SignatureContext, SignatureStore } from './SignatureStore';
import { decodeSignature } from './signature-utils';
import { optimizeApplyPatch, validateApplyPatchV4A } from './ApplyPatchPreflight';
import { extractCustomToolInput, isCustomToolCall } from './CustomToolCall';
import { resolveShellToolName } from './ShellToolName';
import { splitNamespaceToolName } from './ToolNamespace';
import type { OpenAIResponsesUsage } from './OpenAIUsageMapper';
import { normalizeFunctionCallArgs } from './function-call-args';
import { renderGroundingMarkdown } from './grounding-citations';
import {
  buildOpenAIUrlCitationAnnotations,
  buildOpenAIWebSearchCallItem,
} from './openai-web-search';
import {
  mergeWebSearchResultSets,
  toWebSearchResultSet,
  type WebSearchResultSet,
} from './web-search-results';
import type { GroundingMetadata } from './types';
import { ToolCallIdIntegrityTracker } from './tool-call-id-integrity';
import {
  OpenAIResponsesReasoningEventEmitter,
  parsePotentialWrappedReasoning,
  type OpenAIResponsesReasoningOutputItem,
} from '../server/modules/openai/responses/openai-responses-reasoning-events';

export interface GeminiResponsesStreamPart {
  functionCall?: {
    args?: unknown;
    id?: string;
    name: string;
  };
  inlineData?: {
    data: string;
    mimeType: string;
  };
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
}

export interface GeminiResponsesGroundingMetadata {
  groundingChunks?: Array<{
    web?: {
      title?: string;
      uri?: string;
    };
  }>;
  webSearchQueries?: string[];
}

interface ResponsesMessageOutputItem {
  content: Array<{
    annotations: unknown[];
    text: string;
    type: 'output_text';
  }>;
  id: string;
  phase: 'commentary' | 'final_answer';
  role: 'assistant';
  status: 'completed' | 'incomplete';
  type: 'message';
}

interface ResponsesFunctionCallOutputItem {
  arguments: string;
  call_id: string;
  id: string;
  name: string;
  namespace?: string;
  status: 'completed';
  type: 'function_call';
}

interface ResponsesCustomToolCallOutputItem {
  call_id: string;
  id: string;
  input: string;
  name: string;
  namespace?: string;
  status: 'completed';
  type: 'custom_tool_call';
}

type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | OpenAIResponsesReasoningOutputItem
  | ResponsesFunctionCallOutputItem
  | ResponsesCustomToolCallOutputItem;

interface ActiveMessageOutput {
  item: ResponsesMessageOutputItem;
  itemId: string;
  outputIndex: number;
  text: string;
}

interface OpenAIResponsesSignatureState extends SignatureContext {
  store: SignatureStore;
}

interface OpenAIResponsesStreamingMapperOptions {
  clientToolNames?: ReadonlySet<string>;
  model: string;
  responseId: string;
  signatureState?: OpenAIResponsesSignatureState;
  /** The caller declared the `web_search` tool; report grounding as a search. */
  webSearch?: boolean;
}

export class OpenAIResponsesStreamingMapper {
  private readonly reasoningEventEmitter = new OpenAIResponsesReasoningEventEmitter({
    createItemId: () => {
      const itemId = `rs_${this.options.responseId}_${this.messageCounter}`;
      this.messageCounter += 1;
      return itemId;
    },
    emitOutputItem: (item: OpenAIResponsesReasoningOutputItem) => {
      this.outputItems.push(item);
    },
    nextOutputIndex: () => {
      const outputIndex = this.nextOutputIndex;
      this.nextOutputIndex += 1;
      return outputIndex;
    },
    serialize: (event: Record<string, unknown>) => this.serialize(event),
  });
  private readonly toolCallIdIntegrity = new ToolCallIdIntegrityTracker();
  private readonly outputItems: ResponsesOutputItem[] = [];
  private activeMessage: ActiveMessageOutput | null = null;
  private completed = false;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private hasSeenRegularText = false;
  private hasToolCall = false;
  private messageCounter = 0;
  private nextOutputIndex = 0;
  private sequenceNumber = 0;
  private usage: OpenAIResponsesUsage | undefined;
  private latestResponseSignature: string | null = null;
  private webSearchResults: WebSearchResultSet | null = null;

  constructor(private readonly options: OpenAIResponsesStreamingMapperOptions) {}

  public setModel(model: string): void {
    const normalized = model.trim();
    if (normalized) {
      this.options.model = normalized;
    }
  }

  public createResponseCreatedEvent(): string {
    return this.serialize({
      response: {
        background: false,
        created_at: this.createdAt,
        error: null,
        id: this.options.responseId,
        incomplete_details: null,
        model: this.options.model,
        object: 'response',
        output: [],
        status: 'in_progress',
      },
      type: 'response.created',
    });
  }

  public createResponseInProgressEvent(): string {
    return this.serialize({
      response: {
        background: false,
        created_at: this.createdAt,
        error: null,
        id: this.options.responseId,
        incomplete_details: null,
        model: this.options.model,
        object: 'response',
        output: [],
        status: 'in_progress',
      },
      type: 'response.in_progress',
    });
  }

  public processPart(part: GeminiResponsesStreamPart): string[] {
    if (this.completed) {
      return [];
    }

    const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature);
    if (signature) {
      this.latestResponseSignature = signature;
    }

    const potentialReasoning = part.text ? parsePotentialWrappedReasoning(part.text) : null;
    const isThought = part.thought === true || potentialReasoning?.isWrappedReasoning === true;
    if (part.functionCall) {
      return this.processFunctionCall(part.functionCall, signature);
    }

    if (isThought && part.text) {
      return this.processThought(potentialReasoning?.text ?? part.text);
    }

    if (part.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || 'image/jpeg';
      return this.processText(
        `\n\n![Generated Image](data:${mimeType};base64,${part.inlineData.data})\n\n`,
      );
    }

    if (part.text) {
      return this.processText(part.text);
    }

    return [];
  }

  public processGrounding(grounding: GeminiResponsesGroundingMetadata): string[] {
    const groundingText = renderGroundingMarkdown(
      grounding.webSearchQueries,
      grounding.groundingChunks,
    );

    return groundingText ? this.processText(groundingText) : [];
  }

  /**
   * Records grounding for a caller that asked for the search tool.
   *
   * Nothing is emitted here. The upstream reports the search only once it is
   * over, usually on the closing frames, so the `web_search_call` item and the
   * citations it produced are emitted from {@link complete} rather than as
   * invented progress events.
   */
  public captureWebSearchGrounding(grounding: GroundingMetadata | undefined | null): void {
    this.webSearchResults = mergeWebSearchResultSets(
      this.webSearchResults,
      toWebSearchResultSet(grounding),
    );
  }

  public setUsage(usage: OpenAIResponsesUsage): void {
    this.usage = usage;
  }

  public complete(finishReason?: string | null): string[] {
    if (this.completed) {
      return [];
    }

    this.completed = true;
    const incompleteReason = toIncompleteReason(finishReason);
    const status = incompleteReason ? 'incomplete' : 'completed';
    const events = [
      ...this.closeThought(status),
      ...this.closeMessage(this.hasToolCall ? 'commentary' : 'final_answer', status),
      ...this.emitWebSearchCallItem(),
    ];

    events.push(
      this.serialize({
        response: {
          background: false,
          created_at: this.createdAt,
          error: null,
          id: this.options.responseId,
          incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
          model: this.options.model,
          object: 'response',
          output: this.outputItems,
          status,
          usage: this.usage,
        },
        type: incompleteReason ? 'response.incomplete' : 'response.completed',
      }),
    );
    return events;
  }

  public fail(error: unknown): string[] {
    if (this.completed) {
      return [];
    }

    this.completed = true;
    const message = error instanceof Error ? error.message : String(error);
    const events = [
      ...this.closeThought('incomplete'),
      ...this.closeMessage(this.hasToolCall ? 'commentary' : 'final_answer', 'incomplete'),
    ];
    events.push(
      this.serialize({
        response: {
          background: false,
          created_at: this.createdAt,
          error: {
            code: 'server_error',
            message,
            type: 'server_error',
          },
          id: this.options.responseId,
          incomplete_details: null,
          model: this.options.model,
          object: 'response',
          output: this.outputItems,
          status: 'failed',
          usage: this.usage,
        },
        type: 'response.failed',
      }),
    );
    return events;
  }

  private startMessage(): string[] {
    if (this.activeMessage) {
      return [];
    }

    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    const itemId = `msg_${this.options.responseId}_${this.messageCounter}`;
    this.messageCounter += 1;
    const item: ResponsesMessageOutputItem = {
      content: [{ annotations: [], text: '', type: 'output_text' }],
      id: itemId,
      phase: 'commentary',
      role: 'assistant',
      status: 'completed',
      type: 'message',
    };
    const activeOutput = {
      item,
      itemId,
      outputIndex,
      text: '',
    };
    this.activeMessage = activeOutput;
    this.outputItems.push(item);

    return [
      this.serialize({
        item: {
          content: [],
          id: itemId,
          phase: 'commentary',
          role: 'assistant',
          status: 'in_progress',
          type: 'message',
        },
        output_index: outputIndex,
        type: 'response.output_item.added',
      }),
      this.serialize({
        content_index: 0,
        item_id: itemId,
        output_index: outputIndex,
        part: {
          annotations: [],
          text: '',
          type: 'output_text',
        },
        type: 'response.content_part.added',
      }),
    ];
  }

  private closeThought(status: 'completed' | 'incomplete' = 'completed'): string[] {
    return this.reasoningEventEmitter.closeThought(status);
  }

  private closeMessage(
    phase: 'commentary' | 'final_answer',
    status: 'completed' | 'incomplete' = 'completed',
  ): string[] {
    const message = this.activeMessage;
    if (!message) {
      return [];
    }
    this.activeMessage = null;
    return this.finishMessage(message, phase, status);
  }

  private finishMessage(
    message: ActiveMessageOutput,
    phase: 'commentary' | 'final_answer',
    status: 'completed' | 'incomplete',
  ): string[] {
    const annotations: unknown[] = buildOpenAIUrlCitationAnnotations(
      message.text,
      this.webSearchResults,
    );
    message.item.content = [{ annotations, text: message.text, type: 'output_text' }];
    message.item.phase = phase;
    message.item.status = status;
    return [
      this.serialize({
        content_index: 0,
        item_id: message.itemId,
        output_index: message.outputIndex,
        text: message.text,
        type: 'response.output_text.done',
      }),
      this.serialize({
        content_index: 0,
        item_id: message.itemId,
        output_index: message.outputIndex,
        part: {
          annotations,
          text: message.text,
          type: 'output_text',
        },
        type: 'response.content_part.done',
      }),
      this.serialize({
        item: message.item,
        output_index: message.outputIndex,
        type: 'response.output_item.done',
      }),
    ];
  }

  /**
   * The `web_search_call` output item, emitted last.
   *
   * The non-streaming mapper puts this item ahead of the message because it can
   * see the whole answer at once. A stream cannot: the message has already been
   * opened and its text delivered by the time the upstream mentions grounding,
   * so the item is appended in the order the facts actually arrived rather than
   * back-dated to a position the events never had.
   */
  private emitWebSearchCallItem(): string[] {
    const resultSet = this.webSearchResults;
    if (!resultSet) {
      return [];
    }

    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    const item = buildOpenAIWebSearchCallItem(
      resultSet,
      `ws_${this.options.responseId}_${outputIndex}`,
    );
    this.outputItems.push(item as unknown as ResponsesOutputItem);

    return [
      this.serialize({
        item: { ...item, status: 'in_progress' },
        output_index: outputIndex,
        type: 'response.output_item.added',
      }),
      this.serialize({
        item,
        output_index: outputIndex,
        type: 'response.output_item.done',
      }),
    ];
  }

  private processFunctionCall(
    functionCall: NonNullable<GeminiResponsesStreamPart['functionCall']>,
    signature?: string,
  ): string[] {
    const functionArgs = normalizeFunctionCallArgs(functionCall);
    const splitName = splitNamespaceToolName(functionCall.name);
    const functionName = this.options.clientToolNames
      ? resolveShellToolName(splitName.name, this.options.clientToolNames)
      : splitName.name;
    const callId = functionCall.id || `call_${this.options.responseId}_${this.nextOutputIndex}`;
    const normalizedArguments = this.normalizeShellArguments(functionName, functionArgs);
    const isCustomTool = isCustomToolCall(functionName) || functionName === 'shell';
    const argumentsString = JSON.stringify(normalizedArguments);
    let input = isCustomTool
      ? isCustomToolCall(functionName)
        ? extractCustomToolInput(functionName, normalizedArguments)
        : argumentsString
      : undefined;
    if (isCustomToolCall(functionName) && input !== undefined) {
      const optimizedPatch = optimizeApplyPatch(input);
      const validationError = validateApplyPatchV4A(optimizedPatch.input);
      if (validationError) {
        return this.processText(
          `[apply_patch rejected: invalid V4A syntax at line ${validationError.line}: ${validationError.message}]`,
        );
      }
      input = optimizedPatch.input;
    }

    const integrity = this.toolCallIdIntegrity.record(
      functionCall.id,
      functionCall.name,
      functionArgs,
    );
    const capturedSignature = signature ?? this.latestResponseSignature;
    if (capturedSignature && this.options.signatureState) {
      this.options.signatureState.store.store(
        {
          accountId: this.options.signatureState.accountId,
          model: this.options.signatureState.model,
          toolCallId: callId,
        },
        capturedSignature,
      );
    }
    if (integrity === 'replay') {
      return [];
    }

    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    const itemId = `item_${this.options.responseId}_${outputIndex}`;

    const inProgressItem = isCustomTool
      ? {
          call_id: callId,
          id: itemId,
          input: '',
          name: functionName,
          ...(splitName.namespace ? { namespace: splitName.namespace } : {}),
          status: 'in_progress' as const,
          type: 'custom_tool_call' as const,
        }
      : {
          arguments: '',
          call_id: callId,
          id: itemId,
          name: functionName,
          ...(splitName.namespace ? { namespace: splitName.namespace } : {}),
          status: 'in_progress' as const,
          type: 'function_call' as const,
        };
    const completedItem: ResponsesFunctionCallOutputItem | ResponsesCustomToolCallOutputItem =
      isCustomTool
        ? {
            call_id: callId,
            id: itemId,
            input: input ?? '',
            name: functionName,
            ...(splitName.namespace ? { namespace: splitName.namespace } : {}),
            status: 'completed',
            type: 'custom_tool_call',
          }
        : {
            arguments: argumentsString,
            call_id: callId,
            id: itemId,
            name: functionName,
            ...(splitName.namespace ? { namespace: splitName.namespace } : {}),
            status: 'completed',
            type: 'function_call',
          };
    this.outputItems.push(completedItem);

    this.hasToolCall = true;
    const events = [
      ...this.closeThought(),
      ...this.closeMessage('commentary'),
      this.serialize({
        item: inProgressItem,
        output_index: outputIndex,
        type: 'response.output_item.added',
      }),
    ];

    if (isCustomTool) {
      events.push(
        this.serialize({
          call_id: callId,
          delta: input ?? '',
          item_id: itemId,
          output_index: outputIndex,
          type: 'response.custom_tool_call_input.delta',
        }),
        this.serialize({
          call_id: callId,
          input: input ?? '',
          item_id: itemId,
          output_index: outputIndex,
          type: 'response.custom_tool_call_input.done',
        }),
      );
    } else {
      events.push(
        this.serialize({
          delta: argumentsString,
          item_id: itemId,
          output_index: outputIndex,
          type: 'response.function_call_arguments.delta',
        }),
        this.serialize({
          arguments: argumentsString,
          item_id: itemId,
          output_index: outputIndex,
          type: 'response.function_call_arguments.done',
        }),
      );
    }

    events.push(
      this.serialize({
        item: completedItem,
        output_index: outputIndex,
        type: 'response.output_item.done',
      }),
    );

    return events;
  }

  private processText(text: string): string[] {
    const events = [...this.closeThought(), ...this.startMessage()];
    const message = this.activeMessage;
    if (!message) {
      throw new Error('Responses text item failed to start');
    }
    this.hasSeenRegularText = true;
    message.text += text;
    events.push(
      this.serialize({
        content_index: 0,
        delta: text,
        item_id: message.itemId,
        output_index: message.outputIndex,
        type: 'response.output_text.delta',
      }),
    );
    return events;
  }

  private processThought(text: string): string[] {
    if (this.hasSeenRegularText) {
      return [];
    }
    return this.reasoningEventEmitter.processThought(text);
  }

  private normalizeShellArguments(
    functionName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!['shell', 'bash', 'local_shell'].includes(functionName) || 'command' in args) {
      return args;
    }

    for (const alternativeKey of ['cmd', 'code', 'script', 'shell_command']) {
      if (alternativeKey in args) {
        const { [alternativeKey]: command, ...remainingArgs } = args;
        return {
          ...remainingArgs,
          command,
        };
      }
    }
    return args;
  }

  private serialize(event: Record<string, unknown>): string {
    const type = typeof event.type === 'string' ? event.type : 'message';
    const sequencedEvent = {
      ...event,
      sequence_number: this.sequenceNumber,
    };
    this.sequenceNumber += 1;
    return `event: ${type}\ndata: ${JSON.stringify(sequencedEvent)}\n\n`;
  }
}

function toIncompleteReason(finishReason: string | null | undefined): string | null {
  const normalized = finishReason?.toUpperCase();
  if (normalized === 'MAX_TOKENS' || normalized === 'LENGTH') {
    return 'max_output_tokens';
  }
  if (
    normalized === 'CONTENT_FILTER' ||
    normalized === 'SAFETY' ||
    normalized === 'RECITATION' ||
    normalized === 'BLOCKLIST' ||
    normalized === 'PROHIBITED_CONTENT' ||
    normalized === 'SPII'
  ) {
    return 'content_filter';
  }
  return null;
}
