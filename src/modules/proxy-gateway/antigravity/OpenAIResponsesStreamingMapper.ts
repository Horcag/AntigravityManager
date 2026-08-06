import { SignatureContext, SignatureStore } from './SignatureStore';
import { decodeSignature } from './signature-utils';

export interface GeminiResponsesStreamPart {
  functionCall?: { args: Record<string, unknown>; id?: string; name: string };
  inlineData?: { data: string; mimeType: string };
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
}

export interface GeminiResponsesGroundingMetadata {
  groundingChunks?: Array<{ web?: { title?: string; uri?: string } }>;
  webSearchQueries?: string[];
}

export interface GeminiResponsesUsageMetadata {
  candidatesTokenCount?: number;
  promptTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

interface ResponsesMessageOutputItem {
  content: Array<{ annotations: []; text: string; type: 'output_text' }>;
  id: string;
  role: 'assistant';
  status: 'completed' | 'in_progress';
  type: 'message';
}

interface ResponsesFunctionCallOutputItem {
  arguments: string;
  call_id: string;
  id: string;
  name: string;
  status: 'completed';
  type: 'function_call';
}

interface PendingFunctionCall {
  arguments: string;
  callId: string;
  id: string;
  name: string;
  outputIndex: number;
}

type ResponsesOutputItem = ResponsesMessageOutputItem | ResponsesFunctionCallOutputItem;

interface OpenAIResponsesStreamingMapperOptions {
  model: string;
  responseId: string;
  signatureContext?: SignatureContext;
}

/** Maps Gemini's streaming parts into the OpenAI Responses SSE event contract. */
export class OpenAIResponsesStreamingMapper {
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly emittedToolCallIds = new Set<string>();
  private readonly messageItemId: string;
  private readonly outputItems: ResponsesOutputItem[] = [];
  private readonly pendingFunctionCalls: PendingFunctionCall[] = [];
  private accumulatedText = '';
  private completed = false;
  private messageOutputItem: ResponsesMessageOutputItem | null = null;
  private nextOutputIndex = 0;
  private sequenceNumber = 0;
  private textOutputIndex: number | null = null;
  private usageMetadata: GeminiResponsesUsageMetadata | undefined;
  /** Signature seen earlier in THIS stream, used only for tool calls of this same stream. */
  private streamSignature: string | null = null;

  constructor(private readonly options: OpenAIResponsesStreamingMapperOptions) {
    this.messageItemId = `msg_${options.responseId}`;
  }

  public createResponseCreatedEvent(): string {
    return this.serialize({ response: this.response('in_progress'), type: 'response.created' });
  }

  public createResponseInProgressEvent(): string {
    return this.serialize({ response: this.response('in_progress'), type: 'response.in_progress' });
  }

  public setUsageMetadata(usageMetadata: GeminiResponsesUsageMetadata | undefined): void {
    if (usageMetadata) {
      this.usageMetadata = usageMetadata;
    }
  }

  public processPart(part: GeminiResponsesStreamPart): string[] {
    if (this.completed) {
      return [];
    }

    const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature);
    if (signature) {
      this.streamSignature = signature;
    }
    if (part.functionCall) {
      return this.processFunctionCall(part.functionCall, signature ?? this.streamSignature);
    }
    if (part.thought) {
      return [];
    }
    if (part.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || 'image/jpeg';
      return this.processText(
        `\n\n![Generated Image](data:${mimeType};base64,${part.inlineData.data})\n\n`,
      );
    }
    return part.text ? this.processText(part.text) : [];
  }

  public processGrounding(grounding: GeminiResponsesGroundingMetadata): string[] {
    let groundingText = '';
    if (grounding.webSearchQueries?.length) {
      groundingText += `\n\n---\n**🔍 Searched for you:** ${grounding.webSearchQueries.join(', ')}`;
    }
    const links = grounding.groundingChunks?.flatMap((chunk, index) => {
      if (!chunk.web) {
        return [];
      }
      return [`[${index + 1}] [${chunk.web.title || 'Web source'}](${chunk.web.uri || '#'})`];
    });
    if (links?.length) {
      groundingText += `\n\n**🌐 Citations:**\n${links.join('\n')}`;
    }
    return groundingText ? this.processText(groundingText) : [];
  }

  public complete(): string[] {
    if (this.completed) {
      return [];
    }
    this.completed = true;
    const events = this.completeTextItem();
    for (const functionCall of this.pendingFunctionCalls) {
      events.push(...this.emitFunctionCall(functionCall));
    }
    events.push(
      this.serialize({ response: this.response('completed'), type: 'response.completed' }),
    );
    return events;
  }

  public fail(message: string, code = 'upstream_error'): string[] {
    if (this.completed) {
      return [];
    }
    this.completed = true;
    const error = { code, message };
    return [
      this.serialize({ code, message, param: null, type: 'error' }),
      this.serialize({ response: this.response('failed', error), type: 'response.failed' }),
    ];
  }

  private completeTextItem(): string[] {
    if (this.textOutputIndex === null || !this.messageOutputItem) {
      return [];
    }
    this.messageOutputItem.content = [
      { annotations: [], text: this.accumulatedText, type: 'output_text' },
    ];
    return [
      this.serialize({
        content_index: 0,
        item_id: this.messageItemId,
        output_index: this.textOutputIndex,
        text: this.accumulatedText,
        type: 'response.output_text.done',
      }),
      this.serialize({
        content_index: 0,
        item_id: this.messageItemId,
        output_index: this.textOutputIndex,
        part: { annotations: [], text: this.accumulatedText, type: 'output_text' },
        type: 'response.content_part.done',
      }),
      this.serialize({
        item: this.messageOutputItem,
        output_index: this.textOutputIndex,
        type: 'response.output_item.done',
      }),
    ];
  }

