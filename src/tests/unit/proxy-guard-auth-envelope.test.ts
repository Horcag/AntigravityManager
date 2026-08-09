import type { ExecutionContext } from '@nestjs/common';
import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';

const credentialMocks = vi.hoisted(() => ({
  matches: vi.fn(),
}));

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: credentialMocks,
}));

vi.mock('@/server/server-config', () => ({
  getServerConfig: () => ({
    api_key: 'configured-api-key',
  }),
}));

function createContext(
  url: string,
  headers: Record<string, string> = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        url,
        headers,
        ip: '127.0.0.1',
      }),
    }),
  } as ExecutionContext;
}

function rejectionBody(guard: ProxyGuard, context: ExecutionContext): unknown {
  try {
    guard.canActivate(context);
    throw new Error('expected canActivate to throw UnauthorizedException');
  } catch (error) {
    expect(error).toBeInstanceOf(UnauthorizedException);
    const unauthorized = error as UnauthorizedException;
    expect(unauthorized.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    return unauthorized.getResponse();
  }
}

describe('ProxyGuard auth error envelope', () => {
  beforeEach(() => {
    credentialMocks.matches.mockReset();
    credentialMocks.matches.mockReturnValue(false);
  });

  describe('OpenAI surface (/v1/chat/completions)', () => {
    it('answers the OpenAI SDK envelope when no key is sent', () => {
      const guard = new ProxyGuard();
      const body = rejectionBody(guard, createContext('/v1/chat/completions'));

      expect(body).toEqual({
        error: {
          message: 'API key validation failed',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
          param: null,
        },
      });
    });

    it('answers the OpenAI SDK envelope when the key is wrong', () => {
      const guard = new ProxyGuard();
      const body = rejectionBody(
        guard,
        createContext('/v1/chat/completions', { authorization: 'Bearer sk-wrong' }),
      );

      expect(body).toEqual({
        error: {
          message: 'API key validation failed',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
          param: null,
        },
      });
    });
  });

  describe('Anthropic surface (/v1/messages)', () => {
    it('answers the Anthropic SDK envelope when no key is sent', () => {
      const guard = new ProxyGuard();
      const body = rejectionBody(
        guard,
        createContext('/v1/messages', { 'anthropic-version': '2023-06-01' }),
      );

      expect(body).toEqual({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'API key validation failed',
        },
      });
    });

    it('answers the Anthropic SDK envelope when the key is wrong', () => {
      const guard = new ProxyGuard();
      const body = rejectionBody(
        guard,
        createContext('/v1/messages', {
          'anthropic-version': '2023-06-01',
          'x-api-key': 'sk-wrong',
        }),
      );

      expect(body).toEqual({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'API key validation failed',
        },
      });
    });
  });

  describe('Gemini surface (/v1beta/models/:model:generateContent)', () => {
    it('answers the Gemini SDK envelope when no key is sent', () => {
      const guard = new ProxyGuard();
      const body = rejectionBody(
        guard,
        createContext('/v1beta/models/gemini-2.5-flash:generateContent'),
      );

      expect(body).toEqual({
        error: {
          code: 401,
          message: 'API key validation failed',
          status: 'UNAUTHENTICATED',
        },
      });
    });

    it('answers the Gemini SDK envelope when the key is wrong', () => {
      const guard = new ProxyGuard();
      const body = rejectionBody(
        guard,
        createContext('/v1beta/models/gemini-2.5-flash:generateContent', {
          'x-goog-api-key': 'sk-wrong',
        }),
      );

      expect(body).toEqual({
        error: {
          code: 401,
          message: 'API key validation failed',
          status: 'UNAUTHENTICATED',
        },
      });
    });
  });
});
