import { Controller, Delete, Get, HttpStatus, Inject, Param, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ProxyGuard } from '../../../guards/proxy.guard';
import { buildResponseNotFoundError } from './openai-responses-request-contract';
import { OpenAIResponsesSessionService } from './openai-responses-session.service';

/**
 * Read and delete access to stored Responses, over the same durable store the
 * `previous_response_id` chain resolves against.
 *
 * A response created with `store: false` was never written, so it is reported
 * as not found here too rather than as an empty success.
 */
@Controller('v1/responses')
@UseGuards(ProxyGuard)
export class OpenAIResponsesStoreController {
  public constructor(
    @Inject(OpenAIResponsesSessionService)
    private readonly sessionStore: OpenAIResponsesSessionService,
  ) {}

  @Get(':responseId')
  public getResponse(@Param('responseId') responseId: string, @Res() res: FastifyReply): void {
    const stored = this.sessionStore.get(responseId)?.response;
    if (!stored) {
      res.status(HttpStatus.NOT_FOUND).send(buildResponseNotFoundError(responseId, 'id'));
      return;
    }

    res.status(HttpStatus.OK).send(stored);
  }

  @Delete(':responseId')
  public deleteResponse(@Param('responseId') responseId: string, @Res() res: FastifyReply): void {
    if (!this.sessionStore.get(responseId)) {
      res.status(HttpStatus.NOT_FOUND).send(buildResponseNotFoundError(responseId, 'id'));
      return;
    }

    this.sessionStore.delete(responseId);
    res.status(HttpStatus.OK).send({
      id: responseId,
      object: 'response',
      deleted: true,
    });
  }
}
