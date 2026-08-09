import { v4 as uuidv4 } from 'uuid';
import {
  ClaudeResponse,
  GeminiResponse,
  GeminiPart,
  ContentBlock,
  Usage,
  GroundingMetadata,
} from './types';
import { applyGroundingCitations, renderGroundingMarkdown } from './grounding-citations';
import { toAnthropicUsage } from '../server/common/usage/anthropic-usage';
import {
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  buildAnthropicWebSearchBlocks,
  buildAnthropicWebSearchCitations,
  type AnthropicWebSearchCitation,
} from './anthropic-web-search-blocks';
import { toWebSearchResultSet, type WebSearchResultSet } from './web-search-results';
import { decodeSignature } from './signature-utils';
import type { SignatureContext, SignatureStore } from './SignatureStore';
import { normalizeFunctionCallArgs } from './function-call-args';
import { StopSequenceScanner } from './stop-sequences';
import { ToolCallIdIntegrityTracker } from './tool-call-id-integrity';

export interface ResponseSignatureState extends SignatureContext {
  store: SignatureStore;
}

export interface ResponseMappingOptions {
  /**
   * The caller's `stop_sequences`. Enforced here rather than upstream so the
   * sequence that fired can be named; see `stop-sequences.ts`.
   */
  stopSequences?: readonly string[];
  /**
   * The caller declared the `web_search_20250305` server tool, so grounding is
   * reported as Anthropic's search blocks and citations. Without it grounding
   * keeps rendering as the trailing markdown a caller who never asked for
   * search still receives, so no existing client's output changes shape.
   */
  webSearch?: boolean;
}

/**
 * Non-streaming response processor (Gemini -> Claude)
 *
 */
class NonStreamingProcessor {
  private contentBlocks: ContentBlock[] = [];
  private textBuilder: string = '';
  private thinkingBuilder: string = '';
  private thinkingSignature: string | null = null;
  /**
   * A `thoughtSignature` seen on a part that carries no thought text.
   *
   * It is held so the next block that may legally carry a signature — a real
   * thinking block, or a `tool_use` — can adopt it. It is never materialised
   * into a block of its own: an empty `thinking` string with a signature is not
   * a valid Anthropic block, it appears after the text rather than before it,
   * and a client echoing the turn back feeds the fabrication upstream.
   */
  private pendingSignature: string | null = null;
  private hasToolCall: boolean = false;
  private responseSignature: string | null = null;
  private readonly toolCallIdIntegrity = new ToolCallIdIntegrityTracker();
  private webSearchResultSet: WebSearchResultSet | null = null;
  private pendingCitations: AnthropicWebSearchCitation[] | null = null;
  private readonly stopScanner: StopSequenceScanner;

  constructor(
    private readonly signatureState?: ResponseSignatureState,
    private readonly options: ResponseMappingOptions = {},
  ) {
    this.stopScanner = new StopSequenceScanner(options.stopSequences ?? []);
  }

  public process(geminiResponse: GeminiResponse): ClaudeResponse {
    const candidate = geminiResponse.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // 1. Process all parts. Nothing the model produced after a stop sequence
    // fired is part of the answer the caller asked for.
    for (const part of parts) {
      if (this.stopScanner.stopped) {
        break;
      }
      this.processPart(part);
    }

    // 2. Process grounding (web search)
    if (candidate?.groundingMetadata) {
      this.processGrounding(candidate.groundingMetadata);
    }

    // 3. Flush remaining content
    this.flushThinking();
    this.flushText();

    // 4. An unattached signature is dropped: nothing in this turn can carry it.
    this.pendingSignature = null;

    // 5. Search blocks, once the text they precede exists
    this.insertWebSearchBlocks();

    // 6. Build response
    return this.buildResponse(geminiResponse);
  }

