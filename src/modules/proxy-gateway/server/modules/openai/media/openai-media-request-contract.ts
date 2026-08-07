export type OpenAIMediaKind = 'audio' | 'image';

/**
 * Gemini's inline request envelope is limited to 20 MiB including JSON and base64 overhead.
 * Fourteen MiB of decoded media leaves room for base64 expansion, prompts, and protocol fields.
 */
export const OPENAI_INLINE_MEDIA_BYTES_LIMIT = 14 * 1024 * 1024;
export const OPENAI_JSON_BODY_LIMIT_BYTES = 20 * 1024 * 1024;
export const OPENAI_IMAGE_RESPONSE_BYTES_LIMIT = 32 * 1024 * 1024;

export const OPENAI_MEDIA_MULTIPART_OPTIONS = {
  limits: {
    fieldNameSize: 100,
    fieldSize: 64 * 1024,
    fields: 16,
    fileSize: OPENAI_INLINE_MEDIA_BYTES_LIMIT,
    files: 17,
    headerPairs: 256,
    parts: 33,
  },
  throwFileSizeLimit: true,
} as const;

export const OPENAI_IMAGE_MULTIPART_LIMITS = {
  fieldNameSize: 100,
  fieldSize: 64 * 1024,
  fields: 16,
  fileSize: OPENAI_INLINE_MEDIA_BYTES_LIMIT,
  files: 17,
  headerPairs: 256,
  parts: 33,
} as const;

export const OPENAI_AUDIO_MULTIPART_LIMITS = {
  fieldNameSize: 100,
  fieldSize: 64 * 1024,
  fields: 12,
  fileSize: OPENAI_INLINE_MEDIA_BYTES_LIMIT,
  files: 1,
  headerPairs: 128,
  parts: 13,
} as const;

export class OpenAIMediaRequestError extends Error {
  public readonly type = 'invalid_request_error';

  constructor(
    message: string,
    public readonly param: string,
    public readonly code: string = 'invalid_value',
    public readonly statusCode: 400 | 413 = 400,
  ) {
    super(message);
    this.name = 'OpenAIMediaRequestError';
  }
}

export interface ParsedInlineMedia {
  bytes: number;
  data: string;
  filename?: string;
  mimeType: string;
}

interface ParseInlineMediaOptions {
  defaultMimeType?: string;
  kind: OpenAIMediaKind;
  maxBytes: number;
  param: string;
}

interface ParseMultipartMediaOptions extends ParseInlineMediaOptions {
  declaredMimeType?: string;
  filename?: string;
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const OPENAI_IMAGE_OUTPUT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isOpenAIImageOutputMimeType(mimeType: string): boolean {
  return OPENAI_IMAGE_OUTPUT_MIME_TYPES.has(normalizeMimeType(mimeType));
}

const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/aiff',
  'audio/flac',
  'audio/mp3',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);

const MULTIPART_LIMIT_ERROR_CODES = new Set([
  'FST_FIELDS_LIMIT',
  'FST_FILES_LIMIT',
  'FST_PARTS_LIMIT',
  'FST_REQ_FILE_TOO_LARGE',
]);

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeMimeType(value: string): string {
  const normalized = value.trim().toLowerCase().split(';', 1)[0];
  switch (normalized) {
    case 'image/jpg':
      return 'image/jpeg';
    case 'audio/x-wav':
    case 'audio/wave':
      return 'audio/wav';
    case 'audio/x-flac':
      return 'audio/flac';
    case 'audio/x-aiff':
      return 'audio/aiff';
    default:
      return normalized;
  }
}

function invalid(message: string, param: string, code = 'invalid_value'): never {
  throw new OpenAIMediaRequestError(message, param, code);
}

function tooLarge(param: string, maxBytes: number): never {
  throw new OpenAIMediaRequestError(
    `${param} exceeds the ${maxBytes}-byte inline media limit`,
    param,
    'payload_too_large',
    413,
  );
}

function decodeStrictBase64(raw: string, param: string): Buffer {
  const compact = raw.replace(/[\t\n\r ]/gu, '');
  if (!compact) {
    invalid(`${param} must contain non-empty base64 data`, param);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    invalid(`${param} contains malformed base64 data`, param);
  }

  const paddingLength = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const unpadded = compact.slice(0, compact.length - paddingLength);
  if (
    unpadded.length % 4 === 1 ||
    (paddingLength > 0 && compact.length % 4 !== 0) ||
    (paddingLength === 1 && unpadded.length % 4 !== 3) ||
    (paddingLength === 2 && unpadded.length % 4 !== 2)
  ) {
    invalid(`${param} contains invalid base64 padding`, param);
  }

  const normalized =
    paddingLength > 0 ? compact : `${compact}${'='.repeat((4 - (compact.length % 4)) % 4)}`;
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64').replace(/=+$/u, '') !== unpadded) {
    invalid(`${param} contains non-canonical base64 data`, param);
  }
  return decoded;
}

function detectImageMimeType(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii').toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) {
      return 'image/heic';
    }
    if (['mif1', 'msf1'].includes(brand)) {
      return 'image/heif';
    }
  }
  return null;
}

function detectAudioMimeType(bytes: Buffer): string | null {
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return 'audio/wav';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'fLaC') {
    return 'audio/flac';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS') {
    return 'audio/ogg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'FORM' &&
    ['AIFF', 'AIFC'].includes(bytes.subarray(8, 12).toString('ascii'))
  ) {
    return 'audio/aiff';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return 'audio/aac';
  }
  if (
    (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3') ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  ) {
    return 'audio/mpeg';
  }
  return null;
}

