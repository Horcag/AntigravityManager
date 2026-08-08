import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAIResponsesSessionStoreImpl } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';
import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Every assertion here reads through a store built fresh over the same
 * directory, which is what an app restart actually looks like. Asserting
 * against the instance that wrote the session would prove nothing.
 */
describe('OpenAIResponsesSessionStore durability', () => {
  let directory = '';
  let filePath = '';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-responses-sessions-'));
    filePath = path.join(directory, 'openai-responses-sessions.json');
  });

  afterEach(() => {
    fs.rmSync(directory, { force: true, recursive: true });
  });

  function createStore(overrides: { maxSessions?: number; ttlMs?: number } = {}) {
    return new OpenAIResponsesSessionStoreImpl({
      filePath,
      maxSessions: overrides.maxSessions ?? 500,
      ttlMs: overrides.ttlMs ?? HOUR_MS,
    });
  }

  it('continues a response chain created before the restart', async () => {
    const before = createStore();
    before.save('resp_kept', {
      inputItems: [{ type: 'message', role: 'user' }],
      instructions: 'be brief',
      model: 'gemini-3-flash',
      response: { id: 'resp_kept', object: 'response', output: [] },
      store: true,
    });
    await before.flush();

    const after = createStore();

    expect(after.get('resp_kept')).toMatchObject({
      inputItems: [{ type: 'message', role: 'user' }],
      instructions: 'be brief',
      model: 'gemini-3-flash',
      response: { id: 'resp_kept' },
    });
  });

  it('keeps the tool calls a continuation needs to repair orphan outputs', async () => {
    const before = createStore();
    before.save('resp_tools', {
      inputItems: [
        { type: 'function_call', call_id: 'call_1', name: 'apply_patch', arguments: '{}' },
      ],
      model: 'gemini-3-flash',
    });
    await before.flush();

    expect(createStore().get('resp_tools')?.toolCallItems).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'apply_patch', arguments: '{}' },
    ]);
  });

  it('does not resolve a session that expired while the app was down', async () => {
    const before = createStore({ ttlMs: HOUR_MS });
    before.save('resp_expired', { inputItems: [], model: 'gemini-3-flash' });
    await before.flush();

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      entries: Array<{ updatedAt: number }>;
    };
    stored.entries[0].updatedAt = Date.now() - HOUR_MS - 1;
    fs.writeFileSync(filePath, JSON.stringify(stored), 'utf-8');

    expect(createStore({ ttlMs: HOUR_MS }).get('resp_expired')).toBeNull();
  });

  it('evicts the least recently used chain at the size ceiling', async () => {
    const before = createStore({ maxSessions: 2 });
    before.save('resp_1', { inputItems: [], model: 'gemini-3-flash' });
    before.save('resp_2', { inputItems: [], model: 'gemini-3-flash' });
    before.get('resp_1');
    before.save('resp_3', { inputItems: [], model: 'gemini-3-flash' });
    await before.flush();

    const after = createStore({ maxSessions: 2 });

    expect(after.get('resp_2')).toBeNull();
    expect(after.get('resp_1')).not.toBeNull();
    expect(after.get('resp_3')).not.toBeNull();
  });

  it('starts clean when the state file was truncated by a kill mid-write', () => {
    fs.writeFileSync(filePath, '{"version":1,"entries":[{"key":"resp_kept","upda', 'utf-8');

    const store = createStore();

    expect(store.get('resp_kept')).toBeNull();
    expect(() => store.save('resp_new', { inputItems: [], model: 'gemini-3-flash' })).not.toThrow();
  });

  it('drops a session whose transcript no longer has the fields a chain needs', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          { key: 'resp_ok', updatedAt: Date.now(), value: { inputItems: [], model: 'gemini' } },
          { key: 'resp_broken', updatedAt: Date.now(), value: { inputItems: 'not-a-list' } },
        ],
      }),
      'utf-8',
    );

    const store = createStore();

    expect(store.get('resp_ok')).not.toBeNull();
    expect(store.get('resp_broken')).toBeNull();
  });

  it('forgets a deleted response across a restart', async () => {
    const before = createStore();
    before.save('resp_gone', { inputItems: [], model: 'gemini-3-flash' });
    before.delete('resp_gone');
    await before.flush();

    expect(createStore().get('resp_gone')).toBeNull();
  });

  it('continues a chain through a controller rebuilt over the same directory', async () => {
    const beforeStore = createStore();
    const beforeService = {
      handleChatCompletions: vi
        .fn()
        .mockResolvedValue(completion('resp_restart_1', 'First answer')),
    };
    await new ProxyController(
      beforeService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      beforeStore,
    ).responses({ input: 'First question', model: 'gpt-4o' }, createReplyMock() as never);
    await beforeStore.flush();

    const afterService = {
      handleChatCompletions: vi.fn().mockResolvedValue(completion('resp_restart_2', 'Second')),
    };
    const afterReply = createReplyMock();
    await new ProxyController(
      afterService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createStore(),
    ).responses(
      { input: 'Second question', previous_response_id: 'resp_restart_1' },
      afterReply as never,
    );

    expect(afterReply.status).toHaveBeenCalledWith(200);
    expect(afterService.handleChatCompletions.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ]);
  });

  it('leaves nothing resolvable after a restart when the client sent store=false', async () => {
    const beforeStore = createStore();
    const beforeService = {
      handleChatCompletions: vi
        .fn()
        .mockResolvedValue(completion('resp_ephemeral', 'Not persisted')),
    };
    await new ProxyController(
      beforeService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      beforeStore,
    ).responses(
      { input: 'First question', model: 'gpt-4o', store: false },
      createReplyMock() as never,
    );
    await beforeStore.flush();

    const afterReply = createReplyMock();
    await new ProxyController(
      { handleChatCompletions: vi.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createStore(),
    ).responses(
      { input: 'Second question', previous_response_id: 'resp_ephemeral' },
      afterReply as never,
    );

    expect(afterReply.status).toHaveBeenCalledWith(404);
    expect(afterReply.send).toHaveBeenCalledWith({
      error: {
        code: 'previous_response_not_found',
        message: "Previous response with id 'resp_ephemeral' not found.",
        param: 'previous_response_id',
        type: 'invalid_request_error',
      },
    });
  });
});

function completion(id: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-4o',
    choices: [{ index: 0, finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function createReplyMock() {
  const reply = {
    header: vi.fn(() => reply),
    send: vi.fn(() => reply),
    status: vi.fn(() => reply),
  };
  return reply;
}
