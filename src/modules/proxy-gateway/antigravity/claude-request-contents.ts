import { isEmpty, isString } from 'lodash-es';
import { cleanJsonSchema } from './JsonSchemaUtils';
import { sanitizeSystemInstructionForCache } from './StablePromptPrefix';
import { buildOfficialSystemInstruction } from './OfficialSystemInstruction';
import { parseMarkdownImagesToGeminiParts } from './MarkdownImageParts';
import { enhanceGeminiSkillsPrompt } from './SkillPromptEnhancer';
import { isGeminiFlashModel } from './claude-request-model-traits';
import type { SignatureLookup } from './claude-request-signatures';
import type { ClaudeRequest, GeminiContent, GeminiPart, Message, Tool } from './types';

/**
 * Splits `system`-role turns out of the message list.
 *
 * Some clients put system text in `messages` instead of the top-level `system`
 * field; the provider has no system role in `contents`, so those turns are
 * folded into the system instruction rather than dropped.
 */
export function extractEmbeddedSystemMessages(messages: Message[]): {
  extraSystemMessages: string[];
  messages: Message[];
} {
  const extraSystemMessages: string[] = [];
  const filteredMessages: Message[] = [];

  for (const message of messages) {
    if (message.role !== 'system') {
      filteredMessages.push(message);
      continue;
    }

    if (isString(message.content)) {
      extraSystemMessages.push(message.content);
      continue;
    }

    for (const block of message.content) {
      if (block.type === 'text') {
        extraSystemMessages.push(block.text);
      }
    }
  }

  return { extraSystemMessages, messages: filteredMessages };
}

/**
 * Builds system instruction
 * Converts Claude system prompts to Gemini format with a default assistant identity directive.
 */
export function buildSystemInstruction(
  system: ClaudeRequest['system'],
  extraSystemMessages: string[],
  tools?: Tool[],
): { parts: { text: string }[] } | null {
  const assistantIdentityDirective =
    'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\n' +
    'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n' +
    '**Absolute paths only**\n' +
    '**Proactiveness**';
  const instructions: string[] = [];

  if (system) {
    if (isString(system)) {
      instructions.push(sanitizeSystemInstructionForCache(system));
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (block.type === 'text') {
          instructions.push(sanitizeSystemInstructionForCache(block.text));
        }
      }
    }
  }

  for (const extraText of extraSystemMessages) {
    if (!isEmpty(extraText.trim())) {
      instructions.push(sanitizeSystemInstructionForCache(extraText));
    }
  }

  const text = buildOfficialSystemInstruction(instructions, assistantIdentityDirective);
  return text ? { parts: [{ text: enhanceGeminiSkillsPrompt(text, tools) }] } : null;
}

/**
 * Builds message contents
 * Converts Claude message list to Gemini content format
 */
export function buildContents(
  messages: Message[],
  toolIdToName: Map<string, string>,
  isThinkingEnabled: boolean,
  allowDummyThought: boolean,
  mappedModel: string,
  lookupSignature: SignatureLookup,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  let lastThoughtSignature: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role === 'assistant' ? 'model' : msg.role;
    const parts: GeminiPart[] = [];
    const contentBlocks = Array.isArray(msg.content)
      ? msg.content
      : msg.content
        ? [{ type: 'text' as const, text: msg.content }]
        : [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        if (block.text && block.text !== '(no content)' && !isEmpty(block.text.trim())) {
          parts.push(...parseMarkdownImagesToGeminiParts(block.text.trim()));
        }
      } else if (block.type === 'thinking') {
        const part: GeminiPart = { text: block.thinking, thought: true };
        cleanJsonSchema(part);
        if (block.signature) {
          lastThoughtSignature = block.signature;
          part.thoughtSignature = block.signature;
          part.thought_signature = block.signature;
        }
        parts.push(part);
      } else if (block.type === 'image' || block.type === 'document') {
        // Images and documents differ only in what the client called them; the
        // provider takes both as one inline part carrying its own MIME type.
        if (block.source.type === 'base64')
          parts.push({
            inlineData: { mimeType: block.source.media_type, data: block.source.data },
          });
      } else if (block.type === 'tool_use') {
        const part: GeminiPart = {
          functionCall: { name: block.name, args: block.input, id: block.id },
        };
        cleanJsonSchema(part);
        toolIdToName.set(block.id, block.name);
        const finalSig = block.signature || lastThoughtSignature || lookupSignature(block.id);
        if (finalSig) {
          part.thoughtSignature = finalSig;
          part.thought_signature = finalSig;
        } else if (isThinkingEnabled && isGeminiFlashModel(mappedModel)) {
          part.thoughtSignature = 'skip_thought_signature_validator';
          part.thought_signature = 'skip_thought_signature_validator';
        }
        parts.push(part);
      } else if (block.type === 'tool_result') {
        const funcName = toolIdToName.get(block.tool_use_id) || block.tool_use_id;
        let mergedContent = '';
        const mediaParts: GeminiPart[] = [];
        if (isString(block.content)) {
          mergedContent = block.content;
        } else if (Array.isArray(block.content)) {
          const textParts: string[] = [];
          for (const nestedBlock of block.content) {
            if (nestedBlock.type === 'text') {
              textParts.push(nestedBlock.text);
            } else if (nestedBlock.type === 'image' && nestedBlock.source.type === 'base64') {
              mediaParts.push({
                inlineData: {
                  mimeType: nestedBlock.source.media_type,
                  data: nestedBlock.source.data,
                },
              });
            }
          }
          mergedContent = textParts.join('\n');
        }
        if (isEmpty(mergedContent.trim())) {
          mergedContent = block.is_error
            ? 'Tool execution failed with no output.'
            : 'Command executed successfully.';
        }
        const part: GeminiPart = {
          functionResponse: {
            name: funcName,
            response: block.is_error ? { error: mergedContent } : { result: mergedContent },
            id: block.tool_use_id,
          },
        };
        if (lastThoughtSignature) {
          part.thoughtSignature = lastThoughtSignature;
          part.thought_signature = lastThoughtSignature;
        }
        parts.push(part);
        parts.push(...mediaParts);
      } else if (block.type === 'redacted_thinking') {
        parts.push({ text: `[Redacted Thinking: ${block.data}]`, thought: true });
      }
    }
    if (allowDummyThought && role === 'model' && isThinkingEnabled && i === messages.length - 1) {
      const hasThought = parts.some((p) => p.thought === true);
      if (!hasThought) parts.unshift({ text: 'Thinking...', thought: true });
    }
    if (parts.length > 0) contents.push({ role, parts });
  }
  return contents;
}
