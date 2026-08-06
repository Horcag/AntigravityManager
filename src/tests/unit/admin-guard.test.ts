import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { AdminGuard } from '@/modules/proxy-gateway/server/guards/admin.guard';
import { hasMatchingApiKey } from '@/modules/proxy-gateway/server/guards/api-key-auth.util';
import { setServerConfig } from '@/server/server-config';

function createContext(headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as ExecutionContext;
}

describe('AdminGuard', () => {
  it('matches configured keys with a length-safe comparison', () => {
    expect(hasMatchingApiKey('admin-key', 'admin-key')).toBe(true);
    expect(hasMatchingApiKey('admin-key', 'admin-key-extra')).toBe(false);
    expect(hasMatchingApiKey('admin-key', 'wrong-key')).toBe(false);
    expect(hasMatchingApiKey(null, 'admin-key')).toBe(false);
  });

  it('rejects admin requests when no API key is configured', () => {
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      api_key: '',
    });

    expect(() => new AdminGuard().canActivate(createContext())).toThrow(UnauthorizedException);
  });

  it('accepts admin requests with the configured API key', () => {
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      api_key: 'admin-key',
    });

    expect(new AdminGuard().canActivate(createContext({ authorization: 'Bearer admin-key' }))).toBe(
      true,
    );
  });
});
