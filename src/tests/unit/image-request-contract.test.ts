import { describe, expect, it } from 'vitest';

import {
  getGeminiImageRequestMetadata,
  normalizeImageEditJsonRequest,
  normalizeImageGenerationRequest,
} from '@/modules/proxy-gateway/server/modules/openai/media/image-request-contract';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

describe('OpenAI image request contract', () => {
  it('normalizes supported generation controls without silently accepting n > 1', () => {
    expect(
      normalizeImageGenerationRequest({
        model: 'gemini-3.1-flash-image',
        n: 1,
        prompt: 'draw a fox',
        quality: 'high',
        response_format: 'b64_json',
        size: '1536x1024',
        stream: true,
      }),
    ).toMatchObject({
      model: 'gemini-3.1-flash-image',
      n: 1,
      prompt: 'draw a fox',
      quality: 'high',
      response_format: 'b64_json',
      size: '1536x1024',
      stream: true,
    });

    expect(() => normalizeImageGenerationRequest({ prompt: 'x', n: 2 })).toThrow(/n=1/i);
  });

  it('accepts at most three requested partial frames only for a real stream', () => {
    expect(
      normalizeImageGenerationRequest({
        partial_images: 3,
        prompt: 'draw progressive detail',
        stream: true,
      }),
    ).toMatchObject({ partial_images: 3, stream: true });

    expect(() =>
      normalizeImageGenerationRequest({ partial_images: 1, prompt: 'draw', stream: false }),
    ).toThrow(/partial_images.*stream/i);
    expect(() =>
      normalizeImageGenerationRequest({ partial_images: 4, prompt: 'draw', stream: true }),
    ).toThrow(/partial_images/i);
  });

  it('maps OpenAI dimensions to exact supported Gemini aspect ratios and resolutions', () => {
    expect(getGeminiImageRequestMetadata({ size: '1536x1024', quality: 'medium' })).toEqual({
      image_aspect_ratio: '3:2',
      image_size: '2K',
    });
    expect(getGeminiImageRequestMetadata({ size: '1024x1536', quality: 'high' })).toEqual({
      image_aspect_ratio: '2:3',
      image_size: '4K',
    });
  });

  it('accepts JSON image arrays and a data-URL mask', () => {
    const request = normalizeImageEditJsonRequest({
      images: [
        { image_url: `data:image/png;base64,${png.toString('base64')}` },
        { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
      ],
      mask: {
        image_url: `data:image/png;base64,${png.toString('base64').replace(/=+$/u, '')}`,
      },
      prompt: 'combine these images',
    });

    expect(request.image).toMatchObject({ data: png.toString('base64'), mimeType: 'image/png' });
    expect(request.reference_images).toEqual([
      expect.objectContaining({ data: jpeg.toString('base64'), mimeType: 'image/jpeg' }),
    ]);
    expect(request.mask).toMatchObject({ data: png.toString('base64'), mimeType: 'image/png' });
  });

  it('caps the combined image and mask count at the Gemini upstream maximum', () => {
    const image = { data: png.toString('base64'), mimeType: 'image/png' };
    expect(
      normalizeImageEditJsonRequest({
        images: Array.from({ length: 14 }, () => image),
        prompt: 'x',
      }).reference_images,
    ).toHaveLength(13);
    expect(() =>
      normalizeImageEditJsonRequest({
        images: Array.from({ length: 14 }, () => image),
        mask: image,
        prompt: 'x',
      }),
    ).toThrow(/maximum of 14/i);
  });

  it.each([
    { images: [{ image_url: 'https://example.com/source.png' }], prompt: 'edit' },
    { images: [{ file_id: 'file_123' }], prompt: 'edit' },
  ])('fails closed for media references without an upstream-backed resolver', (body) => {
    expect(() => normalizeImageEditJsonRequest(body)).toThrow(/unsupported/i);
  });

  it('requires a prompt and at least one image', () => {
    expect(() => normalizeImageGenerationRequest({})).toThrow(/prompt/i);
    expect(() => normalizeImageEditJsonRequest({ prompt: 'edit' })).toThrow(/image/i);
  });
});
