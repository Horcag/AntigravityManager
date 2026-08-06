import { v4 as uuidv4 } from 'uuid';
import {
  ClaudeResponse,
  GeminiResponse,
  GeminiPart,
  ContentBlock,
  Usage,
  GroundingMetadata,
} from './types';
import { decodeSignature } from './signature-utils';
import { SignatureContext, SignatureStore } from './SignatureStore';
import { mapGeminiFinishReasonToAnthropic } from './gemini-finish-reason';

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
  /** Signature seen earlier in THIS response, used only for tool calls of this same response. */
  private responseSignature: string | null = null;

  constructor(private readonly signatureContext?: SignatureContext) {}

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

    // 5. Build response
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
      const toolId = fc.id || `${fc.name}-${uuidv4()}`;

      const toolUse: ContentBlock = {
        type: 'tool_use',
        id: toolId,
        name: fc.name,
        input: fc.args || {},
        signature: signature || undefined,
      };

      // Capture for replay under the id the client actually sees (upstream id when Gemini
      // supplies one, otherwise the generated id), keyed by the account/model that produced it.
      const capturedSignature = signature ?? this.responseSignature;
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
    let groundingText = '';

    if (grounding.webSearchQueries && grounding.webSearchQueries.length > 0) {
      groundingText += `\n\n---\n**🔍 Searched for you:** ${grounding.webSearchQueries.join(', ')}`;
    }

    if (grounding.groundingChunks) {
      const links: string[] = [];
      grounding.groundingChunks.forEach((chunk, index) => {
        if (chunk.web) {
          const title = chunk.web.title || 'Web source';
          const uri = chunk.web.uri || '#';
          links.push(`[${index + 1}] [${title}](${uri})`);
        }
      });

      if (links.length > 0) {
        groundingText += `\n\n**🌐 Citations:**\n` + links.join('\n');
      }
    }

    if (groundingText) {
      this.flushThinking();
      this.flushText();
      this.textBuilder += groundingText;
      this.flushText();
    }
  }

  private flushText() {
    if (!this.textBuilder) return;
    this.contentBlocks.push({
      type: 'text',
      text: this.textBuilder,
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
    let stopReason: ReturnType<typeof mapGeminiFinishReasonToAnthropic> | 'tool_use' =
      mapGeminiFinishReasonToAnthropic(finishReason);
    if (this.hasToolCall) {
      stopReason = 'tool_use';
    }

    const usage = this.buildUsage(geminiResponse);

    return {
      id: geminiResponse.responseId || `msg_${uuidv4()}`,
      type: 'message',
      role: 'assistant',
      model: geminiResponse.modelVersion || '',
      content: this.contentBlocks,
      stop_reason: stopReason,
      // Gemini does not identify a matched stop sequence, so Anthropic responses must not guess.
      stop_sequence: null,
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * Reports usage only when the upstream actually supplied both counters. Defaulting the
   * missing ones to 0 would hand downstream mappers a fabricated token count they cannot
   * tell apart from a real one.
   */
  private buildUsage(geminiResponse: GeminiResponse): Usage | undefined {
    const promptTokens = geminiResponse.usageMetadata?.promptTokenCount;
    const outputTokens = geminiResponse.usageMetadata?.candidatesTokenCount;
    if (typeof promptTokens !== 'number' || typeof outputTokens !== 'number') {
      return undefined;
    }

    return {
      input_tokens: promptTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }
}

/**
 * Public API: Transform Gemini Response to Claude Response
 */
export function transformResponse(
  geminiResponse: GeminiResponse,
  signatureContext?: SignatureContext,
): ClaudeResponse {
  const processor = new NonStreamingProcessor(signatureContext);
  return processor.process(geminiResponse);
}
