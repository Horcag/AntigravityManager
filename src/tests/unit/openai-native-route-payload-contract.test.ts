import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type {
  GeminiInternalRequest,
  GeminiRequest,
  SafetySetting,
} from '@/modules/proxy-gateway/antigravity/types';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/modules/shared/services/generation-constraints.service';
import { ModelAvailabilityService } from '@/modules/proxy-gateway/server/modules/shared/services/model-availability.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/modules/shared/services/model-routing.service';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/modules/shared/services/proxy-retry.service';
import type { OpenAIChatRequest } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

const mockAccountLeaseService = {
  getModelOutputLimitForAccount: vi.fn(),
  getModelThinkingBudgetForAccount: vi.fn(),
};
const mockGeminiClient = { streamGenerateInternal: vi.fn(), generateInternal: vi.fn() };
const ALL_SAFETY_CATEGORIES: ReadonlyArray<SafetySetting['category']> = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
];

class TestableProxyService extends ProxyService {
  constructor() {
    super(
      mockAccountLeaseService as any,
      mockGeminiClient as any,
      new GenerationConstraintsService(mockAccountLeaseService as any),
      new ProxyRetryService(mockAccountLeaseService as any, new ModelAvailabilityService()),
      new ModelRoutingService(),
      new SignatureStore(),
    );
  }

  public buildOpenAIInternalRequest(
    request: OpenAIChatRequest,
    resolvedModel = request.model,
  ): GeminiInternalRequest['request'] {
    const converter = Reflect.get(this, 'convertOpenAIToClaude');
    if (typeof converter !== 'function') {
      throw new Error('convertOpenAIToClaude unavailable');
    }

    const claudeRequest = Reflect.apply(converter, this, [request]) as Parameters<
      typeof transformClaudeRequestIn
    >[0];

    const body = transformClaudeRequestIn(claudeRequest, undefined, 'unit-agent', resolvedModel, {
      accountId: 'acct-unit',
      store: this.signatureStore,
    });
    this.applyInternalGenerationConstraints(body, body.model, 'acct-unit');
    return body.request;
  }

  public buildNativeInternalRequest(
    request: GeminiRequest,
    model: string,
  ): GeminiInternalRequest['request'] {
    const converter = Reflect.get(this, 'toInternalGeminiRequest');
    if (typeof converter !== 'function') {
      throw new Error('toInternalGeminiRequest unavailable');
    }

    const mapped = Reflect.apply(converter, this, [request]) as GeminiInternalRequest['request'];
    const body: GeminiInternalRequest = {
      request: mapped,
      model,
      userAgent: 'unit-agent',
      requestId: 'unit-request-id',
      requestType: 'generate-content',
    };
    this.applyInternalGenerationConstraints(body, model, 'acct-unit');
    return body.request;
  }
}

function stripSafety(request: GeminiInternalRequest['request']) {
  const { safetySettings: _safetySettings, ...payloadWithoutSafety } = request;
  return payloadWithoutSafety;
}

function toExpectedSafetySettings(categories: readonly string[]): SafetySetting[] {
  return categories.map((category) => ({ category, threshold: 'OFF' }));
}

describe('OpenAI and native Gemini payload contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      'gemini-2.5-flash',
      [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ],
    ],
    [
      'gemini-2.5-flash-lite',
      [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ],
    ],
    [
      'gemini-2.5-flash-thinking',
      [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ],
    ],
    [
      'gemini-3.1-flash-lite',
      [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ],
    ],
    ['gpt-oss-120b-medium', []],
  ] as const)('captures deterministic route parity for %s', (model, expectedCategories) => {
    const service = new TestableProxyService();
    const openaiRequest: OpenAIChatRequest = {
      model,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 8,
    };
    const openaiPayload = service.buildOpenAIInternalRequest(openaiRequest, model);
    const nativePayload = service.buildNativeInternalRequest(
      {
        contents: openaiPayload.contents,
        ...(openaiPayload.systemInstruction
          ? { systemInstruction: openaiPayload.systemInstruction }
          : {}),
        ...(openaiPayload.generationConfig
          ? { generationConfig: openaiPayload.generationConfig }
          : {}),
      },
      model,
    );

    expect(nativePayload).toEqual(stripSafety(openaiPayload));
    expect(nativePayload).not.toHaveProperty('safetySettings');
    const expectedSafety = toExpectedSafetySettings(expectedCategories);
    if (expectedSafety.length > 0) {
      expect(openaiPayload.safetySettings).toEqual(expectedSafety);
    } else {
      expect(openaiPayload).not.toHaveProperty('safetySettings');
      expect(openaiPayload.safetySettings).toBeUndefined();
    }
  });

  it('retains all five safety categories when no override family rule applies', () => {
    const service = new TestableProxyService();
    const model = 'gemini-2.0-flash';
    const openaiRequest: OpenAIChatRequest = {
      model,
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 8,
    };

    const openaiPayload = service.buildOpenAIInternalRequest(openaiRequest, model);

    expect(openaiPayload.safetySettings).toEqual(toExpectedSafetySettings(ALL_SAFETY_CATEGORIES));
  });
});
