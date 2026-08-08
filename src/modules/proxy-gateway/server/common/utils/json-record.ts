import { isPlainObject, isString } from 'lodash-es';

/**
 * Narrowing helpers for the untyped JSON the proxy surfaces accept.
 *
 * Request bodies arrive as `unknown` and are read field by field before any
 * contract has validated them, so these two guards are used at nearly every
 * such read.
 */
export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return isString(value) ? value : null;
}