  private processPart(part: GeminiPart) {
    const signature = decodeSignature(part.thoughtSignature ?? part.thought_signature) || null;
    if (signature) {
      this.responseSignature = signature;
    }

    // 1. Handle FunctionCall
    if (part.functionCall) {
      this.flushThinking();
      this.flushText();

      // A signature the model left on a text-only part belongs to the call it
      // preceded, so the tool_use block carries it instead of a fabricated one.
      const carriedSignature = signature ?? this.pendingSignature;
      this.pendingSignature = null;

      this.hasToolCall = true;

      const fc = part.functionCall;
      const functionArgs = normalizeFunctionCallArgs(fc);
      const integrity = this.toolCallIdIntegrity.record(fc.id, fc.name, functionArgs);
      const toolId = fc.id || `${fc.name}-${uuidv4()}`;
      const capturedSignature = carriedSignature ?? this.responseSignature;
      if (capturedSignature && this.signatureState) {
        this.signatureState.store.store(
          {
            accountId: this.signatureState.accountId,
            model: this.signatureState.model,
            toolCallId: toolId,
          },
          capturedSignature,
        );
      }
      if (integrity === 'replay') {
        return;
      }

      const toolUse: ContentBlock = {
        type: 'tool_use',
        id: toolId,
        name: fc.name,
        input: functionArgs,
        signature: carriedSignature || undefined,
      };

      this.contentBlocks.push(toolUse);
      return;
    }

    // 2. Handle Text / Thinking
    if (part.text !== undefined) {
      const text = part.text;
      if (part.thought) {
        // Thinking Part
        this.flushText();

        this.thinkingBuilder += text;
        // A signature banked from an earlier text-only part belongs to the
        // thought block being built, which is a block that may carry one.
        const thoughtSignature = signature ?? this.pendingSignature;
        this.pendingSignature = null;
        if (thoughtSignature) {
          this.thinkingSignature = thoughtSignature;
        }
      } else {
        // Normal Text
        if (text === '') {
          // Empty text carrying only a signature: bank it, emit nothing.
          if (signature) {
            this.pendingSignature = signature;
          }
          return;
        }

        this.flushThinking();
        this.textBuilder += this.stopScanner.push(text);

        // A text part's signature is banked, not turned into a block: Anthropic
        // has no signature on a text block, and a synthesised thinking block
        // would land after the text it is supposed to precede.
        if (signature) {
          this.pendingSignature = signature;
        }
      }
    }

    // 3. Handle InlineData (Image)
    if (part.inlineData) {
      this.flushThinking();
      const { mimeType, data } = part.inlineData;
      if (data) {
        const markdownImg = `![image](data:${mimeType};base64,${data})`;
        this.textBuilder += markdownImg;
        this.flushText();
      }
    }
  }

  private processGrounding(grounding: GroundingMetadata) {
    if (this.options.webSearch) {
      this.processWebSearchGrounding(grounding);
      return;
    }

    // Inline `[n]` markers first: the answer text is complete here, so the
    // byte offsets in `groundingSupports` still address it. They must be
    // applied before the trailing block below is appended, or every offset
    // past the end of the prose would be clamped onto the source list.
    this.applyInlineCitations(grounding);

    const groundingText = renderGroundingMarkdown(
      grounding.webSearchQueries,
      grounding.groundingChunks,
    );

    if (groundingText) {
      this.flushThinking();
      this.flushText();
      this.textBuilder += groundingText;
      this.flushText();
    }
  }

  /**
   * Splices the `[n]` markers `groundingSupports` describes into the answer.
   *
   * The grounded prose is normally still unflushed in `textBuilder`, which is
   * exactly the string the offsets were computed against. When a function call
   * or inline image forced an early flush, the last emitted text block holds it
   * instead. If neither carries text there is nothing to annotate and the
   * trailing source list alone is emitted, as before.
   */
  private applyInlineCitations(grounding: GroundingMetadata) {
    const supports = grounding.groundingSupports;
    const sourceCount = grounding.groundingChunks?.length ?? 0;
    if (!supports?.length || sourceCount === 0) {
      return;
    }

    if (this.textBuilder) {
      this.textBuilder = applyGroundingCitations(this.textBuilder, supports, sourceCount);
      return;
    }

    for (let i = this.contentBlocks.length - 1; i >= 0; i--) {
      const block = this.contentBlocks[i];
      if (block.type === 'text' && block.text) {
        block.text = applyGroundingCitations(block.text, supports, sourceCount);
        return;
      }
    }
  }

  /**
   * Records grounding as search results instead of appended prose.
   *
   * Citations are computed here rather than at flush time because the offsets
   * address exactly the answer text as the model produced it, and nothing has
   * been appended to it yet at this point.
   */
  private processWebSearchGrounding(grounding: GroundingMetadata) {
    const resultSet = toWebSearchResultSet(grounding);
    if (!resultSet) {
      return;
    }
    this.webSearchResultSet = resultSet;

    if (this.textBuilder) {
      this.pendingCitations = buildAnthropicWebSearchCitations(this.textBuilder, resultSet);
      return;
    }

    for (let i = this.contentBlocks.length - 1; i >= 0; i--) {
      const block = this.contentBlocks[i];
      if (block.type === 'text' && block.text) {
        const citations = buildAnthropicWebSearchCitations(block.text, resultSet);
        if (citations.length > 0) {
          block.citations = citations;
        }
        return;
      }
    }
  }

