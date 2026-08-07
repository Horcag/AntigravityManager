import { describe, expect, it } from 'vitest';

import {
  OpenAIMediaRequestError,
  parseInlineMediaInput,
  parseMultipartMediaFile,
} from '@/modules/proxy-gateway/server/modules/openai/media/openai-media-request-contract';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const wav = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WAVE'),
  Buffer.alloc(8),
]);

describe('OpenAI media request contract', () => {
  it('accepts padded data URLs and canonicalizes unpadded base64', () => {
    const encoded = png.toString('base64');
    const padded = parseInlineMediaInput(`data:image/png;base64,${encoded}`, {
      kind: 'image',
      maxBytes: 1024,
      param: 'images[0].image_url',
    });
    const unpadded = parseInlineMediaInput(encoded.replace(/=+$/u, ''), {
      defaultMimeType: 'image/png',
      kind: 'image',
      maxBytes: 1024,
      param: 'image',
    });

    expect(padded).toMatchObject({
      bytes: png.length,
      data: encoded,
      mimeType: 'image/png',
    });
    expect(unpadded.data).toBe(encoded);
  });

  it.each(['AAAA=AAA', 'A', '%%%%', 'data:image/png;base64,'])(
    'rejects malformed base64 %s',
    (value) => {
      expect(() =>
        parseInlineMediaInput(value, {
          defaultMimeType: 'image/png',
          kind: 'image',
          maxBytes: 1024,
          param: 'image',
        }),
      ).toThrow(OpenAIMediaRequestError);
    },
  );

  it('rejects MIME spoofing and unsupported remote/file references', () => {
    expect(() =>
      parseInlineMediaInput(`data:image/jpeg;base64,${png.toString('base64')}`, {
        kind: 'image',
        maxBytes: 1024,
        param: 'images[0].image_url',
      }),
    ).toThrow(/does not match/i);

    expect(() =>
      parseInlineMediaInput('https://example.com/source.png', {
        kind: 'image',
        maxBytes: 1024,
        param: 'images[0].image_url',
      }),
    ).toThrow(/remote/i);

    expect(() =>
      parseInlineMediaInput(
        { file_id: 'file_123' },
        {
          kind: 'image',
          maxBytes: 1024,
          param: 'images[0]',
        },
      ),
    ).toThrow(/file_id/i);
  });

  it('returns 413 semantics for an oversized decoded payload', () => {
    expect(() =>
      parseMultipartMediaFile(png, {
        declaredMimeType: 'image/png',
        filename: 'source.png',
        kind: 'image',
        maxBytes: 8,
        param: 'image',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'payload_too_large',
        statusCode: 413,
      }),
    );
  });

  it('sniffs a multipart file when the client sends application/octet-stream', () => {
    expect(
      parseMultipartMediaFile(wav, {
        declaredMimeType: 'application/octet-stream',
        filename: 'speech.bin',
        kind: 'audio',
        maxBytes: 1024,
        param: 'file',
      }),
    ).toMatchObject({
      data: wav.toString('base64'),
      mimeType: 'audio/wav',
    });
  });
});
