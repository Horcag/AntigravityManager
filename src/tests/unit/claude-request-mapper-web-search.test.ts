import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

function createWebSearchRequest(model: string): ClaudeRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'Find the latest documentation.' }],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
      },
    ],
  };
}

describe('ClaudeRequestMapper web-search model compatibility', () => {
  it.each(['gemini-pro-agent', 'gemini-3.5-flash-high', 'agent-pro'])(
    'keeps explicitly selected model %s when web search is enabled',
    (model) => {
      const body = transformClaudeRequestIn(createWebSearchRequest(model));

      expect(body.model).toBe(model);
      expect(body.request.tools).toContainEqual({ googleSearch: {} });
    },
  );

  it('keeps an unknown model for the upstream to validate', () => {
    const body = transformClaudeRequestIn(createWebSearchRequest('custom-model'));

    expect(body.model).toBe('custom-model');
    expect(body.request.tools).toContainEqual({ googleSearch: {} });
  });
});
