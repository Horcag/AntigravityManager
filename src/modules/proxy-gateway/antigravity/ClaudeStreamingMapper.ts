import { GeminiPart, GroundingMetadata, Usage, UsageMetadata } from './types';
import { SignatureContext, SignatureStore } from './SignatureStore';
import { decodeSignature } from './signature-utils';
import { ToolCallIdIntegrityTracker } from './tool-call-id-integrity';
import { logger } from '@/shared/logging/logger';
import { mapGeminiFinishReasonToAnthropic } from './gemini-finish-reason';

type BlockType = 'None' | 'Text' | 'Thinking' | 'Function';

interface SignatureManager {
  pending: string | null;
}

class SignatureManagerImpl implements SignatureManager {
  pending: string | null = null;

  store(signature?: string) {
    if (signature) {
      this.pending = signature;
    }
  }

  consume(): string | null {
    const s = this.pending;
    this.pending = null;
    return s;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }
}

/**
 * Streaming State Machine
 */
export class StreamingState {
  private blockType: BlockType = 'None';
  public blockIndex: number = 0;
  public messageStartSent: boolean = false;
  public messageStopSent: boolean = false;
  private usedTool: boolean = false;
  private signatures: SignatureManagerImpl = new SignatureManagerImpl();
  public trailingSignature: string | null = null;

  // Web Search / Grounding buffers
  public webSearchQuery: string | null = null;
  public groundingChunks: GroundingMetadata['groundingChunks'] | null = null;

  private parseErrorCount: number = 0;

  constructor() {}

  public emit(eventType: string, data: any): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  public emitMessageStart(rawJson: any): string {
    if (this.messageStartSent) return '';

    const usageMeta = rawJson.usageMetadata;
    const usage: Usage | undefined = usageMeta
      ? {
          input_tokens: usageMeta.promptTokenCount || 0,
          output_tokens: usageMeta.candidatesTokenCount || 0,
        }
      : undefined;

    const message = {
      id: rawJson.responseId || 'msg_unknown',
      type: 'message',
      role: 'assistant',
      content: [],
      model: rawJson.modelVersion || '',
      stop_reason: null,
      stop_sequence: null,
      usage: usage,
    };

    this.messageStartSent = true;

    return this.emit('message_start', {
      type: 'message_start',
      message: message,
    });
  }

  public startBlock(blockType: BlockType, contentBlock: any): string[] {
    const chunks: string[] = [];
    if (this.blockType !== 'None') {
      chunks.push(...this.endBlock());
    }

    chunks.push(
      this.emit('content_block_start', {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: contentBlock,
      }),
    );

    this.blockType = blockType;
    return chunks;
  }

  public endBlock(): string[] {
    if (this.blockType === 'None') {
      return [];
    }

    const chunks: string[] = [];

    // Send stored signature when Thinking block ends
    if (this.blockType === 'Thinking' && this.signatures.hasPending()) {
      const sig = this.signatures.consume();
      if (sig) {
        // emit_delta "signature_delta"
        chunks.push(this.emitDelta('signature_delta', { signature: sig }));
      }
    }

    chunks.push(
      this.emit('content_block_stop', {
        type: 'content_block_stop',
        index: this.blockIndex,
      }),
    );

    this.blockIndex++;
    this.blockType = 'None';

    return chunks;
  }

