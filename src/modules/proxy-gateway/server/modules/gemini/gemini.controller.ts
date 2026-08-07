import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { isFunction, isNil, isObjectLike, isString } from 'lodash-es';
import { Observable } from 'rxjs';

import { ProxyGuard } from '../../guards/proxy.guard';
import { ProxyService } from '../../proxy.service';
import { GeminiRequest, GeminiResponse } from '../../common/interfaces/request-interfaces';
import { getServerConfig } from '../../../../../server/server-config';
import { getAllDynamicModels } from '../../../antigravity/ModelMapping';
import { AccountLeaseService } from '../account-lease/account-lease.service';
import {
  validateGeminiSystemInstruction,
  sanitizeUpstreamError,
} from './gemini-wire';

type GeminiModelMetadata = {
  name: string;
  displayName: string;
  supportedGenerationMethods: string[];
};

@Controller('v1beta')
@UseGuards(ProxyGuard)
export class GeminiController {
  constructor(
    @Inject(ProxyService) private readonly proxyService: ProxyService,
    @Optional()
    @Inject(AccountLeaseService)
    private readonly accountLeaseService?: AccountLeaseService,
  ) {}

  @Get('models')
  listModels(@Res() res: FastifyReply) {
    const models = this.buildGeminiModelList();
    res.status(HttpStatus.OK).send({
      models,
    });
  }

  @Get('models/:model')
  getModel(@Param('model') model: string, @Res() res: FastifyReply) {
    const targetName = model.startsWith('models/') ? model : `models/${model}`;
    const matched = this.buildGeminiModelList().find((item) => item.name === targetName);

    if (matched) {
      res.status(HttpStatus.OK).send(matched);
      return;
    }

    res.status(HttpStatus.NOT_FOUND).send({
      error: {
        code: HttpStatus.NOT_FOUND,
        message: `${targetName} is not found`,
        status: 'NOT_FOUND',
      },
    });
  }

  @Post('models/:modelAction')
  async modelAction(
    @Param('modelAction') modelAction: string,
    @Body() body: GeminiRequest,
    @Res() res: FastifyReply,
  ) {
    const parsed = this.parseModelActionToken(modelAction);
    if (!parsed) {
      res.status(HttpStatus.BAD_REQUEST).send({
        error: {
          code: HttpStatus.BAD_REQUEST,
          message: 'Model action format is invalid',
          status: 'INVALID_ARGUMENT',
        },
      });
      return;
    }

    await this.handleModelActionDispatch(parsed.model, parsed.action, body, res);
  }

  @Post('models/:model/countTokens')
  async countTokens(
    @Param('model') model: string,
    @Body() body: GeminiRequest,
    @Res() res: FastifyReply,
  ) {
    await this.handleModelActionDispatch(`models/${model}`, 'countTokens', body, res);
  }

  private async handleModelActionDispatch(
    model: string,
    action: string,
    body: GeminiRequest,
    res: FastifyReply,
  ): Promise<void> {
    const unsupportedField = this.checkUnsupportedGeminiFields(
      body as unknown as Record<string, unknown>,
    );
    if (unsupportedField) {
      res.status(HttpStatus.NOT_IMPLEMENTED).send({
        error: {
          code: HttpStatus.NOT_IMPLEMENTED,
          message: `Field '${unsupportedField}' is not supported by this provider`,
          status: 'UNIMPLEMENTED',
        },
      });
      return;
    }

    if (
      action === 'countTokens' ||
      action === 'embedContent' ||
      action === 'batchEmbedContents' ||
      action === 'batchGenerateContent'
    ) {
      res.status(HttpStatus.NOT_IMPLEMENTED).send({
        error: {
          code: HttpStatus.NOT_IMPLEMENTED,
          message: `${action} is not implemented by this provider`,
          status: 'UNIMPLEMENTED',
        },
      });
      return;
    }

    if (action === 'generateContent' || action === 'streamGenerateContent') {
      const sysVal = validateGeminiSystemInstruction((body as Record<string, unknown>)?.systemInstruction);
      if (!sysVal.valid) {
        res.status(HttpStatus.BAD_REQUEST).send({
          error: {
            code: HttpStatus.BAD_REQUEST,
            message: sysVal.message || 'Invalid systemInstruction format',
            status: 'INVALID_ARGUMENT',
          },
        });
        return;
      }
    }

    try {
      if (action === 'streamGenerateContent') {
        const stream = await this.proxyService.handleGeminiStreamGenerateContent(model, body);
        if (stream instanceof Observable) {
          this.writeObservableSseResponse(res, stream);
          return;
        }
      }

      if (action === 'generateContent') {
        const result = await this.proxyService.handleGeminiGenerateContent(model, body);
        res.status(HttpStatus.OK).send(result);
        return;
      }

      res.status(HttpStatus.BAD_REQUEST).send({
        error: {
          code: HttpStatus.BAD_REQUEST,
          message: `Unsupported model action: ${action}`,
          status: 'INVALID_ARGUMENT',
        },
      });
    } catch (error) {
      const sanitized = sanitizeUpstreamError(error);
      if (sanitized.retryAfter) {
        res.header('Retry-After', sanitized.retryAfter);
      }
      res.status(sanitized.statusCode).send(sanitized.errorEnvelope);
    }
  }

