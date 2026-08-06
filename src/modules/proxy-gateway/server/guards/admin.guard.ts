import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { getServerConfig } from '../../../../server/server-config';
import {
  extractApiKeyToken,
  hasConfiguredApiKey,
  hasMatchingApiKey,
  RequestHeaders,
} from './api-key-auth.util';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const config = getServerConfig();
    const apiKey = config?.api_key;

    if (!hasConfiguredApiKey(apiKey)) {
      throw new UnauthorizedException('Admin API key is not configured');
    }

    const request = context.switchToHttp().getRequest();
    const headers = request.headers as RequestHeaders;
    const clientToken = extractApiKeyToken(headers);

    if (hasMatchingApiKey(clientToken, apiKey)) {
      return true;
    }

    throw new UnauthorizedException('API key validation failed');
  }
}
