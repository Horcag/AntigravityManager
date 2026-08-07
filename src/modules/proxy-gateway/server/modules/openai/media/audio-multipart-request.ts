import type { FastifyRequest } from 'fastify';

import {
  OPENAI_AUDIO_MULTIPART_LIMITS,
  OPENAI_INLINE_MEDIA_BYTES_LIMIT,
  OpenAIMediaRequestError,
  normalizeMultipartMediaError,
  parseMultipartMediaFile,
  type ParsedInlineMedia,
} from './openai-media-request-contract';

export interface AudioTranscriptionRequest {
  file: ParsedInlineMedia;
  language?: string;
  model: string;
  prompt?: string;
  response_format: 'json' | 'text';
  stream: boolean;
  temperature?: number;
}

function optionalString(record: Record<string, string>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new OpenAIMediaRequestError(`${key} must not be empty`, key);
  }
  return trimmed;
}

function parseBoolean(record: Record<string, string>, key: string): boolean {
  const value = record[key];
  if (value === undefined) {
    return false;
  }
  if (!['true', 'false'].includes(value.toLowerCase())) {
    throw new OpenAIMediaRequestError(`${key} must be true or false`, key);
  }
  return value.toLowerCase() === 'true';
}

function normalizeAudioFields(
  fields: Record<string, string>,
  file: ParsedInlineMedia | undefined,
): AudioTranscriptionRequest {
  if (!file) {
    throw new OpenAIMediaRequestError('file is required', 'file', 'missing_required_parameter');
  }

  const responseFormat = optionalString(fields, 'response_format') ?? 'json';
  if (!['json', 'text'].includes(responseFormat)) {
    throw new OpenAIMediaRequestError(
      'Only response_format=json or text is supported; timestamps and diarization are unavailable',
      'response_format',
      'unsupported_parameter',
    );
  }

  let temperature: number | undefined;
  if (fields.temperature !== undefined) {
    temperature = Number(fields.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      throw new OpenAIMediaRequestError('temperature must be between 0 and 1', 'temperature');
    }
  }

  return {
    file,
    language: optionalString(fields, 'language'),
    model: optionalString(fields, 'model') ?? 'gemini-3-flash',
    prompt: optionalString(fields, 'prompt'),
    response_format: responseFormat as 'json' | 'text',
    stream: parseBoolean(fields, 'stream'),
    temperature,
  };
}

export async function parseAudioMultipartRequest(
  request: FastifyRequest,
): Promise<AudioTranscriptionRequest> {
  if (!request.isMultipart()) {
    throw new OpenAIMediaRequestError('Expected a multipart/form-data request', 'content-type');
  }

  const fields: Record<string, string> = {};
  let file: ParsedInlineMedia | undefined;
  try {
    for await (const part of request.parts({ limits: OPENAI_AUDIO_MULTIPART_LIMITS })) {
      if (part.type === 'file') {
        if (!['audio', 'file'].includes(part.fieldname)) {
          part.file.resume();
          throw new OpenAIMediaRequestError(
            `Unsupported multipart file field ${part.fieldname}`,
            part.fieldname,
            'unsupported_parameter',
          );
        }
        if (file) {
          part.file.resume();
          throw new OpenAIMediaRequestError('Only one audio file is allowed', 'file');
        }
        file = parseMultipartMediaFile(await part.toBuffer(), {
          declaredMimeType: part.mimetype,
          filename: part.filename,
          kind: 'audio',
          maxBytes: OPENAI_INLINE_MEDIA_BYTES_LIMIT,
          param: 'file',
        });
        continue;
      }

      if (part.valueTruncated) {
        throw new OpenAIMediaRequestError(
          `${part.fieldname} exceeds the multipart field limit`,
          part.fieldname,
          'payload_too_large',
          413,
        );
      }
      if (
        !['language', 'model', 'prompt', 'response_format', 'stream', 'temperature'].includes(
          part.fieldname,
        )
      ) {
        throw new OpenAIMediaRequestError(
          `${part.fieldname} is unsupported by the Gemini transcription transport`,
          part.fieldname,
          'unsupported_parameter',
        );
      }
      if (fields[part.fieldname] !== undefined) {
        throw new OpenAIMediaRequestError(
          `${part.fieldname} must be provided at most once`,
          part.fieldname,
        );
      }
      fields[part.fieldname] = String(part.value ?? '');
    }
  } catch (error) {
    throw normalizeMultipartMediaError(error);
  }

  return normalizeAudioFields(fields, file);
}
