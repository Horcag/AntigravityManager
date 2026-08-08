import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import { ProxyGuard } from '../../guards/proxy.guard';
import { resolveClientDialect, type ClientDialect } from '../../common/client-dialect';
import { AccountLeaseService } from '../account-lease/account-lease.service';
import { getOpenAICompatibleModels } from '../../../antigravity/ModelMapping';
import {
  anthropicModelNotFoundResponse,
  openAIModelNotFoundResponse,
  toAnthropicModelObject,
  toOpenAIModelObject,
} from './client-model-resource';

/**
 * `GET /v1/models/{id}` — retrieve-model, which both the OpenAI and the
 * Anthropic API publish at that exact path, and which clients call to check a
 * model before sending work to it.
 *
 * The dialect is chosen by the shared rule in `common/client-dialect`, the same
 * one `/v1/files` uses (kanban #48), so a request never has to say twice which
 * API it speaks.
 *
 * The set of ids answered here is the set `GET /v1/models` lists — literally
 * the same `getOpenAICompatibleModels` call — so a model the list withholds
 * cannot be retrieved individually either. Anything else 404s in the caller's
 * own error envelope, with no near-match substituted.
 *
 * It lives beside the catalog rather than in `ProxyController` so the shared
 * controller does not grow another route.
 */
@Controller('v1/models')
@UseGuards(ProxyGuard)
export class ClientModelsController {
  constructor(
    @Optional()
    @Inject(AccountLeaseService)
    private readonly accountLeaseService?: AccountLeaseService,
  ) {}

  @Get(':id')
  retrieve(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() res: FastifyReply,
  ): void {
    const dialect = resolveClientDialect(request);
    const published = this.publishedModelIds();
    const matched = published.find((modelId) => modelId === id);

    if (!matched) {
      this.sendNotFound(dialect, res, id);
      return;
    }

    res
      .status(HttpStatus.OK)
      .send(dialect === 'openai' ? toOpenAIModelObject(matched) : toAnthropicModelObject(matched));
  }

  private publishedModelIds(): string[] {
    return getOpenAICompatibleModels(
      {},
      this.accountLeaseService?.getAllCollectedModels(),
      this.accountLeaseService?.getCatalogModelRoleIndex(),
    );
  }

  private sendNotFound(dialect: ClientDialect, res: FastifyReply, id: string): void {
    if (dialect === 'anthropic') {
      const requestId = `req_${uuidv4().replace(/-/gu, '')}`;
      res
        .header('request-id', requestId)
        .status(HttpStatus.NOT_FOUND)
        .send(anthropicModelNotFoundResponse(id, requestId));
      return;
    }

    res.status(HttpStatus.NOT_FOUND).send(openAIModelNotFoundResponse(id));
  }
}
