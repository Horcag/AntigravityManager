export type ModelVariantTier = 'low' | 'medium' | 'high';

export interface ResolveModelVariantInput {
  model: string;
  budgetTokens?: number;
  effort?: string;
}

export interface ResolvedModelVariant {
  canonicalModel: string;
  model: string;
  tier: ModelVariantTier;
  thinkingBudget: number;
  maxOutputTokens: number;
  includeThoughts: boolean;
  preserveClientBudget: boolean;
  supportsTools: boolean;
}

type AliasPolicy = 'tier' | ModelVariantTier;

interface ModelVariantFamily {
  canonicalModel: string;
  variants: Record<ModelVariantTier, Omit<ResolvedModelVariant, 'canonicalModel' | 'tier'>>;
  aliases: Record<string, AliasPolicy>;
  minimumThinkingBudget?: number;
  preserveClientThinkingBudget?: boolean;
}

const CLAUDE_OPUS_4_6_THINKING_BUDGET = 1024;

const CLAUDE_OPUS_4_6_MIN_THINKING_BUDGET = CLAUDE_OPUS_4_6_THINKING_BUDGET;
const CLAUDE_OPUS_4_6_VARIANTS: Record<
  ModelVariantTier,
  Omit<ResolvedModelVariant, 'canonicalModel' | 'tier'>
> = {
  low: {
    model: 'claude-opus-4-6-thinking',
    thinkingBudget: CLAUDE_OPUS_4_6_THINKING_BUDGET,
    maxOutputTokens: 64000,
    includeThoughts: true,
    preserveClientBudget: true,
    supportsTools: true,
  },
  medium: {
    model: 'claude-opus-4-6-thinking',
    thinkingBudget: CLAUDE_OPUS_4_6_THINKING_BUDGET,
    maxOutputTokens: 64000,
    includeThoughts: true,
    preserveClientBudget: true,
    supportsTools: true,
  },
  high: {
    model: 'claude-opus-4-6-thinking',
    thinkingBudget: CLAUDE_OPUS_4_6_THINKING_BUDGET,
    maxOutputTokens: 64000,
    includeThoughts: true,
    preserveClientBudget: true,
    supportsTools: true,
  },
};

const GEMINI_35_FLASH_VARIANTS: Record<
  ModelVariantTier,
  Omit<ResolvedModelVariant, 'canonicalModel' | 'tier'>
> = {
  low: {
    model: 'gemini-3.5-flash-extra-low',
    thinkingBudget: 1000,
    maxOutputTokens: 65536,
    includeThoughts: true,
    preserveClientBudget: false,
    supportsTools: true,
  },
  medium: {
    model: 'gemini-3.5-flash-low',
    thinkingBudget: 4000,
    maxOutputTokens: 65536,
    includeThoughts: true,
    preserveClientBudget: false,
    supportsTools: true,
  },
  high: {
    model: 'gemini-3-flash-agent',
    thinkingBudget: 10000,
    maxOutputTokens: 65536,
    includeThoughts: true,
    preserveClientBudget: false,
    supportsTools: true,
  },
};

const GEMINI_31_PRO_VARIANTS: Record<
  ModelVariantTier,
  Omit<ResolvedModelVariant, 'canonicalModel' | 'tier'>
> = {
  low: {
    model: 'gemini-3.1-pro-low',
    thinkingBudget: 1001,
    maxOutputTokens: 65535,
    includeThoughts: true,
    preserveClientBudget: false,
    supportsTools: true,
  },
  medium: {
    model: 'gemini-pro-agent',
    thinkingBudget: 10001,
    maxOutputTokens: 65535,
    includeThoughts: true,
    preserveClientBudget: false,
    supportsTools: true,
  },
  high: {
    model: 'gemini-pro-agent',
    thinkingBudget: 10001,
    maxOutputTokens: 65535,
    includeThoughts: true,
    preserveClientBudget: false,
    supportsTools: true,
  },
};

