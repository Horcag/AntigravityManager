import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createMultipartPayload } from '../support/http-payloads';
import { createProxyConformanceApp } from '../support/proxy-conformance-harness';

const proxyService = {
  handleAnthropicCountTokens: vi.fn(),
  handleAnthropicMessages: vi.fn(),
  handleChatCompletions: vi.fn(),
  handleGeminiCountTokens: vi.fn(),
  handleGeminiGenerateContent: vi.fn(),
  handleGeminiStreamGenerateContent: vi.fn(),
};

function partPayload(bytes: Buffer) {
  const boundary = '----agmuploads';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: createMultipartPayload(
      boundary,
      [],
      [{ bytes, field: 'data', filename: 'part.bin', mimeType: 'application/octet-stream' }],
    ),
  };
}

describe('OpenAI Uploads protocol', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createProxyConformanceApp({ proxyService });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('assembles parts in requested order into the shared local file store', async () => {
    const source = Buffer.from('first-half|second-half', 'utf8');
    const first = source.subarray(0, 11);
    const second = source.subarray(11);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      payload: {
        bytes: source.length,
        filename: 'ordered.txt',
        purpose: 'user_data',
        mime_type: 'text/plain',
      },
    });

    expect(created.statusCode).toBe(200);
    const upload = created.json();
    expect(upload).toMatchObject({
      object: 'upload',
      status: 'pending',
      bytes: source.length,
      filename: 'ordered.txt',
      purpose: 'user_data',
      mime_type: 'text/plain',
    });
    expect(upload.id).toMatch(/^upload_[0-9a-f]{32}$/u);
    expect(upload.expires_at).toBeGreaterThan(Date.now() / 1000);

    const secondPart = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/parts`,
      ...partPayload(second),
    });
    const firstPart = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/parts`,
      ...partPayload(first),
    });
    expect(secondPart.json()).toMatchObject({ object: 'upload.part', upload_id: upload.id });
    expect(firstPart.json().id).toMatch(/^part_[0-9a-f]{32}$/u);

    const completed = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/complete`,
      payload: { part_ids: [firstPart.json().id, secondPart.json().id] },
    });
    expect(completed.statusCode).toBe(200);
    const file = completed.json();
    expect(file).toMatchObject({ object: 'file', bytes: source.length, filename: 'ordered.txt' });

    const content = await app.inject({ method: 'GET', url: `/v1/files/${file.id}/content` });
    expect(content.rawPayload.equals(source)).toBe(true);
    const listed = await app.inject({ method: 'GET', url: '/v1/files' });
    expect(listed.json().data.some((entry: { id: string }) => entry.id === file.id)).toBe(true);
  });

  it('rejects a mismatched declared length and lets cancellation release the partial upload', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      payload: {
        bytes: 6,
        filename: 'mismatch.txt',
        purpose: 'user_data',
        mime_type: 'text/plain',
      },
    });
    const upload = created.json();
    const part = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/parts`,
      ...partPayload(Buffer.from('five!', 'utf8')),
    });

    const mismatch = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/complete`,
      payload: { part_ids: [part.json().id] },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({
      error: { code: 'byte_count_mismatch', param: 'bytes', type: 'invalid_request_error' },
    });

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/cancel`,
    });
    expect(cancelled.json()).toMatchObject({ id: upload.id, status: 'cancelled' });
    const afterCancel = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/complete`,
      payload: { part_ids: [part.json().id] },
    });
    expect(afterCancel.statusCode).toBe(404);
    expect(afterCancel.json()).toMatchObject({
      error: { code: 'upload_not_found', param: 'upload_id', type: 'invalid_request_error' },
    });
  });

  it('returns OpenAI error envelopes for malformed upload requests', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/uploads', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_request', param: 'bytes', type: 'invalid_request_error' },
    });
  });
});
