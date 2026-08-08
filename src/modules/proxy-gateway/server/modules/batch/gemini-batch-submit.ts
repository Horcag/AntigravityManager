import { HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { BatchRunnerService } from './batch-runner.service';
import {
  geminiBatchErrorResponse,
  parseGeminiBatchRequests,
  readGeminiBatchDisplayName,
  toGeminiOperation,
} from './gemini-batch-resource';

/**
 * Serves `POST /v1beta/models/{model}:batchGenerateContent`.
 *
 * It lives here rather than in the Gemini controller so that controller stays a
 * router: it recognises the action and hands over. The answer is a long-running
 * operation the client polls at `/v1beta/operations/{name}`.
 *
 * Without a runner wired in, the route keeps its previous behaviour and reports
 * `501 UNIMPLEMENTED`, so a build without the batch module is not silently
 * broken.
 */
export async function respondGeminiBatchGenerateContent(
  runner: BatchRunnerService | undefined,
  model: string,
  body: unknown,
  res: FastifyReply,
): Promise<void> {
  if (!runner) {
    res.status(HttpStatus.NOT_IMPLEMENTED).send({
      error: {
        code: HttpStatus.NOT_IMPLEMENTED,
        message: 'batchGenerateContent is not implemented by this provider',
        status: 'UNIMPLEMENTED',
      },
    });
    return;
  }

  try {
    const requests = parseGeminiBatchRequests(body);
    const displayName = readGeminiBatchDisplayName(body);
    const job = runner.create({
      dialect: 'gemini',
      endpoint: `${model}:batchGenerateContent`,
      requests: requests.map((request) => ({ ...request, target: model })),
      ...(displayName ? { displayName } : {}),
    });
    res.status(HttpStatus.OK).send(toGeminiOperation(job));
  } catch (error) {
    const { statusCode, body: envelope } = geminiBatchErrorResponse(error);
    res.status(statusCode).send(envelope);
  }
}
