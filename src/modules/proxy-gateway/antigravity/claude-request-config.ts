import { isGeminiImageModel } from './claude-request-model-traits';
import { detectsNetworkingTool } from './claude-request-tools';
import type { ClaudeRequest, ImageConfig, Tool } from './types';

export type RequestType = 'agent' | 'web_search' | 'image_gen';

/**
 * Request Configuration
 * Contains request type, model, and image generation configuration
 */
export interface ResolvedRequestConfig {
  /** Request type: 'agent', 'web_search', 'image_gen' */
  requestType: RequestType;
  /** Whether to inject Google Search tool */
  injectGoogleSearch: boolean;
  /** Final model name to use */
  finalModel: string;
  /** Image generation config (only for image generation requests) */
  imageConfig: ImageConfig | null;
}

/**
 * Resolves request configuration
 * Determines request type and whether to inject search tools based on model name and tools
 */
export function resolveRequestConfig(
  originalModel: string,
  mappedModel: string,
  tools?: Tool[],
  metadata?: ClaudeRequest['metadata'],
): ResolvedRequestConfig {
  // 1. Image Generation Check
  if (isGeminiImageModel(mappedModel)) {
    const imageConfig = parseImageConfig(originalModel, metadata);
    return {
      requestType: 'image_gen',
      injectGoogleSearch: false,
      finalModel: mappedModel,
      imageConfig,
    };
  }

  const hasNetworkingTool = detectsNetworkingTool(tools);

  const enableNetworking = hasNetworkingTool;

  return {
    requestType: enableNetworking ? 'web_search' : 'agent',
    injectGoogleSearch: enableNetworking,
    finalModel: mappedModel,
    imageConfig: null,
  };
}

/**
 * Parses image generation configuration
 * Extracts aspect ratio and resolution settings from model name
 */
function parseImageConfig(modelName: string, metadata?: ClaudeRequest['metadata']): ImageConfig {
  let aspectRatio = '1:1';
  if (modelName.includes('-16x9')) aspectRatio = '16:9';
  else if (modelName.includes('-9x16')) aspectRatio = '9:16';
  else if (modelName.includes('-21x9')) aspectRatio = '21:9';
  else if (modelName.includes('-3x2')) aspectRatio = '3:2';
  else if (modelName.includes('-2x3')) aspectRatio = '2:3';
  else if (modelName.includes('-4x3')) aspectRatio = '4:3';
  else if (modelName.includes('-3x4')) aspectRatio = '3:4';
  else if (modelName.includes('-1x1')) aspectRatio = '1:1';

  const metadataAspectRatio = metadata?.image_aspect_ratio;
  if (
    typeof metadataAspectRatio === 'string' &&
    ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(metadataAspectRatio)
  ) {
    aspectRatio = metadataAspectRatio;
  }

  const metadataImageSize = metadata?.image_size;
  const imageSize = ['1K', '2K', '4K'].includes(String(metadataImageSize))
    ? String(metadataImageSize)
    : modelName.includes('-4k') || modelName.includes('-hd')
      ? '4K'
      : undefined;

  const config: ImageConfig = { aspectRatio };
  if (imageSize) {
    config.imageSize = imageSize;
  }

  return config;
}
