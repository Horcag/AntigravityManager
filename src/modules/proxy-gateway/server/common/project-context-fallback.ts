import type { CloudAccount } from '@/modules/cloud-account/types';
import type { ProxyTokenRetryState } from '../modules/shared/services/proxy-retry.service';

export type ProjectContextFallbackResult<TResult> =
  | {
      status: 'returned';
      value: TResult;
    }
  | {
      status: 'final';
      lastError: unknown;
      shouldRetry: boolean;
    };

export interface ProjectContextFallbackOptions<TResult> {
  error: unknown;
  token: CloudAccount;
  retryState: ProxyTokenRetryState;
  model: string;
  isProjectContextError: (errorMessage: string) => boolean;
  prepareGraceRetry: (error: unknown) => Promise<boolean>;
  applyUpstreamPenalty: (accountId: string, model: string, error: unknown) => Promise<void>;
  onFallback: () => Promise<TResult>;
  onProjectContextError: (error: string) => void;
}

export async function executeProjectContextFallback<TResult>(
  options: ProjectContextFallbackOptions<TResult>,
): Promise<ProjectContextFallbackResult<TResult>> {
  const shouldGraceRetry = async (
    error: unknown,
  ): Promise<ProjectContextFallbackResult<TResult>> => {
    const shouldRetry = await options.prepareGraceRetry(error);
    if (shouldRetry) {
      return {
        status: 'final',
        shouldRetry: true,
        lastError: error,
      };
    }

    await options.applyUpstreamPenalty(options.token.id, options.model, error);
    return {
      status: 'final',
      shouldRetry: false,
      lastError: error,
    };
  };

  if (!(options.error instanceof Error)) {
    return shouldGraceRetry(options.error);
  }

  if (!options.isProjectContextError(options.error.message)) {
    return shouldGraceRetry(options.error);
  }

  options.onProjectContextError(options.error.message);

  try {
    const value = await options.onFallback();
    return {
      status: 'returned',
      value,
    };
  } catch (fallbackError) {
    return shouldGraceRetry(fallbackError);
  }
}
