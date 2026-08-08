import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import { attachModelRouteMetadata } from '@/modules/proxy-gateway/server/common/model-route-metadata';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest, GeminiPart } from '@/modules/proxy-gateway/antigravity/types';
import type {
  GeminiRequest,
  OpenAIChatRequest,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { createProxyConformanceApp } from '../support/proxy-conformance-harness';
import { createMultipartPayload } from '../support/http-payloads';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 9),
]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(16, 4)]);

const proxyService = {
  handleAnthropicCountTokens: vi.fn(),
  handleAnthropicMessages: vi.fn(),
  handleChatCompletions: vi.fn(),
  handleGeminiCountTokens: vi.fn(),
  handleGeminiGenerateContent: vi.fn(),
  handleGeminiStreamGenerateContent: vi.fn(),
};

/**
 * The real conversion chain, borrowed from `ProxyService` so the assertions
 * land on the payload that actually leaves the process rather than on an
 * intermediate object the controller happened to build.
 */
const conversions = Object.create(ProxyService.prototype) as {
  convertOpenAIToClaude(request: OpenAIChatRequest): ClaudeRequest;
  toInternalGeminiRequest(request: GeminiRequest): { contents?: GeminiRequest['contents'] };
};

function upstreamPartsFromClaude(request: ClaudeRequest): GeminiPart[] {
  const wire = transformClaudeRequestIn(request);
  return (wire.request.contents ?? []).flatMap((content) => content.parts ?? []);
}

function upstreamPartsFromOpenAI(request: OpenAIChatRequest): GeminiPart[] {
  return upstreamPartsFromClaude(conversions.convertOpenAIToClaude(request));
}

function withRoute<T extends object>(value: T): T {
  return attachModelRouteMetadata(value, {
    requestedModel: 'conformance-model',
    resolvedModel: 'conformance-model',
    servedModel: 'conformance-model',
    routeSource: 'canonical',
  });
}

function multipartUpload(
  fields: Array<[string, string]>,
  file: { bytes: Buffer; filename: string; mimeType: string },
) {
  const boundary = '----agmfiles';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: createMultipartPayload(boundary, fields, [
      { bytes: file.bytes, field: 'file', filename: file.filename, mimeType: file.mimeType },
    ]),
  };
}

const ANTHROPIC_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'files-api-2025-04-14',
};

