import { isString } from 'lodash-es';
import { asString, toRecord } from '../../../common/utils/json-record';
import type {
  GeminiResponse,
  OpenAIContentPart,
} from '../../../common/interfaces/request-interfaces';
import {
  OPENAI_IMAGE_RESPONSE_BYTES_LIMIT,
  isOpenAIImageOutputMimeType,
  parseInlineMediaInput,
} from './openai-media-request-contract';

export interface InlineImagePayload {
  mimeType: string;
  data: string;
}

/** Reads the URL out of either the string or `{ url }` form of an image block. */
export function resolveImageUrl(block: Record<string, unknown>): string | null {
  const raw = block.image_url;
  if (isString(raw)) {
    return raw;
  }
  const rawRecord = toRecord(raw);
  const url = asString(rawRecord?.url);
  if (url) {
    return url;
  }
  return null;
}

/**
 * Accepts a data URI, a bare base64 string, or an already-split
 * `{ data, mimeType }` pair, and returns the inline payload for all three.
 */
export function resolveInlineData(
  input: unknown,
  defaultMimeType: string,
): InlineImagePayload | null {
  if (!input) {
    return null;
  }

  if (isString(input)) {
    const dataUri = input.match(/^data:(?<mime>[^;]+);base64,(?<data>[A-Za-z0-9+/=]+)$/);
    if (dataUri?.groups?.mime && dataUri.groups.data) {
      return {
        mimeType: dataUri.groups.mime,
        data: dataUri.groups.data,
      };
    }

    const cleaned = input.replace(/\s+/g, '');
    if (cleaned.length > 0) {
      return {
        mimeType: defaultMimeType,
        data: cleaned,
      };
    }
    return null;
  }

  const inputRecord = toRecord(input);
  if (inputRecord) {
    const data = asString(inputRecord.data);
    if (!data) {
      return null;
    }
    return {
      mimeType: asString(inputRecord.mimeType) ?? defaultMimeType,
      data,
    };
  }

  return null;
}

export function collectImageContentParts(
  entries: Array<string | { data?: string; mimeType?: string } | undefined>,
  defaultMimeType: string,
): OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = [];
  for (const entry of entries) {
    const inlineData = resolveInlineData(entry, defaultMimeType);
    if (!inlineData) {
      continue;
    }
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${inlineData.mimeType};base64,${inlineData.data}`,
      },
    });
  }
  return parts;
}

/**
 * The last inline image an upstream text answer contains.
 *
 * Later frames of a progressive image response supersede earlier ones, so the
 * final match wins rather than the first.
 */
export function extractInlineBase64Image(content: string): InlineImagePayload | null {
  const pattern = /data:(?<mime>[\w/+.-]+);base64,(?<data>[^)\s"'\\]*)/gu;
  let finalImage: InlineImagePayload | null = null;
  for (const matched of content.matchAll(pattern)) {
    if (!matched.groups) {
      continue;
    }
    finalImage = validateUpstreamInlineImage(
      `data:${matched.groups.mime};base64,${matched.groups.data}`,
    );
  }
  return finalImage;
}

export function extractInlineBase64ImageFromGeminiResponse(
  response: GeminiResponse,
): InlineImagePayload | null {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  let finalImage: InlineImagePayload | null = null;
  for (const part of parts) {
    if (part.inlineData?.data) {
      finalImage = validateUpstreamInlineImage({
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType ?? 'image/jpeg',
      });
    }
    if (part.text) {
      const parsed = extractInlineBase64Image(part.text);
      if (parsed || part.text.includes('data:')) {
        finalImage = parsed;
      }
    }
  }
  return finalImage;
}

export function validateUpstreamInlineImage(input: unknown): InlineImagePayload | null {
  try {
    const parsed = parseInlineMediaInput(input, {
      kind: 'image',
      maxBytes: OPENAI_IMAGE_RESPONSE_BYTES_LIMIT,
      param: 'upstream_image',
    });
    return isOpenAIImageOutputMimeType(parsed.mimeType)
      ? { mimeType: parsed.mimeType, data: parsed.data }
      : null;
  } catch {
    return null;
  }
}

export function resolveImageOutputFormat(mimeType: string): string {
  if (mimeType === 'image/jpeg') {
    return 'jpeg';
  }
  if (mimeType === 'image/webp') {
    return 'webp';
  }
  return 'png';
}