  private checkUnsupportedGeminiFields(body: Record<string, unknown>): string | null {
    if (!isObjectLike(body)) {
      return null;
    }
    if ('cachedContent' in body && !isNil(body.cachedContent)) {
      return 'cachedContent';
    }
    if ('serviceTier' in body && !isNil(body.serviceTier)) {
      return 'serviceTier';
    }
    if ('store' in body && !isNil(body.store)) {
      return 'store';
    }
    return null;
  }

  private parseModelActionToken(modelAction: string): {
    model: string;
    action: string;
  } | null {
    const colonIndex = modelAction.lastIndexOf(':');
    if (colonIndex <= 0) {
      return null;
    }

    const model = modelAction.slice(0, colonIndex).trim();
    const action = modelAction.slice(colonIndex + 1).trim();
    if (!model || !action) {
      return null;
    }

    const prefixedModel = model.startsWith('models/') ? model : `models/${model}`;
    return {
      model: prefixedModel,
      action,
    };
  }

  private buildGeminiModelList(): GeminiModelMetadata[] {
    const config = getServerConfig();
    const dynamicModelIds = getAllDynamicModels(
      config?.custom_mapping ?? {},
      this.accountLeaseService?.getAllCollectedModels(),
    );

    return dynamicModelIds.map((id) => this.toGeminiModelMetadata(`models/${id}`));
  }

  private toGeminiModelMetadata(modelName: string): GeminiModelMetadata {
    const displayName = modelName.replace(/^models\//, '');
    return {
      name: modelName,
      displayName,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    };
  }

  private writeObservableSseResponse(res: FastifyReply, stream: Observable<unknown>): void {
    if (!res.raw || !isFunction(res.raw.writeHead) || !isFunction(res.raw.write)) {
      res.header('Content-Type', 'text/event-stream');
      res.header('Cache-Control', 'no-cache');
      res.header('Connection', 'keep-alive');
      res.send(stream);
      return;
    }

    if (this.supportsReplyHijack(res)) {
      res.hijack();
    }

    res.raw.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const subscription = stream.subscribe({
      next: (chunk) => {
        if (res.raw.writableEnded) {
          return;
        }
        const payload = isString(chunk) ? chunk : String(chunk ?? '');
        res.raw.write(payload);
      },
      error: (error) => {
        if (res.raw.writableEnded) {
          return;
        }
        const sanitized = sanitizeUpstreamError(error);
        res.raw.write(`data: ${JSON.stringify(sanitized.errorEnvelope)}\n\n`);
        res.raw.end();
      },
      complete: () => {
        if (!res.raw.writableEnded) {
          res.raw.end();
        }
      },
    });

    res.raw.on('close', () => {
      subscription.unsubscribe();
    });
  }

  private supportsReplyHijack(reply: FastifyReply): reply is FastifyReply & { hijack: () => void } {
    return isFunction((reply as { hijack?: unknown }).hijack);
  }
}
