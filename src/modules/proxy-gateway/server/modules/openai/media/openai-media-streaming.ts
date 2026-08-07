import { Observable } from 'rxjs';

import {
  OPENAI_IMAGE_RESPONSE_BYTES_LIMIT,
  isOpenAIImageOutputMimeType,
  parseInlineMediaInput,
  type ParsedInlineMedia,
} from './openai-media-request-contract';

const MEDIA_SSE_BUFFER_CHARACTER_LIMIT = 48 * 1024 * 1024;
const TRANSCRIPT_BYTES_LIMIT = 4 * 1024 * 1024;
const INLINE_IMAGE_MARKER = 'data:image/';

type OpenAIImagePath = '/v1/images/edits' | '/v1/images/generations';

export interface OpenAIImageStreamOptions {
  partialImages: number;
  path: OpenAIImagePath;
  quality?: string;
  size?: string;
}

interface DecodedSseEvent {
  data: string;
  event?: string;
}

interface SseStreamProcessor {
  complete(emit: (chunk: string) => void): void;
  process(event: DecodedSseEvent, emit: (chunk: string) => void): void;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function decodeSseEvent(block: string): DecodedSseEvent | null {
  const dataLines: string[] = [];
  let event: string | undefined;

  for (const rawLine of block.split(/\r?\n/u)) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return dataLines.length > 0 ? { data: dataLines.join('\n'), event } : null;
}

function parseSseJson(data: string, streamName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`Invalid ${streamName} SSE JSON`);
  }
  const record = toRecord(parsed);
  if (!record) {
    throw new Error(`Invalid ${streamName} SSE payload`);
  }
  return record;
}

function transformSseStream(
  source: Observable<unknown>,
  createProcessor: () => SseStreamProcessor,
): Observable<string> {
  return new Observable<string>((subscriber) => {
    const processor = createProcessor();
    let buffer = '';
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      subscriber.error(error instanceof Error ? error : new Error(String(error)));
    };

    const emit = (chunk: string): void => {
      if (!settled && !subscriber.closed) {
        subscriber.next(chunk);
      }
    };

    const processBlock = (block: string): void => {
      const event = decodeSseEvent(block);
      if (event) {
        processor.process(event, emit);
      }
    };

    const drainCompleteBlocks = (): void => {
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (block.trim()) {
          processBlock(block);
        }
      }
    };

    const upstreamSubscription = source.subscribe({
      next: (chunk) => {
        if (settled) {
          return;
        }
        try {
          buffer += String(chunk ?? '');
          if (buffer.length > MEDIA_SSE_BUFFER_CHARACTER_LIMIT) {
            throw new Error('Upstream media SSE event exceeds the configured buffer limit');
          }
          drainCompleteBlocks();
        } catch (error) {
          fail(error);
        }
      },
      error: fail,
      complete: () => {
        if (settled) {
          return;
        }
        try {
          if (buffer.trim()) {
            processBlock(buffer);
          }
          processor.complete(emit);
          settled = true;
          subscriber.complete();
        } catch (error) {
          fail(error);
        }
      },
    });

    return () => {
      settled = true;
      upstreamSubscription.unsubscribe();
    };
  });
}

