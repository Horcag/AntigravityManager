import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '../../modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';

function convertOpenAIToClaude(request: Record<string, unknown>) {
  const service = new ProxyService({} as never, {} as never);
  const target = service as unknown as {
    convertOpenAIToClaude: (value: Record<string, unknown>) => Parameters<
      typeof transformClaudeRequestIn
    >[0];
  };

  return target.convertOpenAIToClaude(request);
}

describe('OpenAI max_completion_tokens compatibility', () => {
  it('prefers max_completion_tokens and forwards it to Gemini maxOutputTokens', () => {
    const claudeRequest = convertOpenAIToClaude({
      model: 'gpt-4o',
      max_tokens: 32,
      max_completion_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    });

    const body = transformClaudeRequestIn(claudeRequest);

    expect(claudeRequest.max_tokens).toBe(16);
    expect(body.request.generationConfig?.maxOutputTokens).toBe(16);
    expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  it('keeps legacy max_tokens when max_completion_tokens is absent', () => {
    const claudeRequest = convertOpenAIToClaude({
      model: 'gpt-4o',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(claudeRequest.max_tokens).toBe(32);
  });
});
