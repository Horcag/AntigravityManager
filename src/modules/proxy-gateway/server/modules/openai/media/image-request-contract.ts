import type { ImageMonitoringInput, ImageMonitoringRequest } from './image-monitoring-summary';
import {
  OPENAI_INLINE_MEDIA_BYTES_LIMIT,
  OpenAIMediaRequestError,
  parseInlineMediaInput,
  type ParsedInlineMedia,
} from './openai-media-request-contract';

const IMAGE_PROMPT_MAX_CHARACTERS = 32_000;
const IMAGE_INPUT_LIMIT = 14;
const SUPPORTED_IMAGE_SIZES = new Set([
  'auto',
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '256x256',
  '512x512',
  '1024x1024',
  '1024x1536',
  '1024x1792',
  '1536x1024',
  '1792x1024',
]);
const SUPPORTED_IMAGE_QUALITIES = new Set(['auto', 'hd', 'high', 'low', 'medium', 'standard']);

function toRecord(value: unknown, param = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OpenAIMediaRequestError(`${param} must be a JSON object`, param);
  }
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new OpenAIMediaRequestError(`${key} must be a string`, key);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new OpenAIMediaRequestError(`${key} must not be empty`, key);
  }
  return trimmed;
}

function requiredPrompt(record: Record<string, unknown>): string {
  const prompt = optionalString(record, 'prompt');
  if (!prompt) {
    throw new OpenAIMediaRequestError('prompt is required', 'prompt', 'missing_required_parameter');
  }
  if (Array.from(prompt).length > IMAGE_PROMPT_MAX_CHARACTERS) {
    throw new OpenAIMediaRequestError('prompt exceeds 32000 characters', 'prompt');
  }
  return prompt;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())) {
    return value.toLowerCase() === 'true';
  }
  throw new OpenAIMediaRequestError(`${key} must be true or false`, key);
}

function optionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new OpenAIMediaRequestError(`${key} must be an integer`, key);
  }
  return parsed;
}

function unsupportedIfPresent(record: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
      throw new OpenAIMediaRequestError(
        `${key} is unsupported by the Gemini inline image transport`,
        key,
        'unsupported_parameter',
      );
    }
  }
}

export function normalizeImageRequestFields(input: unknown): ImageMonitoringRequest {
  const record = toRecord(input);
  const prompt = requiredPrompt(record);
  const model = optionalString(record, 'model');
  const size = optionalString(record, 'size');
  const quality = optionalString(record, 'quality');
  const style = optionalString(record, 'style');
  const responseFormat = optionalString(record, 'response_format');
  const user = optionalString(record, 'user');
  const stream = optionalBoolean(record, 'stream') ?? false;
  const n = optionalInteger(record, 'n') ?? 1;
  const partialImages = optionalInteger(record, 'partial_images') ?? 0;

  if (n !== 1) {
    throw new OpenAIMediaRequestError(
      'Only n=1 is supported by the single-result Gemini image transport',
      'n',
      'unsupported_parameter',
    );
  }
  if (partialImages < 0 || partialImages > 3) {
    throw new OpenAIMediaRequestError('partial_images must be between 0 and 3', 'partial_images');
  }
  if (partialImages > 0 && !stream) {
    throw new OpenAIMediaRequestError(
      'partial_images requires stream=true',
      'partial_images',
      'unsupported_parameter',
    );
  }
  if (responseFormat && responseFormat !== 'b64_json') {
    throw new OpenAIMediaRequestError(
      'Only response_format=b64_json is supported; this proxy has no durable image URL store',
      'response_format',
      'unsupported_parameter',
    );
  }
  if (size && !SUPPORTED_IMAGE_SIZES.has(size)) {
    throw new OpenAIMediaRequestError(`Unsupported image size ${size}`, 'size');
  }
  if (quality && !SUPPORTED_IMAGE_QUALITIES.has(quality)) {
    throw new OpenAIMediaRequestError(`Unsupported image quality ${quality}`, 'quality');
  }
  if (style && !['natural', 'vivid'].includes(style)) {
    throw new OpenAIMediaRequestError('style must be natural or vivid', 'style');
  }

  unsupportedIfPresent(record, [
    'background',
    'input_fidelity',
    'moderation',
    'output_compression',
    'output_format',
  ]);

  return {
    model,
    n,
    partial_images: partialImages,
    prompt: style ? `${prompt}, style: ${style}` : prompt,
    quality,
    response_format: responseFormat,
    size,
    stream,
    user,
  };
}

