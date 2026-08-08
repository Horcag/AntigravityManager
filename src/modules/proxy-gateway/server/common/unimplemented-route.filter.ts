import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import {
  buildUnimplementedRouteBody,
  describeUnimplementedRoute,
  resolveProxySurface,
} from './unimplemented-route';

/**
 * Answers a request that matched no route with the error envelope of the API
 * surface it was addressed to.
 *
 * Registered as a filter rather than as stub routes: a filter runs only after
 * routing has already failed, so it can never shadow a handler — including the
 * ones added later for `/v1/files`, `/v1beta/files` and `GET /v1/responses/{id}`
 * — and it needs no entry per unserved path.
 */
@Catch(NotFoundException)
export class UnimplementedRouteFilter implements ExceptionFilter {
  catch(exception: NotFoundException, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const path = request.url ?? '';
    const surface = resolveProxySurface(path);

    if (!surface) {
      reply.status(HttpStatus.NOT_FOUND).send(exception.getResponse());
      return;
    }

    const message = describeUnimplementedRoute(request.method ?? 'GET', path);
    const requestId = `req_${uuidv4().replace(/-/gu, '')}`;
    if (surface === 'anthropic') {
      reply.header('request-id', requestId);
    }
    reply
      .status(HttpStatus.NOT_FOUND)
      .send(buildUnimplementedRouteBody(surface, message, HttpStatus.NOT_FOUND, requestId));
  }
}