const MODEL_VARIANT_FAMILIES: ModelVariantFamily[] = [
  {
    canonicalModel: 'gemini-3.5-flash',
    variants: GEMINI_35_FLASH_VARIANTS,
    aliases: {
      'gemini-3.5-flash-high': 'high',
      'gemini-3.5-flash-medium': 'medium',
      'gemini-3.5-flash-low': 'low',
      'gemini-3-flash': 'tier',
    },
  },
  {
    canonicalModel: 'gemini-3.1-pro',
    variants: GEMINI_31_PRO_VARIANTS,
    aliases: {
      'gemini-3.1-pro-high': 'high',
      'gemini-pro': 'tier',
      'gemini-3.1-pro-low': 'low',
    },
  },
  {
    canonicalModel: 'claude-opus-4-6-thinking',
    variants: CLAUDE_OPUS_4_6_VARIANTS,
    aliases: {
      'claude-opus-4-6-thinking': 'tier',
      'claude-opus-4-6': 'tier',
    },
    minimumThinkingBudget: CLAUDE_OPUS_4_6_MIN_THINKING_BUDGET,
    preserveClientThinkingBudget: true,
  },
];

function inferTier(budgetTokens: number | undefined): ModelVariantTier {
  if (budgetTokens !== undefined && budgetTokens < 2000) {
    return 'low';
  }
  if (budgetTokens !== undefined && budgetTokens < 7000) {
    return 'medium';
  }

  return 'high';
}

function parseEffort(effort: string | undefined): ModelVariantTier | null {
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort;
  }

  return null;
}

function resolveNonVariantModel(
  model: string,
  tier: ModelVariantTier,
): ResolvedModelVariant | null {
  if (model === 'gpt-oss-120b-medium') {
    return {
      canonicalModel: 'gpt-oss-120b-medium',
      model: 'gpt-oss-120b-medium',
      tier,
      thinkingBudget: 8192,
      maxOutputTokens: 32768,
      includeThoughts: true,
      preserveClientBudget: false,
      supportsTools: true,
    };
  }

  return null;
}

export function getMinimumThinkingBudgetForModel(model: string): number {
  const normalizedModel = model.trim().toLowerCase();
  const family = MODEL_VARIANT_FAMILIES.find(
    (candidate) =>
      candidate.canonicalModel === normalizedModel ||
      Object.prototype.hasOwnProperty.call(candidate.aliases, normalizedModel),
  );

  return family?.minimumThinkingBudget ?? 0;
}

export function resolveModelVariant(input: ResolveModelVariantInput): ResolvedModelVariant | null {
  const model = input.model.trim().toLowerCase();
  const requestedTier = parseEffort(input.effort) ?? inferTier(input.budgetTokens);
  const family = MODEL_VARIANT_FAMILIES.find(
    (candidate) =>
      candidate.canonicalModel === model ||
      Object.prototype.hasOwnProperty.call(candidate.aliases, model),
  );
  if (!family) {
    return resolveNonVariantModel(model, requestedTier);
  }

  const aliasPolicy = family.aliases[model];
  const tier = aliasPolicy && aliasPolicy !== 'tier' ? aliasPolicy : requestedTier;
  return {
    canonicalModel: family.canonicalModel,
    tier,
    ...family.variants[tier],
    thinkingBudget:
      family.preserveClientThinkingBudget && input.budgetTokens !== undefined
        ? input.budgetTokens
        : family.variants[tier].thinkingBudget,
  };
}

export function rebindModelVariant(
  variant: ResolvedModelVariant | null,
  physicalModel: string,
): ResolvedModelVariant | null {
  if (!variant) {
    return null;
  }

  const normalizedPhysicalModel = physicalModel.trim().toLowerCase();
  if (normalizedPhysicalModel === variant.model) {
    return variant;
  }

  const family = MODEL_VARIANT_FAMILIES.find(
    (candidate) => candidate.canonicalModel === variant.canonicalModel,
  );
  if (!family) {
    return null;
  }

  const matchedTier = (['high', 'medium', 'low'] as const).find(
    (tier) => family.variants[tier].model === normalizedPhysicalModel,
  );
  if (!matchedTier) {
    return null;
  }

  return {
    canonicalModel: family.canonicalModel,
    tier: matchedTier,
    ...family.variants[matchedTier],
  };
}