describe('local files API across the three surfaces', () => {
  let app: NestFastifyApplication;

  async function uploadOpenAI(
    bytes: Buffer,
    filename: string,
    mimeType: string,
    purpose = 'user_data',
  ) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/files',
      ...multipartUpload([['purpose', purpose]], { bytes, filename, mimeType }),
    });
    return response;
  }

  beforeAll(async () => {
    app = await createProxyConformanceApp({ proxyService });
  });

  beforeEach(() => {
    for (const handler of Object.values(proxyService)) {
      handler.mockReset();
    }
    // Route metadata rides on the result in production; attaching it keeps the
    // controller from asking the routing service fixture to resolve a route.
    proxyService.handleChatCompletions.mockImplementation(async () =>
      withRoute({
        id: 'chatcmpl-files',
        created: 1_700_000_000,
        model: 'conformance-model',
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    proxyService.handleAnthropicMessages.mockImplementation(async () =>
      withRoute({ content: [{ type: 'text', text: 'ok' }] }),
    );
    proxyService.handleGeminiGenerateContent.mockImplementation(async () =>
      withRoute({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('OpenAI /v1/files', () => {
    it('round-trips upload, list, get, content and delete', async () => {
      const uploaded = await uploadOpenAI(png, 'shot.png', 'image/png');
      expect(uploaded.statusCode).toBe(200);
      const file = uploaded.json();
      expect(file).toMatchObject({
        object: 'file',
        bytes: png.length,
        filename: 'shot.png',
        purpose: 'user_data',
        status: 'processed',
      });
      expect(file.id).toMatch(/^file-[0-9a-f]{32}$/u);

      const listed = await app.inject({ method: 'GET', url: '/v1/files' });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().object).toBe('list');
      expect(listed.json().data.some((entry: { id: string }) => entry.id === file.id)).toBe(true);

      const fetched = await app.inject({ method: 'GET', url: `/v1/files/${file.id}` });
      expect(fetched.json()).toMatchObject({ id: file.id, filename: 'shot.png' });

      const content = await app.inject({ method: 'GET', url: `/v1/files/${file.id}/content` });
      expect(content.statusCode).toBe(200);
      expect(content.headers['content-type']).toBe('image/png');
      expect(content.rawPayload.equals(png)).toBe(true);

      const deleted = await app.inject({ method: 'DELETE', url: `/v1/files/${file.id}` });
      expect(deleted.json()).toEqual({ id: file.id, object: 'file', deleted: true });
      expect((await app.inject({ method: 'GET', url: `/v1/files/${file.id}` })).statusCode).toBe(
        404,
      );
    });

    it('refuses a purpose it cannot serve and names the ones it can', async () => {
      const response = await uploadOpenAI(png, 'shot.png', 'image/png', 'fine-tune');
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain('user_data');
      expect(response.json().error.param).toBe('purpose');
    });

    it('reports an unknown handle as not found', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/files/file-00000000000000000000000000000000',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('invalid_request_error');
    });
  });

  describe('Anthropic /v1/files', () => {
    it('round-trips upload, list, get, content and delete', async () => {
      const uploaded = await app.inject({
        method: 'POST',
        url: '/v1/files',
        headers: {
          ...ANTHROPIC_HEADERS,
          ...multipartUpload([], { bytes: pdf, filename: 'doc.pdf', mimeType: 'application/pdf' })
            .headers,
        },
        payload: multipartUpload([], {
          bytes: pdf,
          filename: 'doc.pdf',
          mimeType: 'application/pdf',
        }).payload,
      });
      expect(uploaded.statusCode).toBe(200);
      const file = uploaded.json();
      expect(file).toMatchObject({
        type: 'file',
        filename: 'doc.pdf',
        mime_type: 'application/pdf',
        size_bytes: pdf.length,
        downloadable: true,
      });
      expect(file.id).toMatch(/^file_[0-9a-f]{32}$/u);

      const listed = await app.inject({
        method: 'GET',
        url: '/v1/files',
        headers: ANTHROPIC_HEADERS,
      });
      expect(listed.json().data.some((entry: { id: string }) => entry.id === file.id)).toBe(true);
      expect(listed.json()).toHaveProperty('has_more');

      const content = await app.inject({
        method: 'GET',
        url: `/v1/files/${file.id}/content`,
        headers: ANTHROPIC_HEADERS,
      });
      expect(content.rawPayload.equals(pdf)).toBe(true);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/files/${file.id}`,
        headers: ANTHROPIC_HEADERS,
      });
      expect(deleted.json()).toEqual({ id: file.id, type: 'file_deleted' });
    });

    it('requires the files beta header and says so', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/files',
        headers: { 'anthropic-version': '2023-06-01' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error' },
      });
      expect(response.json().error.message).toContain('files-api-2025-04-14');
    });
  });

  describe('Gemini /v1beta/files', () => {
    it('accepts the simple media upload form and round-trips the resource', async () => {
      const uploaded = await app.inject({
        method: 'POST',
        url: '/upload/v1beta/files?uploadType=media',
        headers: { 'content-type': 'image/png' },
        payload: png,
      });
      expect(uploaded.statusCode).toBe(200);
      const file = uploaded.json().file;
      expect(file).toMatchObject({
        mimeType: 'image/png',
        sizeBytes: String(png.length),
        state: 'ACTIVE',
        source: 'UPLOADED',
      });
      expect(file.name).toMatch(/^files\/[0-9a-f]{32}$/u);
      expect(file.uri).toContain(file.name);
      expect(new Date(file.expirationTime).getTime()).toBeGreaterThan(Date.now());

      const id = file.name.replace('files/', '');
      const fetched = await app.inject({ method: 'GET', url: `/v1beta/files/${id}` });
      expect(fetched.json().name).toBe(file.name);

      const listed = await app.inject({ method: 'GET', url: '/v1beta/files' });
      expect(listed.json().files.some((entry: { name: string }) => entry.name === file.name)).toBe(
        true,
      );

      expect((await app.inject({ method: 'DELETE', url: `/v1beta/files/${id}` })).statusCode).toBe(
        200,
      );
      expect((await app.inject({ method: 'GET', url: `/v1beta/files/${id}` })).statusCode).toBe(
        404,
      );
    });

    it('accepts the multipart upload form with a metadata display name', async () => {
      const uploaded = await app.inject({
        method: 'POST',
        url: '/upload/v1beta/files?uploadType=multipart',
        ...multipartUpload([['metadata', JSON.stringify({ file: { display_name: 'named' } })]], {
          bytes: pdf,
          filename: 'ignored.pdf',
          mimeType: 'application/pdf',
        }),
      });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json().file.displayName).toBe('named');
    });

    it('rejects an upload type it does not implement', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/upload/v1beta/files?uploadType=resumable',
        headers: { 'content-type': 'image/png' },
        payload: png,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.status).toBe('INVALID_ARGUMENT');
    });
  });

  describe('reference expansion reaches the outgoing upstream payload', () => {
    it('expands a Gemini fileData part into inlineData', { timeout: 20_000 }, async () => {
      const uploaded = await app.inject({
        method: 'POST',
        url: '/upload/v1beta/files',
        headers: { 'content-type': 'image/png' },
        payload: png,
      });
      const uri = uploaded.json().file.uri;

      const response = await app.inject({
        method: 'POST',
        url: '/v1beta/models/conformance-model:generateContent',
        payload: {
          contents: [
            {
              role: 'user',
              parts: [{ text: 'describe' }, { fileData: { fileUri: uri, mimeType: 'image/png' } }],
            },
          ],
        },
      });
      expect(response.statusCode).toBe(200);

      const [, request] = proxyService.handleGeminiGenerateContent.mock.calls[0];
      const wire = conversions.toInternalGeminiRequest(request as GeminiRequest);
      const parts = (wire.contents ?? []).flatMap((content) => content.parts ?? []);
      expect(parts).toContainEqual({
        inlineData: { mimeType: 'image/png', data: png.toString('base64') },
      });
      expect(JSON.stringify(wire)).not.toContain('fileData');
    });

    it(
      'expands an OpenAI chat file part into an image inlineData part',
      { timeout: 20_000 },
      async () => {
        const file = (await uploadOpenAI(png, 'shot.png', 'image/png', 'vision')).json();

        const response = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'conformance-model',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'what is this' },
                  { type: 'file', file: { file_id: file.id } },
                ],
              },
            ],
          },
        });
        expect(response.statusCode).toBe(200);

        const parts = upstreamPartsFromOpenAI(
          proxyService.handleChatCompletions.mock.calls[0][0] as OpenAIChatRequest,
        );
        expect(parts).toContainEqual({
          inlineData: { mimeType: 'image/png', data: png.toString('base64') },
        });
      },
    );

    it(
      'expands an OpenAI chat file part for a document into a document inlineData part',
      { timeout: 20_000 },
      async () => {
        const file = (await uploadOpenAI(pdf, 'doc.pdf', 'application/pdf')).json();

        const response = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'conformance-model',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'summarise' },
                  { type: 'file', file: { file_id: file.id } },
                ],
              },
            ],
          },
        });
        expect(response.statusCode).toBe(200);

        const parts = upstreamPartsFromOpenAI(
          proxyService.handleChatCompletions.mock.calls[0][0] as OpenAIChatRequest,
        );
        expect(parts).toContainEqual({
          inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') },
        });
      },
    );

    it('expands a Responses input_image referenced by file_id', { timeout: 20_000 }, async () => {
      const file = (await uploadOpenAI(png, 'shot.png', 'image/png', 'vision')).json();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: {
          model: 'conformance-model',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'what is this' },
                { type: 'input_image', file_id: file.id },
              ],
            },
          ],
        },
      });
      expect(response.statusCode).toBe(200);

      const parts = upstreamPartsFromOpenAI(
        proxyService.handleChatCompletions.mock.calls[0][0] as OpenAIChatRequest,
      );
      expect(parts).toContainEqual({
        inlineData: { mimeType: 'image/png', data: png.toString('base64') },
      });
    });

    it('expands an Anthropic image and document file source', { timeout: 20_000 }, async () => {
      const image = (await uploadOpenAI(png, 'shot.png', 'image/png', 'vision')).json();
      const document = (await uploadOpenAI(pdf, 'doc.pdf', 'application/pdf')).json();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: ANTHROPIC_HEADERS,
        payload: {
          model: 'conformance-model',
          max_tokens: 64,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'compare these' },
                { type: 'image', source: { type: 'file', file_id: image.id } },
                { type: 'document', source: { type: 'file', file_id: document.id } },
              ],
            },
          ],
        },
      });
      expect(response.statusCode).toBe(200);

      const parts = upstreamPartsFromClaude(
        proxyService.handleAnthropicMessages.mock.calls[0][0] as ClaudeRequest,
      );
      expect(parts).toContainEqual({
        inlineData: { mimeType: 'image/png', data: png.toString('base64') },
      });
      expect(parts).toContainEqual({
        inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') },
      });
    });

    it('fails closed on a handle that was never issued', async () => {
      const unknown = '00000000000000000000000000000000';

      const gemini = await app.inject({
        method: 'POST',
        url: '/v1beta/models/conformance-model:generateContent',
        payload: {
          contents: [{ role: 'user', parts: [{ fileData: { fileUri: `files/${unknown}` } }] }],
        },
      });
      expect(gemini.statusCode).toBe(404);
      expect(gemini.json().error.status).toBe('NOT_FOUND');
      expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();

      const openai = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'conformance-model',
          messages: [
            { role: 'user', content: [{ type: 'file', file: { file_id: `file-${unknown}` } }] },
          ],
        },
      });
      expect(openai.statusCode).toBe(404);
      expect(openai.json().error.code).toBe('file_not_found');
      expect(proxyService.handleChatCompletions).not.toHaveBeenCalled();

      const anthropic = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: ANTHROPIC_HEADERS,
        payload: {
          model: 'conformance-model',
          max_tokens: 64,
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'file', file_id: `file_${unknown}` } }],
            },
          ],
        },
      });
      expect(anthropic.statusCode).toBe(400);
      expect(anthropic.json().error.message).toContain(unknown);
      expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
    });

    it('rejects a fileUri this proxy never issued instead of forwarding it', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1beta/models/conformance-model:generateContent',
        payload: {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  fileData: {
                    fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
                  },
                },
              ],
            },
          ],
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toContain('not a file handle issued by this proxy');
      expect(proxyService.handleGeminiGenerateContent).not.toHaveBeenCalled();
    });
  });

  it('shares one stored copy across the three surfaces', async () => {
    const openai = (await uploadOpenAI(png, 'shot.png', 'image/png')).json();
    const gemini = await app.inject({
      method: 'POST',
      url: '/upload/v1beta/files',
      headers: { 'content-type': 'image/png' },
      payload: png,
    });

    expect(gemini.json().file.name).toBe(`files/${openai.id.replace('file-', '')}`);
  });

  it('corrects a mislabelled MIME type at upload time', async () => {
    const uploaded = await uploadOpenAI(png, 'liar.jpg', 'image/jpeg');
    const id = uploaded.json().id.replace('file-', '');

    const gemini = await app.inject({ method: 'GET', url: `/v1beta/files/${id}` });
    expect(gemini.json().mimeType).toBe('image/png');
  });
});

describe('expired handles on the wire', () => {
  let expiredApp: NestFastifyApplication;

  beforeAll(async () => {
    expiredApp = await createProxyConformanceApp({
      proxyService,
      fileStore: { ttlMs: 0 },
    });
  });

  afterAll(async () => {
    await expiredApp?.close();
  });

  it('reports an expired handle rather than sending an empty part', async () => {
    const uploaded = await expiredApp.inject({
      method: 'POST',
      url: '/upload/v1beta/files',
      headers: { 'content-type': 'image/png' },
      payload: png,
    });
    const uri = uploaded.json().file.uri;

    const response = await expiredApp.inject({
      method: 'POST',
      url: '/v1beta/models/conformance-model:generateContent',
      payload: { contents: [{ role: 'user', parts: [{ fileData: { fileUri: uri } }] }] },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain('expired');
  });
});