  private ensureTextStarted(): string[] {
    if (this.textOutputIndex !== null) {
      return [];
    }
    this.textOutputIndex = this.nextOutputIndex++;
    this.messageOutputItem = {
      content: [{ annotations: [], text: '', type: 'output_text' }],
      id: this.messageItemId,
      role: 'assistant',
      status: 'completed',
      type: 'message',
    };
    this.outputItems.push(this.messageOutputItem);
    return [
      this.serialize({
        item: {
          content: [],
          id: this.messageItemId,
          role: 'assistant',
          status: 'in_progress',
          type: 'message',
        },
        output_index: this.textOutputIndex,
        type: 'response.output_item.added',
      }),
      this.serialize({
        content_index: 0,
        item_id: this.messageItemId,
        output_index: this.textOutputIndex,
        part: { annotations: [], text: '', type: 'output_text' },
        type: 'response.content_part.added',
      }),
    ];
  }

  private processFunctionCall(
    functionCall: NonNullable<GeminiResponsesStreamPart['functionCall']>,
    signature?: string | null,
  ): string[] {
    const outputIndex = this.nextOutputIndex++;
    const callId = functionCall.id || `call_${this.options.responseId}_${outputIndex}`;
    if (functionCall.id && this.emittedToolCallIds.has(callId)) {
      return [];
    }
    if (functionCall.id) {
      this.emittedToolCallIds.add(callId);
    }
    if (signature && this.options.signatureContext) {
      SignatureStore.store({ ...this.options.signatureContext, toolCallId: callId }, signature);
    }
    const argumentsString = JSON.stringify(
      this.normalizeShellArguments(functionCall.name, functionCall.args),
    );
    const itemId = `fc_${this.options.responseId}_${outputIndex}`;
    const pendingFunctionCall = {
      arguments: argumentsString,
      callId,
      id: itemId,
      name: functionCall.name,
      outputIndex,
    };
    this.outputItems.push({
      arguments: argumentsString,
      call_id: callId,
      id: itemId,
      name: functionCall.name,
      status: 'completed',
      type: 'function_call',
    });
    // A later-index tool call cannot finish before a streaming text item that precedes it.
    if (this.textOutputIndex !== null) {
      this.pendingFunctionCalls.push(pendingFunctionCall);
      return [];
    }
    return this.emitFunctionCall(pendingFunctionCall);
  }

  private emitFunctionCall(functionCall: PendingFunctionCall): string[] {
    const inProgressItem = {
      arguments: '',
      call_id: functionCall.callId,
      id: functionCall.id,
      name: functionCall.name,
      status: 'in_progress',
      type: 'function_call' as const,
    };
    const completedItem: ResponsesFunctionCallOutputItem = {
      arguments: functionCall.arguments,
      call_id: functionCall.callId,
      id: functionCall.id,
      name: functionCall.name,
      status: 'completed',
      type: 'function_call',
    };
    return [
      this.serialize({
        item: inProgressItem,
        output_index: functionCall.outputIndex,
        type: 'response.output_item.added',
      }),
      this.serialize({
        delta: functionCall.arguments,
        item_id: functionCall.id,
        output_index: functionCall.outputIndex,
        type: 'response.function_call_arguments.delta',
      }),
      this.serialize({
        arguments: functionCall.arguments,
        item_id: functionCall.id,
        name: functionCall.name,
        output_index: functionCall.outputIndex,
        type: 'response.function_call_arguments.done',
      }),
      this.serialize({
        item: completedItem,
        output_index: functionCall.outputIndex,
        type: 'response.output_item.done',
      }),
    ];
  }

  private processText(text: string): string[] {
    const events = this.ensureTextStarted();
    this.accumulatedText += text;
    events.push(
      this.serialize({
        content_index: 0,
        delta: text,
        item_id: this.messageItemId,
        output_index: this.textOutputIndex,
        type: 'response.output_text.delta',
      }),
    );
    return events;
  }

  private response(
    status: 'completed' | 'failed' | 'in_progress',
    error: { code: string; message: string } | null = null,
  ): Record<string, unknown> {
    const completedAt = status === 'completed' ? Math.floor(Date.now() / 1000) : null;
    return {
      id: this.options.responseId,
      object: 'response',
      created_at: this.createdAt,
      completed_at: completedAt,
      error,
      incomplete_details: null,
      model: this.options.model,
      output: status === 'failed' ? this.failedOutputItems() : this.outputItems,
      parallel_tool_calls: true,
      status,
      usage: status === 'completed' ? this.usage() : null,
    };
  }

  private failedOutputItems(): ResponsesOutputItem[] {
    return this.outputItems.map((item) => {
      if (item.type !== 'message') {
        return item;
      }
      return {
        ...item,
        content: [{ annotations: [], text: this.accumulatedText, type: 'output_text' }],
        status: 'in_progress',
      };
    });
  }

  private usage(): Record<string, unknown> {
    const inputTokens = this.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = this.usageMetadata?.candidatesTokenCount ?? 0;
    return {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: this.usageMetadata?.thoughtsTokenCount ?? 0 },
      total_tokens: this.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens,
    };
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
        return { ...remainingArgs, command };
      }
    }
    return args;
  }

  private serialize(event: Record<string, unknown>): string {
    const payload = { ...event, sequence_number: this.sequenceNumber++ };
    return `event: ${String(event.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
  }
}