function isCompatibleMimeType(
  kind: OpenAIMediaKind,
  declaredMimeType: string,
  detectedMimeType: string,
): boolean {
  if (declaredMimeType === detectedMimeType) {
    return true;
  }
  return (
    kind === 'audio' &&
    new Set([declaredMimeType, detectedMimeType]).size <= 2 &&
    ['audio/mp3', 'audio/mpeg'].includes(declaredMimeType) &&
    ['audio/mp3', 'audio/mpeg'].includes(detectedMimeType)
  );
}

function parseMediaBytes(bytes: Buffer, options: ParseMultipartMediaOptions): ParsedInlineMedia {
  if (bytes.length === 0) {
    invalid(`${options.param} must not be empty`, options.param);
  }
  if (bytes.length > options.maxBytes) {
    tooLarge(options.param, options.maxBytes);
  }

  const normalizedDeclaredMimeType = options.declaredMimeType
    ? normalizeMimeType(options.declaredMimeType)
    : options.defaultMimeType
      ? normalizeMimeType(options.defaultMimeType)
      : undefined;
  const declaredMimeType =
    normalizedDeclaredMimeType === 'application/octet-stream'
      ? undefined
      : normalizedDeclaredMimeType;
  const supportedMimeTypes =
    options.kind === 'image' ? SUPPORTED_IMAGE_MIME_TYPES : SUPPORTED_AUDIO_MIME_TYPES;
  if (declaredMimeType && !supportedMimeTypes.has(declaredMimeType)) {
    invalid(`${options.param} uses unsupported MIME type ${declaredMimeType}`, options.param);
  }

  const detectedMimeType =
    options.kind === 'image' ? detectImageMimeType(bytes) : detectAudioMimeType(bytes);
  if (!detectedMimeType) {
    invalid(`${options.param} content is not a supported ${options.kind} format`, options.param);
  }
  if (declaredMimeType && !isCompatibleMimeType(options.kind, declaredMimeType, detectedMimeType)) {
    invalid(
      `${options.param} declared MIME type ${declaredMimeType} does not match ${detectedMimeType} content`,
      options.param,
    );
  }

  return {
    bytes: bytes.length,
    data: bytes.toString('base64'),
    filename: options.filename,
    mimeType: declaredMimeType ?? detectedMimeType,
  };
}

function resolveInlineInput(
  input: unknown,
  param: string,
): {
  data: string;
  declaredMimeType?: string;
} {
  if (typeof input === 'string') {
    return { data: input };
  }

  const record = toRecord(input);
  if (!record) {
    invalid(`${param} must be a base64 string, data URL, or inline media object`, param);
  }
  if (typeof record.file_id === 'string') {
    invalid(
      `${param}.file_id is unsupported because this proxy has no upstream-backed Files API`,
      `${param}.file_id`,
      'unsupported_parameter',
    );
  }

  const imageUrl = record.image_url;
  if (typeof imageUrl === 'string') {
    return { data: imageUrl };
  }
  const imageUrlRecord = toRecord(imageUrl);
  if (typeof imageUrlRecord?.url === 'string') {
    return { data: imageUrlRecord.url };
  }

  if (typeof record.data !== 'string') {
    invalid(`${param} must contain string data`, param);
  }
  const declaredMimeType = [record.mimeType, record.media_type, record.mime_type].find(
    (value): value is string => typeof value === 'string',
  );
  return { data: record.data, declaredMimeType };
}

export function parseInlineMediaInput(
  input: unknown,
  options: ParseInlineMediaOptions,
): ParsedInlineMedia {
  const resolved = resolveInlineInput(input, options.param);
  const raw = resolved.data.trim();
  if (/^(?:https?|file):/iu.test(raw)) {
    invalid(
      `${options.param} remote URLs are unsupported because this proxy does not fetch untrusted media`,
      options.param,
      'unsupported_parameter',
    );
  }

  let encoded = raw;
  let dataUrlMimeType: string | undefined;
  if (raw.toLowerCase().startsWith('data:')) {
    const match = /^data:(?<mime>[^;,]+);base64,(?<data>[\s\S]+)$/iu.exec(raw);
    if (!match?.groups?.mime || !match.groups.data) {
      invalid(`${options.param} must be a base64 data URL`, options.param);
    }
    dataUrlMimeType = match.groups.mime;
    encoded = match.groups.data;
  }

  const declaredMimeType = resolved.declaredMimeType ?? options.defaultMimeType;
  if (
    dataUrlMimeType &&
    declaredMimeType &&
    normalizeMimeType(dataUrlMimeType) !== normalizeMimeType(declaredMimeType)
  ) {
    invalid(`${options.param} data URL MIME type does not match its media object`, options.param);
  }

  const bytes = decodeStrictBase64(encoded, options.param);
  return parseMediaBytes(bytes, {
    ...options,
    declaredMimeType: dataUrlMimeType ?? declaredMimeType,
  });
}

export function parseMultipartMediaFile(
  bytes: Buffer,
  options: ParseMultipartMediaOptions,
): ParsedInlineMedia {
  return parseMediaBytes(bytes, options);
}

export function normalizeMultipartMediaError(
  error: unknown,
  param = 'body',
): OpenAIMediaRequestError {
  if (error instanceof OpenAIMediaRequestError) {
    return error;
  }
  const errorRecord = toRecord(error);
  const code = typeof errorRecord?.code === 'string' ? errorRecord.code : undefined;
  if (code && MULTIPART_LIMIT_ERROR_CODES.has(code)) {
    return new OpenAIMediaRequestError(
      'Multipart request exceeds the configured media transport limits',
      param,
      'payload_too_large',
      413,
    );
  }
  return new OpenAIMediaRequestError(
    error instanceof Error ? error.message : 'Invalid multipart request',
    param,
  );
}