  /**
   * Splices the search blocks in ahead of the answer they grounded.
   *
   * Before the first text block rather than at the very front, so a thinking
   * block keeps its leading position and the order the client sees is the one
   * Anthropic documents: the search, its results, then the cited prose.
   */
  private insertWebSearchBlocks() {
    const resultSet = this.webSearchResultSet;
    if (!resultSet) {
      return;
    }

    const { serverToolUse, toolResult } = buildAnthropicWebSearchBlocks(
      resultSet,
      `srvtoolu_${uuidv4()}`,
      ANTHROPIC_WEB_SEARCH_TOOL_NAME,
    );
    const firstTextIndex = this.contentBlocks.findIndex((block) => block.type === 'text');
    const insertAt = firstTextIndex === -1 ? this.contentBlocks.length : firstTextIndex;
    this.contentBlocks.splice(insertAt, 0, serverToolUse, toolResult);
  }

  private flushText() {
    // Text held back as a possible stop-sequence head belongs to the block being
    // closed; a sequence never straddles a block boundary.
    this.textBuilder += this.stopScanner.flush();
    if (!this.textBuilder) return;
    const citations = this.pendingCitations;
    this.pendingCitations = null;
    this.contentBlocks.push({
      type: 'text',
      text: this.textBuilder,
      ...(citations?.length ? { citations } : {}),
    });
    this.textBuilder = '';
  }

  /**
   * Emits the accumulated thought, if there is one.
   *
   * A signature without any thought text is banked rather than emitted: the
   * request never asked for thinking in that case, and Anthropic has no block
   * shape for a thought that has no content.
   */
  private flushThinking() {
    if (!this.thinkingBuilder) {
      if (this.thinkingSignature) {
        this.pendingSignature = this.thinkingSignature;
        this.thinkingSignature = null;
      }
      return;
    }

    this.contentBlocks.push({
      type: 'thinking',
      thinking: this.thinkingBuilder,
      signature: this.thinkingSignature || undefined,
    });

    this.thinkingBuilder = '';
    this.thinkingSignature = null;
  }

  private buildResponse(geminiResponse: GeminiResponse): ClaudeResponse {
    const finishReason = geminiResponse.candidates?.[0]?.finishReason;
    const blockReason = geminiResponse.promptFeedback?.blockReason;
    const policyFinishReason =
      finishReason === 'SAFETY' ||
      finishReason === 'RECITATION' ||
      finishReason === 'BLOCKLIST' ||
      finishReason === 'PROHIBITED_CONTENT' ||
      finishReason === 'SPII' ||
      finishReason === 'IMAGE_SAFETY' ||
      finishReason === 'IMAGE_PROHIBITED_CONTENT';
    const refusal = blockReason
      ? `Request blocked by safety policy (blockReason: ${blockReason})`
      : policyFinishReason
        ? `Response blocked by upstream policy (finishReason: ${finishReason})`
        : undefined;

    const firedStopSequence = this.stopScanner.sequence;
    let stopReason = 'end_turn';
    if (firedStopSequence !== null) {
      // Takes precedence over every other reason: the generation was cut here,
      // so whatever the upstream would have reported describes a longer answer.
      stopReason = 'stop_sequence';
    } else if (this.hasToolCall) {
      stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    } else if (refusal) {
      stopReason = 'refusal';
    }

    const usage: Usage = {
      ...toAnthropicUsage(geminiResponse.usageMetadata),
      cache_creation_input_tokens: 0,
      ...(this.webSearchResultSet
        ? { server_tool_use: { web_search_requests: this.webSearchResultSet.requestCount } }
        : {}),
    };

    return {
      id: geminiResponse.responseId || `msg_${uuidv4()}`,
      type: 'message',
      role: 'assistant',
      model: geminiResponse.modelVersion || '',
      content: this.contentBlocks,
      stop_reason: stopReason,
      stop_sequence: firedStopSequence,
      usage: usage,
      refusal,
    };
  }
}

/**
 * Public API: Transform Gemini Response to Claude Response
 */
export function transformResponse(
  geminiResponse: GeminiResponse,
  signatureState?: ResponseSignatureState,
  options?: ResponseMappingOptions,
): ClaudeResponse {
  const processor = new NonStreamingProcessor(signatureState, options);
  return processor.process(geminiResponse);
}
