import { HttpStatus, type Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { isString } from 'lodash-es';
import { of, tap } from 'rxjs';
import type { ProxyService } from '../../../proxy.service';
import {
  createModelRouteHeaders,
  getModelRouteMetadata,
} from '../../../common/model-route-metadata';
import {
  logProxyEndpointError,
  sendOpenAIErrorResponse,
} from '../../../common/proxy-error-responses';
import {
  applyResponseHeaders,
  isObservableLike,
  writeSseResponse,
} from '../../../common/sse-response-writer';
import { inheritUpstreamBackpressure } from '../../../common/stream-backpressure';
import { UpstreamRequestError } from '../../../common/exceptions/upstream-request-exception';
import { safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';
import type { OpenAIChatRequest } from '../../../common/interfaces/request-interfaces';
import {
  buildGeminiImageRequest,
  isProjectContextErrorMessage,
} from './gemini-image-fallback-request';
import { createImageRouteMetadata, type ImageModelResolution } from './image-model-resolution';
import {
  type ImageMonitoringRequest,
  type OpenAIImageResponse,
  summarizeImageResponse,
} from './image-monitoring-summary';
import {
  extractInlineBase64Image,
  extractInlineBase64ImageFromGeminiResponse,
  resolveImageOutputFormat,
} from './openai-inline-image-payload';
import { mapOpenAIImageStream } from './openai-media-streaming';

export type ImageEndpointPath = '/v1/images/generations' | '/v1/images/edits';

/**
 * What answering an image request needs beyond the request itself: the upstream
 * to call, somewhere to log, and the quota hook to nudge once bytes came back.
 */
export interface ImageResponseContext {
  proxyService: ProxyService;
  logger: Logger;
  scheduleQuotaRefresh: () => void;
}

export function logImageMonitoringSummary(
  logger: Logger,
  direction: 'request' | 'response',
  summary: unknown,
): void {
  logger.log(`[ImageMonitor] ${direction} ${safeStringifyPacket(summary)}`);
}

function getImageRouteResponseHeaders(
  result: unknown,
  resolution: ImageModelResolution,
): Record<string, string> {
  return createModelRouteHeaders(
    createImageRouteMetadata(resolution, getModelRouteMetadata(result)),
  );
}

/**
 * Serves an image request and writes the answer.
 *
 * 1. Ask upstream through the ordinary chat path, streaming when the caller did.
 * 2. Pull the inline image out of the answer — the provider returns it as a
 *    data URI inside message text rather than as its own field.
 * 3. On a missing-project-context failure, retry once through the native Gemini
 *    surface, which does not need the project the OpenAI path resolves.
 */
export async function sendOpenAIImageGenerationResponse(
  context: ImageResponseContext,
  request: OpenAIChatRequest,
  prompt: string,
  path: ImageEndpointPath,
  body: ImageMonitoringRequest,
  res: FastifyReply,
  resolution: ImageModelResolution,
): Promise<void> {
  const { logger, proxyService } = context;
  try {
    const result = await proxyService.handleChatCompletions(request);
    const routeHeaders = getImageRouteResponseHeaders(result, resolution);
    if (isObservableLike(result)) {
      if (body.stream) {
        const stream = inheritUpstreamBackpressure(
          result,
          mapOpenAIImageStream(result, {
            partialImages: body.partial_images ?? 0,
            path,
            quality: body.quality,
            size: body.size,
          }).pipe(
            tap({
              complete: () => context.scheduleQuotaRefresh(),
            }),
          ),
        );
        writeSseResponse(res, stream, 'openai', routeHeaders);
        return;
      }
      logProxyEndpointError(
        logger,
        path,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Upstream unexpectedly returned a stream for a buffered image request',
      );
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
        error: {
          message: 'Upstream unexpectedly returned a stream for a buffered image request',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const content = result.choices?.[0]?.message?.content;
    const image = extractInlineBase64Image(isString(content) ? content : '');
    if (!image) {
      logProxyEndpointError(
        logger,
        path,
        HttpStatus.BAD_GATEWAY,
        'Upstream did not return inline image data',
      );
      res.status(HttpStatus.BAD_GATEWAY).send({
        error: {
          message: 'Upstream did not return inline image data',
          type: 'invalid_response_error',
        },
      });
      return;
    }

    const response: OpenAIImageResponse = {
      created: Math.floor(Date.now() / 1000),
      output_format: resolveImageOutputFormat(image.mimeType),
      data: [
        {
          b64_json: image.data,
        },
      ],
    };
    sendOpenAIImageSuccess(context, response, path, body, res, routeHeaders);
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Internal Server Error';
    let resolvedError = error;

    if (isProjectContextErrorMessage(message)) {
      try {
        const geminiRequest = buildGeminiImageRequest(request, prompt);
        const geminiResult = await proxyService.handleGeminiGenerateContent(
          resolution.model,
          geminiRequest,
        );
        const fallbackImage = extractInlineBase64ImageFromGeminiResponse(geminiResult);
        if (fallbackImage) {
          const response: OpenAIImageResponse = {
            created: Math.floor(Date.now() / 1000),
            output_format: resolveImageOutputFormat(fallbackImage.mimeType),
            data: [
              {
                b64_json: fallbackImage.data,
              },
            ],
          };
          sendOpenAIImageSuccess(
            context,
            response,
            path,
            body,
            res,
            getImageRouteResponseHeaders(geminiResult, resolution),
          );
          return;
        }
        message = 'Upstream did not return inline image data';
        resolvedError = new UpstreamRequestError({
          message,
          status: HttpStatus.BAD_GATEWAY,
        });
      } catch (fallbackError) {
        resolvedError = fallbackError;
        message = fallbackError instanceof Error ? fallbackError.message : message;
      }
    }

    sendOpenAIErrorResponse(logger, res, path, resolvedError, message);
  }
}

function sendOpenAIImageSuccess(
  context: ImageResponseContext,
  response: OpenAIImageResponse,
  path: ImageEndpointPath,
  body: ImageMonitoringRequest,
  res: FastifyReply,
  routeHeaders: Record<string, string> = {},
): void {
  logImageMonitoringSummary(context.logger, 'response', summarizeImageResponse(response));
  context.scheduleQuotaRefresh();
  if (!body.stream) {
    applyResponseHeaders(res, routeHeaders);
    res.status(HttpStatus.OK).send(response);
    return;
  }

  context.logger.warn(
    `${path} upstream stream setup fell back to a buffered result; emitting only the completed image event`,
  );

  const type = path.endsWith('/edits') ? 'image_edit.completed' : 'image_generation.completed';
  const event = {
    type,
    b64_json: response.data[0]?.b64_json ?? '',
    background: 'auto',
    created_at: response.created,
    output_format: response.output_format ?? 'png',
    quality: body.quality ?? 'auto',
    size: body.size ?? 'auto',
  };
  writeSseResponse(
    res,
    of(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`),
    'openai',
    routeHeaders,
  );
}
