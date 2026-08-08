import { randomBytes } from 'node:crypto';

import { Body, Controller, HttpStatus, Inject, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../guards/proxy.guard';
import { ProxyService } from '../../proxy.service';
import { normalizeAnthropicMessagesRequest } from './anthropic-request-contract';
import {
  AnthropicCompleteValidationError,
  anthropicCompleteErrorResponse,
  normalizeAnthropicCompleteRequest,
  toAnthropicCompletionResponse,
  toAnthropicMessagesRequest,
} from './anthropic-text-completion';

/**
 * Anthropic's deprecated Text Completions endpoint.
 *
 * Small and entirely derived: the prompt is parsed back into Messages turns and
 * run down the Messages path, then rendered back into the old response shape.
 * It is a separate thin controller rather than another method on the already
 * oversized `proxy.controller.ts`.
 *
 * Streaming is refused instead of half-served: the old `completion` event
 * stream is a different wire format from the Messages SSE this proxy produces,
 * and silently returning Messages events to a Text Completions client would be
 * worse than a clear 400.
 */
@Controller('v1/complete')
@UseGuards(ProxyGuard)
export class AnthropicCompleteController {
  constructor(@Inject(ProxyService) private readonly proxyService: ProxyService) {}

  @Post()
  async complete(@Body() body: unknown, @Res() res: FastifyReply): Promise<void> {
    const requestId = `req_${randomBytes(12).toString('hex')}`;
    try {
      const request = normalizeAnthropicCompleteRequest(body);
      if (request.stream) {
        throw new AnthropicCompleteValidationError(
          'stream is not supported on the deprecated /v1/complete endpoint; use /v1/messages for streaming',
        );
      }
      const messagesRequest = normalizeAnthropicMessagesRequest(
        toAnthropicMessagesRequest(request),
      );
      const message = await this.proxyService.handleAnthropicMessages(messagesRequest);
      res
        .header('request-id', requestId)
        .status(HttpStatus.OK)
        .send(
          toAnthropicCompletionResponse(
            message,
            request.model,
            `compl_${requestId.slice('req_'.length)}`,
          ),
        );
    } catch (error) {
      const { statusCode, body: envelope } = anthropicCompleteErrorResponse(error, requestId);
      res.header('request-id', requestId).status(statusCode).send(envelope);
    }
  }
}
