import {
  rebindModelVariant,
  resolveModelVariant,
} from '../../../../antigravity/model-variant-registry';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '../../../common/interfaces/request-interfaces';

export interface AppliedAnthropicModelVariant {
  request: AnthropicChatRequest;
  variant: ReturnType<typeof resolveModelVariant>;
}

export function applyAnthropicModelVariant(
  request: AnthropicChatRequest,
): AppliedAnthropicModelVariant {
  const variant = resolveModelVariant({
    model: request.model,
    budgetTokens: request.thinking?.budget_tokens,
    effort: request.output_config?.effort,
  });
  if (!variant) {
    return {
      request,
      variant: null,
    };
  }

  return {
    request: {
      ...request,
      model: variant.model,
      max_tokens: applyAnthropicOutputLimit(request.max_tokens, variant.maxOutputTokens),
      thinking:
        request.thinking?.type === 'disabled'
          ? { type: 'disabled' }
          : variant.thinkingBudget === 0
            ? undefined
            : {
                type: 'enabled',
                budget_tokens: variant.thinkingBudget,
              },
      tools: variant.supportsTools ? request.tools : undefined,
      tool_choice: variant.supportsTools ? request.tool_choice : undefined,
      output_config: undefined,
    },
    variant,
  };
}

export function rebindAnthropicModelVariant(
  applied: AppliedAnthropicModelVariant,
  physicalModel: string,
): AppliedAnthropicModelVariant {
  const variant = rebindModelVariant(applied.variant, physicalModel);
  if (!variant) {
    return applied;
  }

  return {
    request: {
      ...applied.request,
      model: variant.model,
      max_tokens: applyAnthropicOutputLimit(applied.request.max_tokens, variant.maxOutputTokens),
      thinking:
        applied.request.thinking?.type === 'disabled'
          ? { type: 'disabled' }
          : variant.thinkingBudget === 0
            ? undefined
            : {
                type: 'enabled',
                budget_tokens: variant.thinkingBudget,
              },
      tools: variant.supportsTools ? applied.request.tools : undefined,
      tool_choice: variant.supportsTools ? applied.request.tool_choice : undefined,
    },
    variant,
  };
}

function applyAnthropicOutputLimit(requestedLimit: number | undefined, modelLimit: number): number {
  return requestedLimit === undefined ? modelLimit : Math.min(requestedLimit, modelLimit);
}

export interface AppliedOpenAIModelVariant {
  request: OpenAIChatRequest;
  variant: ReturnType<typeof resolveModelVariant>;
}

export function applyOpenAIModelVariant(request: OpenAIChatRequest): AppliedOpenAIModelVariant {
  const thinkingDisabled = request.thinking?.type === 'disabled';
  const variant = resolveModelVariant({
    model: request.model,
    budgetTokens: request.thinking?.budget_tokens,
    effort: request.reasoning_effort ?? request.thinking?.effort,
  });
  if (!variant) {
    return {
      request,
      variant: null,
    };
  }

  return {
    request: {
      ...request,
      model: variant.model,
      ...applyOpenAIOutputLimit(request, variant.maxOutputTokens),
      thinking: thinkingDisabled
        ? { type: 'disabled' }
        : variant.thinkingBudget === 0
          ? undefined
          : {
              type: 'enabled',
              budget_tokens: variant.thinkingBudget,
            },
      tools: variant.supportsTools ? request.tools : undefined,
      tool_choice: variant.supportsTools ? request.tool_choice : undefined,
      ...(request.reasoning_effort !== undefined ? { reasoning_effort: variant.tier } : {}),
    },
    variant,
  };
}

export function rebindOpenAIModelVariant(
  applied: AppliedOpenAIModelVariant,
  physicalModel: string,
): AppliedOpenAIModelVariant {
  const variant = rebindModelVariant(applied.variant, physicalModel);
  if (!variant) {
    return applied;
  }

  return {
    request: {
      ...applied.request,
      model: variant.model,
      ...applyOpenAIOutputLimit(applied.request, variant.maxOutputTokens),
      thinking:
        applied.request.thinking?.type === 'disabled'
          ? { type: 'disabled' }
          : variant.thinkingBudget === 0
            ? undefined
            : {
                type: 'enabled',
                budget_tokens: variant.thinkingBudget,
              },
      tools: variant.supportsTools ? applied.request.tools : undefined,
      tool_choice: variant.supportsTools ? applied.request.tool_choice : undefined,
      ...(applied.request.reasoning_effort !== undefined ? { reasoning_effort: variant.tier } : {}),
    },
    variant,
  };
}

function applyOpenAIOutputLimit(
  request: OpenAIChatRequest,
  modelLimit: number,
): Pick<OpenAIChatRequest, 'max_tokens' | 'max_completion_tokens'> {
  const requestedLimit = request.max_completion_tokens ?? request.max_tokens;
  const effectiveLimit =
    requestedLimit === undefined ? modelLimit : Math.min(requestedLimit, modelLimit);
  return {
    max_tokens: effectiveLimit,
    ...(request.max_completion_tokens !== undefined
      ? { max_completion_tokens: effectiveLimit }
      : {}),
  };
}
