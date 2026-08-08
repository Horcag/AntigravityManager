import { isEmpty, isString } from 'lodash-es';
import { asString, toRecord } from '../../../common/utils/json-record';
import type {
  GeminiRequest,
  OpenAIChatRequest,
} from '../../../common/interfaces/request-interfaces';
import { resolveImageUrl, resolveInlineData } from './openai-inline-image-payload';

/**
 * Whether the upstream failure is the missing-project-context family.
 *
 * These are the errors the OpenAI-shaped image path cannot recover from, and
 * the only ones worth retrying through the native Gemini surface.
 */
export function isProjectContextErrorMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes('#3501') ||
    (lowered.includes('google cloud project') && lowered.includes('code assist license')) ||
    (lowered.includes('resource projects/') && lowered.includes('could not be found')) ||
    (lowered.includes('project') && lowered.includes('not found'))
  );
}

/**
 * Rebuilds an image request as a native Gemini `generateContent` body.
 *
 * Used only for the project-context fallback: the same prompt, inline images
 * and `imageConfig` are carried across so the retry asks for the same picture.
 */
export function buildGeminiImageRequest(
  request: OpenAIChatRequest,
  fallbackPrompt: string,
): GeminiRequest {
  const userMessage = request.messages.find((message) => message.role === 'user');
  const textParts: string[] = [];
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (!userMessage) {
    parts.push({ text: fallbackPrompt || 'Please generate an image based on this request.' });
  } else if (isString(userMessage.content)) {
    parts.push({
      text:
        userMessage.content || fallbackPrompt || 'Please generate an image based on this request.',
    });
  } else if (Array.isArray(userMessage.content)) {
    for (const block of userMessage.content) {
      if (block.type === 'text' && isString(block.text) && !isEmpty(block.text.trim())) {
        textParts.push(block.text);
      }
      if (block.type === 'image_url') {
        const imageUrl = resolveImageUrl(block as unknown as Record<string, unknown>);
        const inlineData = resolveInlineData(imageUrl, 'image/png');
        if (inlineData) {
          parts.push({
            inlineData: {
              mimeType: inlineData.mimeType,
              data: inlineData.data,
            },
          });
        }
      }
    }
    if (textParts.length > 0) {
      parts.unshift({ text: textParts.join('\n') });
    }
  } else {
    parts.push({ text: fallbackPrompt || 'Please generate an image based on this request.' });
  }

  if (parts.length === 0) {
    parts.push({ text: fallbackPrompt || 'Please generate an image based on this request.' });
  }

  const metadata = toRecord(request.extra);
  const metadataAspectRatio = asString(metadata?.image_aspect_ratio);
  const metadataImageSize = asString(metadata?.image_size);
  const imageConfig: Record<string, string> = {};
  if (
    metadataAspectRatio &&
    ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(metadataAspectRatio)
  ) {
    imageConfig.aspectRatio = metadataAspectRatio;
  }
  if (metadataImageSize && ['1K', '2K', '4K'].includes(metadataImageSize)) {
    imageConfig.imageSize = metadataImageSize;
  }

  return {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    ...(Object.keys(imageConfig).length > 0 ? { generationConfig: { imageConfig } } : {}),
  };
}
