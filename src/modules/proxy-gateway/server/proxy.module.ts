import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { AccountLeaseService } from './account-lease.service';
import { GeminiClient } from './clients/gemini.client';
import { GeminiController } from './gemini.controller';
import { ProxyGuard } from './proxy.guard';
import {
  FastifyMultipartProvider,
  MultipartOpenAIExceptionFilter,
} from './fastify-multipart.provider';

@Module({
  imports: [],
  controllers: [ProxyController, GeminiController],
  providers: [
    ProxyService,
    AccountLeaseService,
    GeminiClient,
    ProxyGuard,
    FastifyMultipartProvider,
    {
      provide: APP_FILTER,
      useClass: MultipartOpenAIExceptionFilter,
    },
  ],
  exports: [AccountLeaseService],
})
export class ProxyModule {}
