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
import { ToolCallIdIntegrityTracker } from './tool-call-id-integrity';

export interface ResponseSignatureState extends SignatureContext {
  store: SignatureStore;
}

export interface ResponseMappingOptions {
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
  private trailingSignature: string | null = null;
  private hasToolCall: boolean = false;
  private responseSignature: string | null = null;
  private readonly toolCallIdIntegrity = new ToolCallIdIntegrityTracker();
  private webSearchResultSet: WebSearchResultSet | null = null;
  private pendingCitations: AnthropicWebSearchCitation[] | null = null;

  constructor(
    private readonly signatureState?: ResponseSignatureState,
    private readonly options: ResponseMappingOptions = {},
  ) {}

  public process(geminiResponse: GeminiResponse): ClaudeResponse {
    const candidate = geminiResponse.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // 1. Process all parts
    for (const part of parts) {
      this.processPart(part);
    }

    // 2. Process grounding (web search)
    if (candidate?.groundingMetadata) {
      this.processGrounding(candidate.groundingMetadata);
    }

    // 3. Flush remaining content
    this.flushThinking();
    this.flushText();

    // 4. Handle trailingSignature
    if (this.trailingSignature) {
      this.contentBlocks.push({
        type: 'thinking',
        thinking: '',
        signature: this.trailingSignature,
      });
      this.trailingSignature = null; // Consumed
    }

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

      // Handle trailing signature logic
      if (this.trailingSignature) {
        this.contentBlocks.push({
          type: 'thinking',
          thinking: '',
          signature: this.trailingSignature,
        });
        this.trailingSignature = null;
      }

      this.hasToolCall = true;

      const fc = part.functionCall;
      const functionArgs = normalizeFunctionCallArgs(fc);
      const integrity = this.toolCallIdIntegrity.record(fc.id, fc.name, functionArgs);
      const toolId = fc.id || `${fc.name}-${uuidv4()}`;
      const capturedSignature = signature ?? this.responseSignature;
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
        signature: signature || undefined,
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

        // Handle trailing signature before thinking
        if (this.trailingSignature) {
          this.flushThinking(); // Ensure previous thinking is flushed
          this.contentBlocks.push({
            type: 'thinking',
            thinking: '',
            signature: this.trailingSignature,
          });
          this.trailingSignature = null;
        }

        this.thinkingBuilder += text;
        if (signature) {
          this.thinkingSignature = signature;
        }
      } else {
        // Normal Text
        if (text === '') {
          // Empty text with signature -> store as trailing
          if (signature) {
            this.trailingSignature = signature;
          }
          return;
        }

        this.flushThinking();

        // Handle trailing signature
        if (this.trailingSignature) {
          this.flushText();
          this.contentBlocks.push({
            type: 'thinking',
            thinking: '',
            signature: this.trailingSignature,
          });
          this.trailingSignature = null;
        }

        this.textBuilder += text;

        // Non-empty text with signature -> flush immediately empty thinking block with sig
        if (signature) {
          this.flushText();
          this.contentBlocks.push({
            type: 'thinking',
            thinking: '',
            signature: signature,
          });
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

  private flushThinking() {
    if (!this.thinkingBuilder && !this.thinkingSignature) return;

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

    let stopReason = 'end_turn';
    if (this.hasToolCall) {
      stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    } else if (refusal) {
      stopReason = 'refusal';
    }

    const usage: Usage = {
      input_tokens:
        geminiResponse.usageMetadata?.total_input_tokens ??
        geminiResponse.usageMetadata?.promptTokenCount ??
        0,
      output_tokens:
        geminiResponse.usageMetadata?.total_output_tokens ??
        geminiResponse.usageMetadata?.candidatesTokenCount ??
        0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens:
        geminiResponse.usageMetadata?.total_cached_tokens ??
        geminiResponse.usageMetadata?.cachedContentTokenCount ??
        geminiResponse.usageMetadata?.cachedTokens ??
        0,
      reasoning_tokens:
        geminiResponse.usageMetadata?.total_thought_tokens ??
        geminiResponse.usageMetadata?.totalThoughtTokens ??
        geminiResponse.usageMetadata?.thoughtsTokenCount ??
        0,
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
