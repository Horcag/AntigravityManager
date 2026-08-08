import { getMaxOutputTokens, getThinkingBudget } from './ModelSpecs';
import { isClaudeModel, isGeminiFlashModel } from './claude-request-model-traits';
import type { ClaudeRequest, GenerationConfig } from './types';

function resolveAdaptiveThinkingLevel(claudeReq: ClaudeRequest): 'low' | 'medium' | 'high' {
  const effort = String(claudeReq.thinking?.effort ?? '').toLowerCase();
  if (effort === 'low') {
    return 'low';
  }
  if (effort === 'medium') {
    return 'medium';
  }
  return 'high';
}

/**
 * build generation config
 * convert claude request parameters to gemini generation config
 */
export function buildGenerationConfig(
  claudeReq: ClaudeRequest,
  hasWebSearch: boolean,
  mappedModel: string,
  isThinkingEnabled: boolean,
): GenerationConfig {
  const source = String(claudeReq.metadata?.source || '').toLowerCase();
  const isOpenAIPath = source === 'openai';
  const config: GenerationConfig = {};
  const thinkingType = String(claudeReq.thinking?.type ?? '').toLowerCase();

  const buildThinkingConfig = (): GenerationConfig['thinkingConfig'] => {
    const thinkingConfig: GenerationConfig['thinkingConfig'] = { includeThoughts: true };
    if (thinkingType === 'adaptive') {
      if (isClaudeModel(mappedModel)) {
        thinkingConfig.thinkingLevel = resolveAdaptiveThinkingLevel(claudeReq);
      } else {
        thinkingConfig.thinkingBudget = 24576;
      }
    } else if (claudeReq.thinking?.budget_tokens) {
      let budget = claudeReq.thinking.budget_tokens;
      const isFlash = hasWebSearch || isGeminiFlashModel(mappedModel);
      if (isFlash) {
        budget = Math.min(budget, 24576);
      }
      thinkingConfig.thinkingBudget = budget;
    } else {
      thinkingConfig.thinkingBudget = getThinkingBudget(mappedModel);
    }
    return thinkingConfig;
  };

  if (isOpenAIPath) {
    config.temperature = claudeReq.temperature ?? 1.0;
    config.topP = claudeReq.top_p ?? 1.0;
    config.presencePenalty = claudeReq.presence_penalty;
    config.frequencyPenalty = claudeReq.frequency_penalty;
    config.seed = claudeReq.seed;
    if (claudeReq.max_tokens !== undefined) {
      config.maxOutputTokens = claudeReq.max_tokens;
    } else {
      config.maxOutputTokens = getMaxOutputTokens(mappedModel);
    }
    if (claudeReq.stop_sequences && claudeReq.stop_sequences.length > 0) {
      config.stopSequences = claudeReq.stop_sequences;
    }
    if (claudeReq.candidate_count !== undefined) {
      config.candidateCount = claudeReq.candidate_count;
    }
    if (
      claudeReq.response_format?.type === 'json_object' ||
      claudeReq.response_format?.type === 'json_schema'
    ) {
      config.responseMimeType = 'application/json';
      const responseSchema = claudeReq.response_format.json_schema?.schema;
      if (responseSchema) {
        config.responseSchema = responseSchema;
      }
    }
    if (claudeReq.response_logprobs) {
      config.responseLogprobs = true;
      if ((claudeReq.top_logprobs ?? 0) > 0) {
        config.logprobs = claudeReq.top_logprobs;
      }
    }
    if (isThinkingEnabled) {
      config.thinkingConfig = buildThinkingConfig();
    }
    return config;
  }

  if (isThinkingEnabled) {
    config.thinkingConfig = buildThinkingConfig();
  }
  if (claudeReq.temperature !== undefined) {
    config.temperature = claudeReq.temperature;
  }
  if (claudeReq.top_p !== undefined) {
    config.topP = claudeReq.top_p;
  }
  if (claudeReq.top_k !== undefined) {
    config.topK = claudeReq.top_k;
  }
  if (claudeReq.max_tokens !== undefined) {
    config.maxOutputTokens = claudeReq.max_tokens;
  }
  // `stop_sequences` is deliberately not forwarded on the Anthropic surface: the
  // provider strips the matched sequence and reports the same finish reason as a
  // natural ending, which makes `stop_reason: "stop_sequence"` unreportable. The
  // response mappers cut the text instead. See `stop-sequences.ts`.
  return config;
}
