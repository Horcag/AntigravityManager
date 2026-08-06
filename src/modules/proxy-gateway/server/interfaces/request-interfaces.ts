export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  stream_options?: OpenAIStreamOptions;
  stop?: string | string[];
  size?: string;
  quality?: string;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  response_format?: OpenAIResponseFormat;
  n?: number;
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean | number | null;
  top_logprobs?: number;
  user?: string;
  service_tier?: unknown;
  store?: unknown;
  metadata?: unknown;
  modalities?: unknown;
  prediction?: unknown;
  parallel_tool_calls?: unknown;
  extra?: Record<string, unknown>;
}

export interface OpenAIStreamOptions {
  include_usage?: boolean;
}

export interface OpenAIResponseFormat {
  type?: string;
  json_schema?: unknown;
}

/**
 * Legacy `/v1/completions` request. Kept separate from the Chat request because the
 * legacy surface carries options (suffix/echo/best_of) that Chat never had.
 */
export interface OpenAILegacyCompletionRequest {
  model?: string;
  prompt?: string | string[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stream_options?: OpenAIStreamOptions;
  stop?: string | string[];
  n?: number;
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  logprobs?: number | null;
  suffix?: string | null;
  echo?: boolean;
  best_of?: number;
  user?: string;
}

export type OpenAIToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
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
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AnthropicChatRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  max_tokens?: number;
  tools?: AnthropicTool[];
  thinking?: AnthropicThinkingConfig;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
}

export interface AnthropicThinkingConfig {
  type: 'enabled' | string;
  budget_tokens?: number;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContent[];
}

export interface AnthropicSystemBlock {
  type: string;
  text: string;
}

export type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'image'; source: AnthropicImageSource }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      signature?: string;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | AnthropicContent[];
      is_error?: boolean;
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
}

export interface GeminiPart {
  text?: string;
  inlineData?: GeminiInlineData;
  thoughtSignature?: string;
  thought_signature?: string;
}

export interface GeminiInlineData {
  mimeType: string;
  data: string;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: GeminiGenerationConfig;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: Array<{
    modality?: string;
    tokenCount?: number;
  }>;
  candidatesTokensDetails?: Array<{
    modality?: string;
    tokenCount?: number;
  }>;
  trafficType?: string;
}

export interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  /**
   * Omitted when the upstream response carried no usable token counts. A missing key is
   * the only honest way to say "unknown"; zero-filled usage would be a fabricated number.
   */
  usage?: OpenAIUsage;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface OpenAIChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
    reasoning_content?: string;
  };
  /** Required by the Chat contract; always null because this gateway has no logprobs. */
  logprobs: null;
  finish_reason: string | null;
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
