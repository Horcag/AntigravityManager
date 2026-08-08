import {
  Body,
  Controller,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isString } from 'lodash-es';
import { ProxyService } from '../../../proxy.service';
import { ProxyGuard } from '../../../guards/proxy.guard';
import { AccountLeaseService } from '../../account-lease/account-lease.service';
import { ModelRoutingService } from '../../shared/services/model-routing.service';
import { buildModelRouteResponseHeaders } from '../../../common/model-route-response-headers';
import { sendOpenAIErrorResponse } from '../../../common/proxy-error-responses';
import { applyResponseHeaders, writeSseResponse } from '../../../common/sse-response-writer';
import { inheritUpstreamBackpressure } from '../../../common/stream-backpressure';
import type {
  GeminiRequest,
  OpenAIChatRequest,
  OpenAIContentPart,
} from '../../../common/interfaces/request-interfaces';
import { parseAudioMultipartRequest } from './audio-multipart-request';
import {
  IMAGE_GENERATION_ROLE,
  resolveImageGenerationModel,
  type ImageModelResolution,
} from './image-model-resolution';
import { type ImageMonitoringRequest, summarizeImageRequest } from './image-monitoring-summary';
import { parseImageMultipartRequest } from './image-multipart-request';
import {
  getGeminiImageRequestMetadata,
  normalizeImageEditJsonRequest,
  normalizeImageGenerationRequest,
} from './image-request-contract';
import {
  logImageMonitoringSummary,
  sendOpenAIImageGenerationResponse,
  type ImageEndpointPath,
} from './openai-image-response';
import { collectImageContentParts } from './openai-inline-image-payload';
import {
  OpenAIMediaRequestError,
  normalizeMultipartMediaError,
} from './openai-media-request-contract';
import { mapGeminiAudioTranscriptionStream } from './openai-media-streaming';

export const IMAGE_QUOTA_REFRESH = Symbol('IMAGE_QUOTA_REFRESH');
export type ImageQuotaRefresh = () => Promise<void>;

/**
 * The OpenAI media surface: image generation, image edits and audio
 * transcription.
 *
 * These endpoints share the image-quota refresh hook and the inline-media
 * payload handling, and none of them is reachable from the chat/messages paths,
 * so they live beside the media contracts they use rather than in the shared
 * proxy controller.
 */
@Controller('v1')
@UseGuards(ProxyGuard)
export class OpenAIMediaController {
  private readonly logger = new Logger(OpenAIMediaController.name);

  constructor(
    @Inject(ProxyService) private readonly proxyService: ProxyService,
    @Optional()
    @Inject(AccountLeaseService)
    private readonly accountLeaseService?: AccountLeaseService,
    @Optional()
    @Inject(IMAGE_QUOTA_REFRESH)
    private readonly imageQuotaRefresh?: ImageQuotaRefresh,
    @Optional()
    @Inject(ModelRoutingService)
    private readonly modelRoutingService?: ModelRoutingService,
  ) {}

  @Post('images/generations')
  async imageGenerations(
    @Body()
    rawBody: ImageMonitoringRequest,
    @Res() res: FastifyReply,
  ) {
    const path = '/v1/images/generations';
    try {
      const body = normalizeImageGenerationRequest(rawBody);
      this.logImageMonitoringSummary('request', summarizeImageRequest(path, body));
      const resolution = this.resolveImageModel(body.model);
      const request: OpenAIChatRequest = {
        model: resolution.model,
        messages: [
          {
            role: 'user',
            content: body.prompt ?? '',
          },
        ],
        stream: body.stream,
        size: body.size,
        quality: body.quality,
        extra: getGeminiImageRequestMetadata(body),
      };

      await this.sendOpenAIImageGenerationResponse(
        request,
        body.prompt ?? '',
        path,
        body,
        res,
        resolution,
      );
    } catch (error) {
      sendOpenAIErrorResponse(this.logger, res, path, error);
    }
  }

  @Post('images/edits')
  async imageEdits(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const path = '/v1/images/edits';
    let body: ImageMonitoringRequest;
    try {
      body = this.hasMultipartBoundary(req)
        ? await parseImageMultipartRequest(req)
        : normalizeImageEditJsonRequest(req.body);
    } catch (error) {
      sendOpenAIErrorResponse(this.logger, res, path, normalizeMultipartMediaError(error));
      return;
    }
    this.logImageMonitoringSummary('request', summarizeImageRequest(path, body));

    const imageParts = [
      ...collectImageContentParts([body.image], 'image/png'),
      ...collectImageContentParts(body.reference_images ?? [], 'image/jpeg'),
    ];
    const maskParts = collectImageContentParts([body.mask], 'image/png');
    const content: OpenAIContentPart[] = [
      {
        type: 'text',
        text: body.prompt ?? 'Please edit the provided image.',
      },
      ...imageParts,
      ...(maskParts.length > 0
        ? [
            {
              type: 'text' as const,
              text: 'Use the following image as the edit mask.',
            },
            ...maskParts,
          ]
        : []),
    ];

    let resolution: ImageModelResolution;
    try {
      resolution = this.resolveImageModel(body.model);
    } catch (error) {
      sendOpenAIErrorResponse(this.logger, res, path, error);
      return;
    }

    const request: OpenAIChatRequest = {
      model: resolution.model,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
      stream: body.stream,
      size: body.size,
      quality: body.quality,
      extra: getGeminiImageRequestMetadata(body),
    };

    await this.sendOpenAIImageGenerationResponse(
      request,
      body.prompt ?? '',
      path,
      body,
      res,
      resolution,
    );
  }

