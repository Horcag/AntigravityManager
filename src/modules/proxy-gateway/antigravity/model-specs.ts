const modelSpecs = {
  models: {
    'gemini-3.5-flash-high': {
      max_output_tokens: 65536,
      thinking_budget: 10000,
      is_thinking: true,
    },
    'gemini-3.5-flash-medium': {
      max_output_tokens: 65536,
      thinking_budget: 4000,
      is_thinking: true,
    },
    'gemini-3.5-flash-low': {
      max_output_tokens: 65536,
      thinking_budget: 1000,
      is_thinking: true,
    },
    'gemini-3.5-flash-extra-low': {
      max_output_tokens: 65536,
      thinking_budget: 1000,
      is_thinking: true,
    },
    'gemini-3-flash': {
      max_output_tokens: 65536,
      thinking_budget: 32768,
      is_thinking: true,
    },
    'gemini-3.1-pro-low': {
      max_output_tokens: 65536,
      thinking_budget: 32768,
      is_thinking: true,
    },
    'gemini-3.1-pro-high': {
      max_output_tokens: 65536,
      thinking_budget: 49152,
      is_thinking: true,
    },
    'gemini-3-pro-image': {
      max_output_tokens: 65536,
      thinking_budget: 24576,
      is_thinking: true,
    },
    'claude-sonnet-4-6-thinking': {
      max_output_tokens: 64000,
      thinking_budget: 32768,
      is_thinking: true,
    },
    'claude-opus-4-6-thinking': {
      max_output_tokens: 64000,
      thinking_budget: 32768,
      is_thinking: true,
    },
    'gpt-oss-120b-medium': {
      max_output_tokens: 32768,
      thinking_budget: 0,
      is_thinking: false,
    },
  },
  aliases: {},
} as const;

export default modelSpecs;