function createTranscriptEvent(
  type: 'transcript.text.delta' | 'transcript.text.done',
  value: string,
): string {
  const payload = type.endsWith('.delta') ? { type, delta: value } : { type, text: value };
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function mapGeminiAudioTranscriptionStream(source: Observable<unknown>): Observable<string> {
  return transformSseStream(source, () => {
    let transcript = '';
    let transcriptBytes = 0;
    let sawGeminiResponse = false;

    return {
      process(event, emit) {
        if (event.data === '[DONE]') {
          return;
        }
        const payload = parseSseJson(event.data, 'Gemini audio');
        sawGeminiResponse = true;
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        const candidate = toRecord(candidates[0]);
        const content = toRecord(candidate?.content);
        const parts = Array.isArray(content?.parts) ? content.parts : [];

        for (const partValue of parts) {
          const part = toRecord(partValue);
          if (!part || part.thought === true || typeof part.text !== 'string' || !part.text) {
            continue;
          }
          transcriptBytes += Buffer.byteLength(part.text, 'utf8');
          if (transcriptBytes > TRANSCRIPT_BYTES_LIMIT) {
            throw new Error('Upstream audio transcript exceeds the configured buffer limit');
          }
          transcript += part.text;
          emit(createTranscriptEvent('transcript.text.delta', part.text));
        }
      },
      complete(emit) {
        if (!sawGeminiResponse) {
          throw new Error('Audio transcription stream completed without Gemini response data');
        }
        emit(createTranscriptEvent('transcript.text.done', transcript));
      },
    };
  });
}

function extractInlineImages(content: string): ParsedInlineMedia[] {
  const images: ParsedInlineMedia[] = [];
  const pattern =
    /data:(?<mime>image\/[A-Za-z0-9.+-]+);base64,(?<data>[A-Za-z0-9+/]+={0,2})(?=[)\s"'\\]|$)/gu;
  for (const match of content.matchAll(pattern)) {
    if (!match.groups?.mime || !match.groups.data) {
      continue;
    }
    const image = parseInlineMediaInput(`data:${match.groups.mime};base64,${match.groups.data}`, {
      kind: 'image',
      maxBytes: OPENAI_IMAGE_RESPONSE_BYTES_LIMIT,
      param: 'upstream_image',
    });
    if (!isOpenAIImageOutputMimeType(image.mimeType)) {
      throw new Error(`Upstream image uses unsupported output MIME type ${image.mimeType}`);
    }
    images.push(image);
  }
  return images;
}

function drainInlineImages(content: string): {
  images: ParsedInlineMedia[];
  remainder: string;
} {
  const images: ParsedInlineMedia[] = [];
  let remainder = content;

  while (remainder) {
    const markerIndex = remainder.indexOf(INLINE_IMAGE_MARKER);
    if (markerIndex < 0) {
      return {
        images,
        remainder: remainder.slice(-(INLINE_IMAGE_MARKER.length - 1)),
      };
    }

    const closingIndex = remainder.indexOf(')', markerIndex);
    if (closingIndex < 0) {
      return { images, remainder: remainder.slice(markerIndex) };
    }

    const encodedImage = remainder.slice(markerIndex, closingIndex);
    const decodedImages = extractInlineImages(encodedImage);
    if (decodedImages.length !== 1) {
      throw new Error('Invalid upstream inline image data');
    }
    images.push(decodedImages[0]);
    remainder = remainder.slice(closingIndex + 1);
  }

  return { images, remainder: '' };
}

function imageOutputFormat(mimeType: string): 'jpeg' | 'png' | 'webp' {
  if (mimeType === 'image/jpeg') {
    return 'jpeg';
  }
  if (mimeType === 'image/webp') {
    return 'webp';
  }
  return 'png';
}

function createImageEvent(
  type:
    | 'image_edit.completed'
    | 'image_edit.partial_image'
    | 'image_generation.completed'
    | 'image_generation.partial_image',
  image: ParsedInlineMedia,
  options: OpenAIImageStreamOptions,
  partialImageIndex?: number,
): string {
  const payload = {
    type,
    b64_json: image.data,
    background: 'auto',
    output_format: imageOutputFormat(image.mimeType),
    quality: options.quality ?? 'auto',
    size: options.size ?? 'auto',
    ...(partialImageIndex === undefined
      ? { created_at: Math.floor(Date.now() / 1000) }
      : { partial_image_index: partialImageIndex }),
  };
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function imageEventPrefix(path: OpenAIImagePath): 'image_edit' | 'image_generation' {
  return path === '/v1/images/edits' ? 'image_edit' : 'image_generation';
}

export function mapOpenAIImageStream(
  source: Observable<unknown>,
  options: OpenAIImageStreamOptions,
): Observable<string> {
  return transformSseStream(source, () => {
    const partialImageLimit = Math.max(0, Math.min(3, options.partialImages));
    const prefix = imageEventPrefix(options.path);
    let contentBuffer = '';
    let partialImagesEmitted = 0;
    let pendingImage: ParsedInlineMedia | undefined;

    const processImage = (image: ParsedInlineMedia, emit: (chunk: string) => void): void => {
      if (pendingImage?.mimeType === image.mimeType && pendingImage.data === image.data) {
        return;
      }
      if (pendingImage && partialImagesEmitted < partialImageLimit) {
        emit(
          createImageEvent(`${prefix}.partial_image`, pendingImage, options, partialImagesEmitted),
        );
        partialImagesEmitted += 1;
      }
      pendingImage = image;
    };

    return {
      process(event, emit) {
        if (event.data === '[DONE]') {
          return;
        }
        const payload = parseSseJson(event.data, 'OpenAI image upstream');
        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        for (const choiceValue of choices) {
          const choice = toRecord(choiceValue);
          const delta = toRecord(choice?.delta);
          if (typeof delta?.content !== 'string') {
            continue;
          }
          contentBuffer += delta.content;
          if (contentBuffer.length > MEDIA_SSE_BUFFER_CHARACTER_LIMIT) {
            throw new Error('Upstream inline image exceeds the configured buffer limit');
          }
          const drained = drainInlineImages(contentBuffer);
          contentBuffer = drained.remainder;
          for (const image of drained.images) {
            processImage(image, emit);
          }
        }
      },
      complete(emit) {
        if (!pendingImage) {
          throw new Error('Image stream completed without upstream inline image data');
        }
        emit(createImageEvent(`${prefix}.completed`, pendingImage, options));
      },
    };
  });
}
