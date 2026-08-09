import type { Type } from '@nestjs/common';

import { V1InternalPassthroughController } from './v1internal-passthrough.controller';
import { V1InternalPassthroughService } from './v1internal-passthrough.service';

const V1INTERNAL_PASSTHROUGH_ENABLED = process.env.AGM_V1INTERNAL_PASSTHROUGH === '1';

/**
 * Read exactly once while Nest assembles its controller graph. A disabled diagnostic has no route
 * to guard because its controller is never registered.
 */
export function getV1InternalPassthroughControllers(): Type<unknown>[] {
  return V1INTERNAL_PASSTHROUGH_ENABLED ? [V1InternalPassthroughController] : [];
}

export { V1InternalPassthroughService };
