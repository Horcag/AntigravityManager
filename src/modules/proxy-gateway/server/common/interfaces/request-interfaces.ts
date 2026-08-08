import type { GeminiToolDeclaration, SafetySetting } from '../../../antigravity/types';

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  n?: number;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  size?: string;
  quality?: string;
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function?: { name: string } };
  parallel_tool_calls?: boolean;
  thinking?: OpenAIThinkingConfig;
  reasoning_effort?: string;
  response_format?: OpenAIResponseFormat;
  logprobs?: boolean;
  top_logprobs?: number;
  logit_bias?: Record<string, number>;
  store?: boolean;
  metadata?: Record<string, string>;
  user?: string;
  service_tier?: string;
  extra?: Record<string, unknown>;
}

export interface OpenAIResponseFormat {
  type?: string;
  json_schema?: {
    name?: string;
    description?: string;
    schema?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface OpenAICompletionRequest {
  model?: string;
  prompt?: string | string[] | number[] | number[][];
  best_of?: number;
  echo?: boolean;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  logprobs?: number | null;
  max_tokens?: number;
  n?: number;
  presence_penalty?: number;
  seed?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  suffix?: string | null;
  temperature?: number;
  top_p?: number;
  user?: string;
}

export interface OpenAIThinkingConfig {
  type?: string;
  budget_tokens?: number;
  effort?: string;
}

export interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  refusal?: string;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface OpenAITool {
  type: string;
  name?: string;
  tools?: OpenAITool[];
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function' | 'apply_patch_call' | string;
  function?: {
    name: string;
    arguments: string;
  };
  status?: string;
  call_id?: string;
  operation?: {
    type: string;
    diff: string;
    path: string;
  };
  /**
   * Preserves Responses custom tool payloads such as apply_patch without
   * forcing format-sensitive input through the normal JSON arguments path.
   */
  custom_input?: string;
  namespace?: string;
}

export interface AnthropicChatRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  max_tokens?: number;
  tools?: AnthropicTool[];
  thinking?: AnthropicThinkingConfig;
  output_config?: AnthropicOutputConfig;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tool_choice?: string | AnthropicToolChoice;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
}

/**
 * `POST /v1/messages/count_tokens` body. Mirrors the hosted Anthropic contract, which omits the
 * generation-only fields (`max_tokens`, `stream`, sampling parameters).
 */
export interface AnthropicCountTokensRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  tools?: AnthropicTool[];
  tool_choice?: string | AnthropicToolChoice;
  thinking?: AnthropicThinkingConfig;
}

export interface AnthropicCountTokensResponse {
  input_tokens: number;
}

export interface AnthropicOutputConfig {
  effort?: string;
  format?: unknown;
}

export interface AnthropicToolChoice {
  type: string;
  name?: string;
  function?: { name: string };
  disable_parallel_tool_use?: boolean;
}

export interface AnthropicCacheControl {
  type: string;
  ttl?: number | '5m' | '1h';
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
  cache_control?: AnthropicCacheControl;
  strict?: boolean;
  defer_loading?: boolean;
}

export interface AnthropicThinkingConfig {
  type: 'enabled' | string;
  budget_tokens?: number;
  display?: string;
  effort?: string;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContent[];
}

export interface AnthropicSystemBlock {
  type: string;
  text: string;
  cache_control?: AnthropicCacheControl;
}

export type AnthropicContent =
  | { type: 'text'; text: string; cache_control?: AnthropicCacheControl }
  | {
      type: 'thinking';
      thinking: string;
      signature?: string;
      cache_control?: AnthropicCacheControl;
    }
  | { type: 'image'; source: AnthropicImageSource }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      signature?: string;
      cache_control?: AnthropicCacheControl;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content?: string | AnthropicContent[];
      is_error?: boolean;
      cache_control?: AnthropicCacheControl;
    }
  | { type: 'redacted_thinking'; data: string };

export interface AnthropicImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface GeminiContent {
  role: string;
  parts: GeminiPart[];
  [key: string]: unknown;
}

export interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
  thoughtSignature?: string;
  thought_signature?: string;
  [key: string]: unknown;
}

export interface GeminiInlineData {
  mimeType: string;
  data: string;
  [key: string]: unknown;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: GeminiGenerationConfig;
  tools?: GeminiToolDeclaration[];
  toolConfig?: Record<string, unknown>;
  safetySettings?: SafetySetting[];
  cachedContent?: string;
  [key: string]: unknown;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  [key: string]: unknown;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  [key: string]: unknown;
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
  [key: string]: unknown;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cached_tokens?: number;
  total_thought_tokens?: number;
  totalThoughtTokens?: number;
  total_tokens?: number;
  total_tool_use_tokens?: number;
  cachedTokens?: number;
  promptTokensDetails?: Array<{
    modality?: string;
    tokenCount?: number;
  }>;
  candidatesTokensDetails?: Array<{
    modality?: string;
    tokenCount?: number;
  }>;
  trafficType?: string;
  [key: string]: unknown;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
  service_tier?: string;
}

export interface OpenAIChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
    reasoning_content?: string;
    refusal?: string;
  };
  logprobs?: OpenAIChatLogprobs | null;
  finish_reason: string | null;
}

export interface OpenAIChatLogprobs {
  content: Array<{
    token: string;
    logprob: number;
    bytes: number[] | null;
    top_logprobs: Array<{
      token: string;
      logprob: number;
      bytes: number[] | null;
    }>;
  }>;
}

export interface AnthropicChatResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: AnthropicContent[];
  stop_reason: string | null;
  stop_sequence?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}
