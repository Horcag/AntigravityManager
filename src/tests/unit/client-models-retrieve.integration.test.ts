/**
 * `GET /v1/models/{id}` — retrieve-model on the two compatible surfaces
 * (kanban #54).
 *
 * Measured live on 0.19.31-local1: `/v1beta/models/gemini-3-flash` answered 200
 * while `/v1/models/gemini-3-flash` answered 404, so an OpenAI or Anthropic
 * client could list models but never check one.
 */
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogModelRoleIndex } from '@/modules/proxy-gateway/antigravity/ModelMapping';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { ClientModelsController } from '@/modules/proxy-gateway/server/modules/models/client-models.controller';
import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

const ANTHROPIC_VERSION_HEADER = { 'anthropic-version': '2023-06-01' };

describe('GET /v1/models/{id} (kanban #54)', () => {
  let app: NestFastifyApplication;

  const accountLeaseService = {
    getAllCollectedModels: vi.fn(() => new Set(['gemini-3-flash', 'gemini-3.1-pro-high'])),
    getCatalogModelRoleIndex: vi.fn<() => CatalogModelRoleIndex | undefined>(() => undefined),
  };

  beforeAll(async () => {
    @Module({
      // `ProxyController` comes along so the list and the retrieve route can be
      // compared against each other in the same process.
      controllers: [ClientModelsController, ProxyController],
      providers: [
        { provide: ProxyService, useValue: {} },
        { provide: AccountLeaseService, useValue: accountLeaseService },
      ],
    })
    class TestModelsModule {}

    app = await NestFactory.create<NestFastifyApplication>(TestModelsModule, new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalGuards({ canActivate: () => true });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    accountLeaseService.getAllCollectedModels.mockReturnValue(
      new Set(['gemini-3-flash', 'gemini-3.1-pro-high']),
    );
    accountLeaseService.getCatalogModelRoleIndex.mockReturnValue(undefined);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers the OpenAI model object by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models/gemini-3-flash' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: 'gemini-3-flash',
      object: 'model',
      created: expect.any(Number),
      owned_by: 'antigravity',
    });
  });

  it('returns exactly the entry GET /v1/models publishes for the same id', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/models' });
    const retrieved = await app.inject({ method: 'GET', url: '/v1/models/gemini-3.1-pro-high' });

    const listed = list
      .json()
      .data.find((entry: { id: string }) => entry.id === 'gemini-3.1-pro-high');
    expect(listed).toBeDefined();
    expect(retrieved.json()).toEqual(listed);
  });

  it('answers the Anthropic model object when the caller speaks Anthropic', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/gemini-3-flash',
      headers: ANTHROPIC_VERSION_HEADER,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: 'gemini-3-flash',
      type: 'model',
      display_name: 'gemini-3-flash',
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
  });

  it('picks the Anthropic dialect from anthropic-beta too, like /v1/files does', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/gemini-3-flash',
      headers: { 'anthropic-beta': 'files-api-2025-04-14' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().type).toBe('model');
  });

  it('404s an unknown id in the OpenAI envelope without substituting a near match', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models/gemini-3-flash-typo' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        message: expect.stringContaining('gemini-3-flash-typo'),
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found',
      },
    });
  });

  it('404s an unknown id in the Anthropic envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/gemini-3-flash-typo',
      headers: ANTHROPIC_VERSION_HEADER,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error', message: expect.stringContaining('gemini-3-flash-typo') },
    });
    expect(res.headers['request-id']).toEqual(expect.stringMatching(/^req_/u));
  });

  it('hides a catalog id the list withholds, exactly as if it did not exist', async () => {
    accountLeaseService.getAllCollectedModels.mockReturnValue(
      new Set(['gemini-3-flash', 'chat_20706']),
    );
    accountLeaseService.getCatalogModelRoleIndex.mockReturnValue({
      nonChatRoles: new Map(),
      chatModelIds: new Set(),
      hasChatRoleData: true,
      completionFlags: new Map([['chat_20706', ['requiresLeadInGeneration']]]),
    });

    const list = await app.inject({ method: 'GET', url: '/v1/models' });
    const withheld = await app.inject({ method: 'GET', url: '/v1/models/chat_20706' });
    const unknown = await app.inject({ method: 'GET', url: '/v1/models/never-existed' });

    expect(list.json().data.map((entry: { id: string }) => entry.id)).toEqual(['gemini-3-flash']);
    expect(withheld.statusCode).toBe(unknown.statusCode);
    expect(withheld.statusCode).toBe(404);
    // Same envelope and same code as an id that was never in the catalog: the
    // answer must not leak that this one exists but is withheld.
    expect(withheld.json()).toEqual({
      ...unknown.json(),
      error: { ...unknown.json().error, message: expect.stringContaining('chat_20706') },
    });
  });

  it('leaves GET /v1/models itself untouched', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });

    expect(res.statusCode).toBe(200);
    expect(res.json().object).toBe('list');
  });
});
