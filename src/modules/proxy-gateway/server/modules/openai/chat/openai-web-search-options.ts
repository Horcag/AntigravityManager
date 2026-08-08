import { isPlainObject } from 'lodash-es';

/**
 * `web_search_options` on `POST /v1/chat/completions`.
 *
 * OpenAI turns its built-in search on with this object rather than with a tool
 * entry, so the switch is the object's presence — `{}` is a valid request that
 * means "search". It maps onto the upstream `{ googleSearch: {} }` tool.
 *
 * The two documented options are rejected rather than dropped: `googleSearch`
 * takes no parameters at all upstream, so neither a context-size hint nor a
 * user location can be applied, and answering as if a location had been honoured
 * is exactly the silent degradation this contract exists to prevent.
 */

export interface OpenAIWebSearchOptionsFailures {
  invalid(param: string, message: string): never;
  unsupported(param: string, message: string): never;
}

export function validateOpenAIWebSearchOptions(
  value: unknown,
  fail: OpenAIWebSearchOptionsFailures,
): boolean {
  if (value === undefined) {
    return false;
  }
  if (!isPlainObject(value)) {
    fail.invalid('web_search_options', 'web_search_options must be an object');
  }

  const options = value as Record<string, unknown>;
  if (options.search_context_size !== undefined) {
    fail.unsupported(
      'web_search_options.search_context_size',
      'the upstream googleSearch tool has no context-size control, so search_context_size cannot be applied',
    );
  }
  if (options.user_location !== undefined) {
    fail.unsupported(
      'web_search_options.user_location',
      'the upstream googleSearch tool takes no user location, so user_location cannot be applied',
    );
  }
  for (const field of Object.keys(options)) {
    if (field !== 'search_context_size' && field !== 'user_location') {
      fail.unsupported(
        `web_search_options.${field}`,
        `web_search_options.${field} is not implemented by this Chat Completions adapter`,
      );
    }
  }

  return true;
}