  @Post('audio/transcriptions')
  async audioTranscriptions(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const path = '/v1/audio/transcriptions';
    if (!this.hasMultipartBoundary(req)) {
      sendOpenAIErrorResponse(
        this.logger,
        res,
        path,
        new OpenAIMediaRequestError(
          'Expected a multipart/form-data request with a valid boundary',
          'content-type',
        ),
      );
      return;
    }

    let body;
    try {
      body = await parseAudioMultipartRequest(req);
    } catch (error) {
      sendOpenAIErrorResponse(this.logger, res, path, normalizeMultipartMediaError(error));
      return;
    }

    const instruction = [
      body.prompt ?? 'Transcribe the provided speech audio accurately.',
      body.language ? `The expected language is ${body.language}.` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n');
    const request: GeminiRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: instruction },
            {
              inlineData: {
                data: body.file.data,
                mimeType: body.file.mimeType,
              },
            },
          ],
        },
      ],
      generationConfig:
        body.temperature === undefined ? undefined : { temperature: body.temperature },
    };

    try {
      if (body.stream) {
        const upstreamStream = await this.proxyService.handleGeminiStreamGenerateContent(
          body.model,
          request,
        );
        writeSseResponse(
          res,
          inheritUpstreamBackpressure(
            upstreamStream,
            mapGeminiAudioTranscriptionStream(upstreamStream),
          ),
          'openai',
          this.getModelRouteResponseHeaders(upstreamStream, body.model),
        );
        return;
      }

      const result = await this.proxyService.handleGeminiGenerateContent(body.model, request);
      applyResponseHeaders(res, this.getModelRouteResponseHeaders(result, body.model));
      const transcript =
        result.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? '')
          .join('')
          .trim() ?? '';

      if (body.response_format === 'text') {
        res.header('Content-Type', 'text/plain; charset=utf-8');
        res.status(HttpStatus.OK).send(transcript);
      } else {
        res.status(HttpStatus.OK).send({ text: transcript });
      }
    } catch (error) {
      sendOpenAIErrorResponse(this.logger, res, path, error);
    }
  }

  /**
   * Resolves the image model from the provider's `image_generation` role array
   * when the caller named none, so the endpoint stops depending on the caller
   * guessing an image-capable id.
   */
  private resolveImageModel(requestedModel: string | undefined): ImageModelResolution {
    return resolveImageGenerationModel(
      requestedModel,
      this.accountLeaseService?.getModelIdsForRole?.(IMAGE_GENERATION_ROLE) ?? [],
    );
  }

  private async sendOpenAIImageGenerationResponse(
    request: OpenAIChatRequest,
    prompt: string,
    path: ImageEndpointPath,
    body: ImageMonitoringRequest,
    res: FastifyReply,
    resolution: ImageModelResolution,
  ): Promise<void> {
    await sendOpenAIImageGenerationResponse(
      {
        proxyService: this.proxyService,
        logger: this.logger,
        scheduleQuotaRefresh: () => this.scheduleImageQuotaRefresh(),
      },
      request,
      prompt,
      path,
      body,
      res,
      resolution,
    );
  }

  private getModelRouteResponseHeaders(
    result: unknown,
    requestedModel: string | undefined,
  ): Record<string, string> {
    return buildModelRouteResponseHeaders(result, requestedModel, this.modelRoutingService);
  }

  private hasMultipartBoundary(req: FastifyRequest): boolean {
    const contentType = req.headers['content-type'];
    if (!isString(contentType)) {
      return false;
    }

    const lowered = contentType.toLowerCase();
    return lowered.includes('multipart/form-data') && lowered.includes('boundary=');
  }

  private logImageMonitoringSummary(direction: 'request' | 'response', summary: unknown): void {
    logImageMonitoringSummary(this.logger, direction, summary);
  }

  /**
   * Image requests can consume quota outside the regular account-lease refresh cadence.
   * Keep this asynchronous so a successful image response is never delayed by monitoring I/O.
   */
  private scheduleImageQuotaRefresh(): void {
    if (!this.imageQuotaRefresh) {
      return;
    }

    this.imageQuotaRefresh().catch((error: unknown) => {
      this.logger.warn('Failed to refresh quotas after image generation', error);
    });
  }
}