export function normalizeImageGenerationRequest(input: unknown): ImageMonitoringRequest {
  return normalizeImageRequestFields(input);
}

function collectImageReferences(record: Record<string, unknown>): unknown[] {
  const references: unknown[] = [];
  const append = (value: unknown) => {
    if (value === undefined || value === null) {
      return;
    }
    if (Array.isArray(value)) {
      references.push(...value);
    } else {
      references.push(value);
    }
  };

  append(record.images);
  append(record.image);
  append(record.reference_images);
  return references;
}

function toMonitoringInput(media: ParsedInlineMedia): ImageMonitoringInput {
  return {
    data: media.data,
    filename: media.filename,
    mimeType: media.mimeType,
  };
}

export function finalizeParsedImageEditRequest(
  fields: ImageMonitoringRequest,
  images: ParsedInlineMedia[],
  mask?: ParsedInlineMedia,
): ImageMonitoringRequest {
  if (images.length === 0) {
    throw new OpenAIMediaRequestError(
      'At least one image is required',
      'image',
      'missing_required_parameter',
    );
  }
  const inputImageCount = images.length + (mask ? 1 : 0);
  if (inputImageCount > IMAGE_INPUT_LIMIT) {
    throw new OpenAIMediaRequestError(
      `A maximum of ${IMAGE_INPUT_LIMIT} input images is supported`,
      'image',
      'payload_too_large',
      413,
    );
  }
  const totalBytes = images.reduce((total, image) => total + image.bytes, mask?.bytes ?? 0);
  if (totalBytes > OPENAI_INLINE_MEDIA_BYTES_LIMIT) {
    throw new OpenAIMediaRequestError(
      'Combined inline images exceed the Gemini request envelope',
      'image',
      'payload_too_large',
      413,
    );
  }

  return {
    ...fields,
    image: toMonitoringInput(images[0]),
    mask: mask ? toMonitoringInput(mask) : undefined,
    reference_images:
      images.length > 1 ? images.slice(1).map((image) => toMonitoringInput(image)) : undefined,
  };
}

export function normalizeImageEditJsonRequest(input: unknown): ImageMonitoringRequest {
  const record = toRecord(input);
  const fields = normalizeImageRequestFields(record);
  const references = collectImageReferences(record);
  const images = references.map((reference, index) =>
    parseInlineMediaInput(reference, {
      kind: 'image',
      maxBytes: OPENAI_INLINE_MEDIA_BYTES_LIMIT,
      param: `images[${index}]`,
    }),
  );
  const mask =
    record.mask === undefined || record.mask === null
      ? undefined
      : parseInlineMediaInput(record.mask, {
          kind: 'image',
          maxBytes: OPENAI_INLINE_MEDIA_BYTES_LIMIT,
          param: 'mask',
        });

  return finalizeParsedImageEditRequest(fields, images, mask);
}

export function getGeminiImageRequestMetadata(
  body: ImageMonitoringRequest,
): Record<string, string> {
  const size = body.size ?? 'auto';
  let aspectRatio = size;
  if (['16:9', '1536x1024', '1792x1024'].includes(size)) {
    aspectRatio = size === '1536x1024' ? '3:2' : '16:9';
  } else if (['9:16', '1024x1536', '1024x1792'].includes(size)) {
    aspectRatio = size === '1024x1536' ? '2:3' : '9:16';
  } else if (['256x256', '512x512', '1024x1024'].includes(size)) {
    aspectRatio = '1:1';
  }

  return {
    image_aspect_ratio: aspectRatio,
    ...(body.quality === 'hd' || body.quality === 'high'
      ? { image_size: '4K' }
      : body.quality === 'medium'
        ? { image_size: '2K' }
        : body.quality === 'low'
          ? { image_size: '1K' }
          : {}),
  };
}
