import { describe, expect, it, vi } from 'vitest';

import { OpenAIResponsesSessionService } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesStoreController } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-store.controller';

function createReplyMock() {
  const reply = {
    send: vi.fn(),
    status: vi.fn(() => reply),
  };
  return reply;
}

function createController() {
  const sessionStore = new OpenAIResponsesSessionService({});
  return { controller: new OpenAIResponsesStoreController(sessionStore), sessionStore };
}

describe('OpenAIResponsesStoreController', () => {
  it('replays a stored response', () => {
    const { controller, sessionStore } = createController();
    sessionStore.save('resp_1', {
      inputItems: [],
      model: 'gemini-3-flash',
      response: { id: 'resp_1', object: 'response', output: [] },
    });
    const reply = createReplyMock();

    controller.getResponse('resp_1', reply as never);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ id: 'resp_1', object: 'response', output: [] });
  });

  it('reports an unknown id with the OpenAI not-found shape', () => {
    const { controller } = createController();
    const reply = createReplyMock();

    controller.getResponse('resp_missing', reply as never);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'response_not_found',
        message: "Response with id 'resp_missing' not found.",
        param: 'id',
        type: 'invalid_request_error',
      },
    });
  });

  it('deletes a stored response and refuses to delete it twice', () => {
    const { controller, sessionStore } = createController();
    sessionStore.save('resp_1', {
      inputItems: [],
      model: 'gemini-3-flash',
      response: { id: 'resp_1', object: 'response', output: [] },
    });
    const firstReply = createReplyMock();
    const secondReply = createReplyMock();

    controller.deleteResponse('resp_1', firstReply as never);
    controller.deleteResponse('resp_1', secondReply as never);

    expect(firstReply.status).toHaveBeenCalledWith(200);
    expect(firstReply.send).toHaveBeenCalledWith({
      id: 'resp_1',
      object: 'response',
      deleted: true,
    });
    expect(secondReply.status).toHaveBeenCalledWith(404);
    expect(sessionStore.get('resp_1')).toBeNull();
  });
});