  public emitDelta(deltaType: string, deltaContent: any): string {
    const delta = { type: deltaType, ...deltaContent };
    return this.emit('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: delta,
    });
  }

  public emitFinish(finishReason?: string, usageMetadata?: UsageMetadata): string[] {
    const chunks: string[] = [];

    // Close last block
    chunks.push(...this.endBlock());

    // Process trailing signature (PDF 776-778 logic)
    if (this.trailingSignature) {
      const sig = this.trailingSignature;
      this.trailingSignature = null;

      chunks.push(
        this.emit('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );

      chunks.push(this.emitDelta('thinking_delta', { thinking: '' }));
      chunks.push(this.emitDelta('signature_delta', { signature: sig }));

      chunks.push(
        this.emit('content_block_stop', {
          type: 'content_block_stop',
          index: this.blockIndex,
        }),
      );
      this.blockIndex++;
    }

    // Process grounding (web search) -> convert to Markdown text block
    let groundingText = '';
    if (this.webSearchQuery) {
      groundingText += `\n\n---\n**🔍 Searched for you:** ${this.webSearchQuery}`;
    }
    if (this.groundingChunks && this.groundingChunks.length > 0) {
      const links: string[] = [];
      this.groundingChunks.forEach((chunk, i) => {
        if (chunk.web) {
          const title = chunk.web.title || 'Web source';
          const uri = chunk.web.uri || '#';
          links.push(`[${i + 1}] [${title}](${uri})`);
        }
      });
      if (links.length > 0) {
        groundingText += `\n\n**🌐 Citations:**\n` + links.join('\n');
      }
    }

    if (groundingText) {
      chunks.push(
        this.emit('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'text', text: '' },
        }),
      );
      chunks.push(this.emitDelta('text_delta', { text: groundingText }));
      chunks.push(
        this.emit('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }),
      );
      this.blockIndex++;
    }

    // Determine stop reason
    let stopReason: ReturnType<typeof mapGeminiFinishReasonToAnthropic> | 'tool_use' =
      mapGeminiFinishReasonToAnthropic(finishReason);
    if (this.usedTool) {
      stopReason = 'tool_use';
    }

    const usage: Usage = usageMetadata
      ? {
          input_tokens: usageMetadata.promptTokenCount || 0,
          output_tokens: usageMetadata.candidatesTokenCount || 0,
        }
      : { input_tokens: 0, output_tokens: 0 };

    chunks.push(
      this.emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usage,
      }),
    );

    if (!this.messageStopSent) {
      chunks.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      this.messageStopSent = true;
    }

    return chunks;
  }

  public markToolUsed() {
    this.usedTool = true;
  }

  /**
   * Retain only displayable grounding data and merge repeated SSE metadata frames.
   */
  public recordGroundingMetadata(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const grounding = value as Record<string, unknown>;
    const queries = Array.isArray(grounding.webSearchQueries)
      ? grounding.webSearchQueries.filter(
          (query): query is string => typeof query === 'string' && query.trim().length > 0,
        )
      : [];
    const existingQueries = this.webSearchQuery ? this.webSearchQuery.split(', ') : [];
    const uniqueQueries = [...new Set([...existingQueries, ...queries])];
    if (uniqueQueries.length > 0) {
      this.webSearchQuery = uniqueQueries.join(', ');
    }

    const chunks = Array.isArray(grounding.groundingChunks)
      ? grounding.groundingChunks.flatMap((chunk) => {
          if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) {
            return [];
          }
          const web = (chunk as Record<string, unknown>).web;
          if (typeof web !== 'object' || web === null || Array.isArray(web)) {
            return [];
          }
          const webRecord = web as Record<string, unknown>;
          const title = typeof webRecord.title === 'string' ? webRecord.title : undefined;
          const uri = typeof webRecord.uri === 'string' ? webRecord.uri : undefined;
          return title || uri ? [{ web: { title, uri } }] : [];
        })
      : [];

    if (chunks.length > 0) {
      const existingChunks = this.groundingChunks ?? [];
      const existingKeys = new Set(
        existingChunks.map((chunk) => `${chunk.web?.title ?? ''}\u0000${chunk.web?.uri ?? ''}`),
      );
      this.groundingChunks = [
        ...existingChunks,
        ...chunks.filter((chunk) => {
          const key = `${chunk.web?.title ?? ''}\u0000${chunk.web?.uri ?? ''}`;
          if (existingKeys.has(key)) {
            return false;
          }
          existingKeys.add(key);
          return true;
        }),
      ];
    }

    return queries.length > 0 || chunks.length > 0;
  }

  public currentBlockType(): BlockType {
    return this.blockType;
  }

  public storeSignature(signature?: string) {
    this.signatures.store(signature);
  }
  public handleParseError(rawData: string): string[] {
    const chunks: string[] = [];
    this.parseErrorCount++;

    logger.warn(
      `[SSE-Parser] Parse error #${this.parseErrorCount}. Raw data length: ${rawData.length}`,
    );

    // Safely close current block
    if (this.blockType !== 'None') {
      chunks.push(...this.endBlock());
    }

    // The service owns terminal stream errors so each public protocol gets its
    // correct wire envelope instead of a mapper-specific event.
    if (this.parseErrorCount > 3) {
      logger.error(
        `[SSE-Parser] High error rate (${this.parseErrorCount} errors). Stream may be corrupted.`,
      );
    }

    return chunks;
  }

  /**
   * Reset error state (call after recovery)
   */
  public resetErrorState(): void {
    this.parseErrorCount = 0;
  }

  /**
   * Get current error count (for monitoring)
   */
  public getErrorCount(): number {
    return this.parseErrorCount;
  }
}

/**
 * Part Processor
 */
export class PartProcessor {
  /** Signature seen earlier in THIS stream, used only for tool calls of this same stream. */
  private streamSignature: string | null = null;
  private readonly toolCallIdIntegrity = new ToolCallIdIntegrityTracker();

  constructor(
    private state: StreamingState,
    private readonly signatureContext?: SignatureContext,
  ) {}

  public process(part: GeminiPart): string[] {
    const chunks: string[] = [];
    const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature);
    if (signature) {
      this.streamSignature = signature;
    }

    // 1. Handle FunctionCall
    if (part.functionCall) {
      // Handle trailing signature logic
      if (this.state.trailingSignature) {
        chunks.push(...this.state.endBlock());
        const trailingSig = this.state.trailingSignature;
        this.state.trailingSignature = null;

        chunks.push(
          this.state.emit('content_block_start', {
            type: 'content_block_start',
            index: this.state.blockIndex,
            content_block: { type: 'thinking', thinking: '' },
          }),
        );
        chunks.push(this.state.emitDelta('thinking_delta', { thinking: '' }));
        chunks.push(this.state.emitDelta('signature_delta', { signature: trailingSig }));
        chunks.push(...this.state.endBlock());
      }

      chunks.push(...this.processFunctionCall(part.functionCall, signature));
      return chunks;
    }

