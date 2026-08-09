export const OPENAI_UPLOAD_ID_PREFIX = 'upload_';
export const OPENAI_UPLOAD_PART_ID_PREFIX = 'part_';

export const DEFAULT_OPENAI_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_OPENAI_UPLOAD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface PendingOpenAIUpload {
  id: string;
  bytes: number;
  filename: string;
  purpose: string;
  mimeType: string;
  createdAtMs: number;
  expiresAtMs: number;
  parts: Map<string, PendingOpenAIUploadPart>;
}

export interface PendingOpenAIUploadPart {
  id: string;
  bytes: Buffer;
  createdAtMs: number;
}

export class OpenAIUploadError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly param: string | null;

  public constructor(code: string, message: string, httpStatus: number, param: string | null) {
    super(message);
    this.name = 'OpenAIUploadError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.param = param;
  }

  public static invalid(message: string, param: string): OpenAIUploadError {
    return new OpenAIUploadError('invalid_request', message, 400, param);
  }

  public static notFound(id: string): OpenAIUploadError {
    return new OpenAIUploadError(
      'upload_not_found',
      `Upload '${id}' was never created by this proxy`,
      404,
      'upload_id',
    );
  }

  public static expired(id: string): OpenAIUploadError {
    return new OpenAIUploadError(
      'upload_expired',
      `Upload '${id}' has expired and its partial bytes were discarded`,
      404,
      'upload_id',
    );
  }

  public static byteCountMismatch(expected: number, actual: number): OpenAIUploadError {
    return new OpenAIUploadError(
      'byte_count_mismatch',
      `Upload declares ${expected} bytes but its supplied parts assemble to ${actual} bytes`,
      400,
      'bytes',
    );
  }
}
