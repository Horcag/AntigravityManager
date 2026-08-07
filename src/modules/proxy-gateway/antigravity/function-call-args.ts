import { isPlainObject } from 'lodash-es';

export class InvalidFunctionCallArgumentsError extends Error {
  public constructor() {
    super('Gemini functionCall.args must be a plain JSON object when present');
    this.name = 'InvalidFunctionCallArgumentsError';
  }
}

/** Omitted arguments mean an empty object; malformed present arguments are provider errors. */
export function normalizeFunctionCallArgs(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new InvalidFunctionCallArgumentsError();
  }

  const functionCall = value as Record<string, unknown>;
  if (!Object.hasOwn(functionCall, 'args')) {
    return {};
  }
  if (!isPlainObject(functionCall.args)) {
    throw new InvalidFunctionCallArgumentsError();
  }
  return functionCall.args as Record<string, unknown>;
}