    // 2. Handle Text
    if (part.text !== undefined) {
      if (part.thought) {
        chunks.push(...this.processThinking(part.text, signature));
      } else {
        chunks.push(...this.processText(part.text, signature));
      }
    }

    // 3. InlineData (Image)
    if (part.inlineData) {
      const { mimeType, data } = part.inlineData;
      if (data) {
        const markdownImg = `![image](data:${mimeType};base64,${data})`;
        chunks.push(...this.processText(markdownImg, undefined));
      }
    }

    return chunks;
  }

  private processThinking(text: string, signature?: string): string[] {
    const chunks: string[] = [];

    // Handle trailing signature
    if (this.state.trailingSignature) {
      chunks.push(...this.state.endBlock());
      const trailingSig = this.state.trailingSignature;
      this.state.trailingSignature = null;

      chunks.push(
        this.state.emit('content_block_start', {
          type: 'content_block_start',
          index: this.state.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      chunks.push(this.state.emitDelta('thinking_delta', { thinking: '' }));
      chunks.push(this.state.emitDelta('signature_delta', { signature: trailingSig }));
      chunks.push(...this.state.endBlock());
    }

    if (this.state.currentBlockType() !== 'Thinking') {
      chunks.push(...this.state.startBlock('Thinking', { type: 'thinking', thinking: '' }));
    }

    if (text) {
      chunks.push(this.state.emitDelta('thinking_delta', { thinking: text }));
    }

    this.state.storeSignature(signature);

    return chunks;
  }

  private processText(text: string, signature?: string): string[] {
    const chunks: string[] = [];

    // Empty text with signature -> store trailing
    if (!text) {
      if (signature) {
        this.state.trailingSignature = signature;
      }
      return chunks;
    }

    // Handle trailing signature
    if (this.state.trailingSignature) {
      chunks.push(...this.state.endBlock());
      const trailingSig = this.state.trailingSignature;
      this.state.trailingSignature = null;

      chunks.push(
        this.state.emit('content_block_start', {
          type: 'content_block_start',
          index: this.state.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      chunks.push(this.state.emitDelta('thinking_delta', { thinking: '' }));
      chunks.push(this.state.emitDelta('signature_delta', { signature: trailingSig }));
      chunks.push(...this.state.endBlock());
    }

    // Non-empty text with signature -> flush immediately
    if (signature) {
      // Start text block
      chunks.push(...this.state.startBlock('Text', { type: 'text', text: '' }));
      chunks.push(this.state.emitDelta('text_delta', { text: text }));
      chunks.push(...this.state.endBlock());

      // Empty thinking block for signature
      chunks.push(
        this.state.emit('content_block_start', {
          type: 'content_block_start',
          index: this.state.blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      chunks.push(this.state.emitDelta('thinking_delta', { thinking: '' }));
      chunks.push(this.state.emitDelta('signature_delta', { signature: signature }));
      chunks.push(...this.state.endBlock());

      return chunks;
    }

    // Normal text
    if (this.state.currentBlockType() !== 'Text') {
      chunks.push(...this.state.startBlock('Text', { type: 'text', text: '' }));
    }
    chunks.push(this.state.emitDelta('text_delta', { text: text }));

    return chunks;
  }

  private processFunctionCall(
    fc: { name: string; args: any; id?: string },
    signature?: string,
  ): string[] {
    const chunks: string[] = [];

    if (this.toolCallIdIntegrity.record(fc.id, fc.name, fc.args) === 'replay') {
      return chunks;
    }

    this.state.markToolUsed();

    const toolId = fc.id || `${fc.name}-${Math.random().toString(36).substr(2, 9)}`;

    const toolUse: any = {
      type: 'tool_use',
      id: toolId,
      name: fc.name,
      input: {}, // Empty, args sent via delta
    };

    if (signature) {
      toolUse.signature = signature;
    }

    // Capture for replay under the id the client actually sees (upstream id when Gemini
    // supplies one, otherwise the generated id), keyed by the account/model that produced it.
    const capturedSignature = signature ?? this.streamSignature;
    if (capturedSignature && this.signatureContext) {
      SignatureStore.store(
        {
          accountId: this.signatureContext.accountId,
          model: this.signatureContext.model,
          toolCallId: toolId,
        },
        capturedSignature,
      );
    }

    chunks.push(...this.state.startBlock('Function', toolUse));

    // input_json_delta
    if (fc.args) {
      const jsonStr = JSON.stringify(fc.args);
      chunks.push(this.state.emitDelta('input_json_delta', { partial_json: jsonStr }));
    }

    chunks.push(...this.state.endBlock());

    return chunks;
  }
}
