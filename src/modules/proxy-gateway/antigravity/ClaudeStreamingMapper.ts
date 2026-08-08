import { GeminiPart, GroundingChunk, GroundingMetadata, Usage, UsageMetadata } from './types';
import {
  accumulateGroundingMetadata,
  createGroundingAccumulator,
  renderGroundingMarkdown,
} from './grounding-citations';
import {
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  buildAnthropicWebSearchBlocks,
  buildAnthropicWebSearchCitations,
} from './anthropic-web-search-blocks';
import { toWebSearchResultSet, type WebSearchResultSet } from './web-search-results';
import { v4 as uuidv4 } from 'uuid';
import type { SignatureContext, SignatureStore } from './SignatureStore';
import { decodeSignature } from './signature-utils';
import { logger } from '@/shared/logging/logger';
import { normalizeFunctionCallArgs } from './function-call-args';
import { StopSequenceScanner } from './stop-sequences';
import { ToolCallIdIntegrityTracker } from './tool-call-id-integrity';

type BlockType = 'None' | 'Text' | 'Thinking' | 'Function';

export interface StreamingSignatureState extends SignatureContext {
  store: SignatureStore;
}

export interface StreamingMappingOptions {
  /** See `ResponseMappingOptions.webSearch`; same gate, streaming side. */
  webSearch?: boolean;
  /** See `ResponseMappingOptions.stopSequences`; same enforcement, streaming side. */
  stopSequences?: readonly string[];
}

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
  private terminalErrorSent: boolean = false;
  private usedTool: boolean = false;
  private signatures: SignatureManagerImpl = new SignatureManagerImpl();
  private latestResponseSignature: string | null = null;
  /**
   * See `NonStreamingProcessor.pendingSignature`: a `thoughtSignature` from a
   * part with no thought text, held for the next block that may carry one and
   * never emitted as a block of its own.
   */
  public pendingSignature: string | null = null;

  // Web Search / Grounding buffers, filled by captureGrounding as frames arrive
  public webSearchQuery: string | null = null;
  public groundingChunks: GroundingChunk[] | null = null;
  private readonly grounding = createGroundingAccumulator();
  /** Everything sent as `text_delta`, which is the string citations address. */
  private streamedText = '';

  private parseErrorCount: number = 0;
  private readonly stopScanner: StopSequenceScanner;

  constructor(
    public readonly signatureState?: StreamingSignatureState,
    private readonly fallbackModel: string = '',
    private readonly options: StreamingMappingOptions = {},
  ) {
    this.stopScanner = new StopSequenceScanner(options.stopSequences ?? []);
  }

  /**
   * Feeds answer text through the stop-sequence scanner.
   *
   * Returns the part of `text` that may be streamed now; the caller emits
   * nothing when this is empty. See `stop-sequences.ts` for why the cut is made
   * here rather than upstream.
   */
  public admitText(text: string): string {
    return this.stopScanner.push(text);
  }

  /** True once a stop sequence has fired and no further content may be emitted. */
  public get stopped(): boolean {
    return this.stopScanner.stopped;
  }

  /**
   * Records the grounding a streamed candidate carried.
   *
   * Web search grounding rides on the ordinary generate call, so citations
   * arrive as `candidates[].groundingMetadata` on the SSE frames rather than as
   * content parts. Without this the buffers above stay empty and the trailing
   * source list `emitFinish` renders never has anything to render.
   */
  public captureGrounding(grounding: GroundingMetadata | undefined | null): void {
    accumulateGroundingMetadata(this.grounding, grounding);
    if (this.grounding.webSearchQueries.length > 0) {
      this.webSearchQuery = this.grounding.webSearchQueries.join(', ');
    }
    if (this.grounding.groundingChunks.length > 0) {
      this.groundingChunks = this.grounding.groundingChunks;
    }
  }

  public emit(eventType: string, data: any): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  public emitMessageStart(rawJson: any): string {
    if (this.messageStartSent) return '';

    const usageMeta = rawJson.usageMetadata;
    const usage: Usage = usageMeta
      ? {
          input_tokens: usageMeta.total_input_tokens ?? usageMeta.promptTokenCount ?? 0,
          output_tokens: usageMeta.total_output_tokens ?? usageMeta.candidatesTokenCount ?? 0,
          cache_read_input_tokens:
            usageMeta.total_cached_tokens ??
            usageMeta.cachedContentTokenCount ??
            usageMeta.cachedTokens ??
            0,
          reasoning_tokens:
            usageMeta.total_thought_tokens ??
            usageMeta.totalThoughtTokens ??
            usageMeta.thoughtsTokenCount ??
            0,
        }
      : { input_tokens: 0, output_tokens: 0 };

    const message = {
      id: rawJson.responseId || 'msg_unknown',
      type: 'message',
      role: 'assistant',
      content: [],
      model: rawJson.modelVersion || this.fallbackModel,
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

    // Text held back as a possible stop-sequence head belongs to the block being
    // closed, whatever closes it — the end of the stream or the block that
    // follows it. A sequence never straddles a block boundary.
    if (this.blockType === 'Text') {
      const withheld = this.stopScanner.flush();
      if (withheld) {
        chunks.push(this.emitDelta('text_delta', { text: withheld }));
      }
    }

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
    if (deltaType === 'text_delta' && typeof deltaContent?.text === 'string') {
      // Accumulated at the single point every text delta passes through, so the
      // string citations are resolved against is exactly what the client saw.
      this.streamedText += deltaContent.text;
    }
    const delta = { type: deltaType, ...deltaContent };
    return this.emit('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: delta,
    });
  }

  public emitFinish(finishReason?: string, usageMetadata?: UsageMetadata): string[] {
    if (this.terminalErrorSent) {
      return [];
    }
    const chunks: string[] = [];

    // Close last block; `endBlock` releases any withheld tail it owns.
    chunks.push(...this.endBlock());

    // An unattached signature is dropped rather than emitted as an empty
    // thinking block, matching the non-streaming mapper.
    this.pendingSignature = null;

    const webSearchResultSet = this.options.webSearch ? toWebSearchResultSet(this.grounding) : null;

    if (webSearchResultSet) {
      chunks.push(...this.emitWebSearchBlocks(webSearchResultSet));
    } else {
      // Process grounding (web search) -> convert to Markdown text block.
      // Inline `[n]` markers are deliberately not attempted here: the prose they
      // annotate has already been streamed to the client by the time grounding
      // arrives, so only the trailing source list can still be emitted.
      const groundingText = renderGroundingMarkdown(
        this.webSearchQuery ? [this.webSearchQuery] : null,
        this.groundingChunks,
      );

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
    }

    // Determine stop reason
    const firedStopSequence = this.stopScanner.sequence;
    let stopReason = 'end_turn';
    if (firedStopSequence !== null) {
      // See the non-streaming mapper: the generation was cut here, so this
      // outranks whatever the upstream reported about a longer answer.
      stopReason = 'stop_sequence';
    } else if (this.usedTool) {
      stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    } else if (
      finishReason === 'SAFETY' ||
      finishReason === 'RECITATION' ||
      finishReason === 'BLOCKLIST' ||
      finishReason === 'PROHIBITED_CONTENT' ||
      finishReason === 'SPII' ||
      finishReason === 'IMAGE_SAFETY' ||
      finishReason === 'IMAGE_PROHIBITED_CONTENT'
    ) {
      stopReason = 'refusal';
    }

    const usage: Usage = usageMetadata
      ? {
          input_tokens: usageMetadata.total_input_tokens ?? usageMetadata.promptTokenCount ?? 0,
          output_tokens:
            usageMetadata.total_output_tokens ?? usageMetadata.candidatesTokenCount ?? 0,
          cache_read_input_tokens:
            usageMetadata.total_cached_tokens ??
            usageMetadata.cachedContentTokenCount ??
            usageMetadata.cachedTokens ??
            0,
          reasoning_tokens:
            usageMetadata.total_thought_tokens ??
            usageMetadata.totalThoughtTokens ??
            usageMetadata.thoughtsTokenCount ??
            0,
        }
      : { input_tokens: 0, output_tokens: 0 };
    if (webSearchResultSet) {
      usage.server_tool_use = { web_search_requests: webSearchResultSet.requestCount };
    }

    chunks.push(
      this.emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: firedStopSequence },
        usage: usage,
      }),
    );

    if (!this.messageStopSent) {
      chunks.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      this.messageStopSent = true;
    }

    return chunks;
  }

  /**
   * The search blocks, emitted once the upstream stream is done.
   *
   * Grounding metadata only lands on the final frames, long after the prose it
   * annotates has been streamed. Rather than invent incremental events for a
   * search whose progress the upstream never reported, the whole thing is
   * emitted here: the `server_tool_use` with its query, the
   * `web_search_tool_result` with its sources, and a trailing empty text block
   * whose `citations_delta` events carry the spans back to the client.
   */
  private emitWebSearchBlocks(resultSet: WebSearchResultSet): string[] {
    const chunks: string[] = [];
    const { serverToolUse, toolResult } = buildAnthropicWebSearchBlocks(
      resultSet,
      `srvtoolu_${uuidv4()}`,
      ANTHROPIC_WEB_SEARCH_TOOL_NAME,
    );

    chunks.push(
      this.emit('content_block_start', {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: { ...serverToolUse, input: {} },
      }),
    );
    chunks.push(
      this.emitDelta('input_json_delta', { partial_json: JSON.stringify(serverToolUse.input) }),
    );
    chunks.push(
      this.emit('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }),
    );
    this.blockIndex++;

    chunks.push(
      this.emit('content_block_start', {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: toolResult,
      }),
    );
    chunks.push(
      this.emit('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }),
    );
    this.blockIndex++;

    const citations = buildAnthropicWebSearchCitations(this.streamedText, resultSet);
    if (citations.length === 0) {
      return chunks;
    }

    chunks.push(
      this.emit('content_block_start', {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: { type: 'text', text: '', citations: [] },
      }),
    );
    for (const citation of citations) {
      chunks.push(this.emitDelta('citations_delta', { citation }));
    }
    chunks.push(
      this.emit('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }),
    );
    this.blockIndex++;

    return chunks;
  }

  public emitTerminalError(type: string, message: string): string[] {
    if (this.terminalErrorSent || this.messageStopSent) {
      return [];
    }
    const chunks = this.endBlock();
    chunks.push(
      this.emit('error', {
        type: 'error',
        error: { type, message },
      }),
    );
    this.terminalErrorSent = true;
    return chunks;
  }

  public markToolUsed() {
    this.usedTool = true;
  }

  public currentBlockType(): BlockType {
    return this.blockType;
  }

  public storeSignature(signature?: string) {
    this.signatures.store(signature);
  }

  public recordResponseSignature(signature?: string): void {
    if (signature) {
      this.latestResponseSignature = signature;
    }
  }

  public getResponseSignature(): string | null {
    return this.latestResponseSignature;
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

    // Emit error event if too many errors
    if (this.parseErrorCount > 3) {
      logger.error(
        `[SSE-Parser] High error rate (${this.parseErrorCount} errors). Stream may be corrupted.`,
      );
      chunks.push(
        ...this.emitTerminalError(
          'api_error',
          'The upstream returned malformed streaming data repeatedly.',
        ),
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
  private readonly toolCallIdIntegrity = new ToolCallIdIntegrityTracker();

  constructor(private state: StreamingState) {}

  public process(part: GeminiPart): string[] {
    const chunks: string[] = [];
    // Nothing the model produced after a stop sequence fired is part of the
    // answer the caller asked for.
    if (this.state.stopped) {
      return chunks;
    }
    const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature);
    this.state.recordResponseSignature(signature);

    // 1. Handle FunctionCall
    if (part.functionCall) {
      // A signature banked from a text-only part belongs to the call it
      // preceded; the tool_use block carries it.
      const carried = signature ?? this.state.pendingSignature ?? undefined;
      this.state.pendingSignature = null;
      chunks.push(...this.processFunctionCall(part.functionCall, carried));
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

    if (this.state.currentBlockType() !== 'Thinking') {
      chunks.push(...this.state.startBlock('Thinking', { type: 'thinking', thinking: '' }));
    }

    if (text) {
      chunks.push(this.state.emitDelta('thinking_delta', { thinking: text }));
    }

    // A banked signature is adopted by this thought, which is a block that may
    // legally carry one, rather than being emitted as a block of its own.
    const carried = signature ?? this.state.pendingSignature ?? undefined;
    this.state.pendingSignature = null;
    this.state.storeSignature(carried);

    return chunks;
  }

  private processText(text: string, signature?: string): string[] {
    const chunks: string[] = [];

    // Empty text carrying only a signature: bank it, emit nothing.
    if (!text) {
      if (signature) {
        this.state.pendingSignature = signature;
      }
      return chunks;
    }

    // A text part's signature is banked, not turned into a block: it would land
    // after the text it is meant to precede and carry no thought content.
    if (signature) {
      this.state.pendingSignature = signature;
    }

    // Normal text
    const admitted = this.state.admitText(text);
    if (this.state.currentBlockType() !== 'Text') {
      chunks.push(...this.state.startBlock('Text', { type: 'text', text: '' }));
    }
    if (admitted) {
      chunks.push(this.state.emitDelta('text_delta', { text: admitted }));
    }

    return chunks;
  }

  private processFunctionCall(
    fc: { name: string; args: any; id?: string },
    signature?: string,
  ): string[] {
    const chunks: string[] = [];

    const functionArgs = normalizeFunctionCallArgs(fc);
    const integrity = this.toolCallIdIntegrity.record(fc.id, fc.name, functionArgs);

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

    const capturedSignature = signature ?? this.state.getResponseSignature();
    if (capturedSignature && this.state.signatureState) {
      this.state.signatureState.store.store(
        {
          accountId: this.state.signatureState.accountId,
          model: this.state.signatureState.model,
          toolCallId: toolId,
        },
        capturedSignature,
      );
    }
    if (integrity === 'replay') {
      return chunks;
    }

    chunks.push(...this.state.startBlock('Function', toolUse));

    // input_json_delta
    const jsonStr = JSON.stringify(functionArgs);
    chunks.push(this.state.emitDelta('input_json_delta', { partial_json: jsonStr }));

    chunks.push(...this.state.endBlock());

    return chunks;
  }
}
