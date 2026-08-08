import { describe, expect, it } from 'vitest';
import {
  getAllDynamicModels,
  getPublishedCatalogModelIds,
  isNonChatCatalogModelId,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';

describe('getPublishedCatalogModelIds', () => {
  it('drops provider-advertised non-chat service ids while keeping every real model', () => {
    const discovered = [
      'gemini-3-flash',
      'claude-sonnet-4-5',
      'chat_20706',
      'chat_23310',
      'tab_flash_lite_preview',
      'tab_jump_flash_lite_preview',
    ];

    expect(getPublishedCatalogModelIds({}, discovered)).toEqual([
      'claude-sonnet-4-5',
      'gemini-3-flash',
    ]);
  });

  it('is case-insensitive and does not affect the raw routing engine list', () => {
    expect(isNonChatCatalogModelId('Chat_20706')).toBe(true);
    expect(isNonChatCatalogModelId('gemini-3-flash')).toBe(false);

    expect(getAllDynamicModels({}, ['chat_20706', 'gemini-3-flash'])).toEqual([
      'chat_20706',
      'gemini-3-flash',
    ]);
  });

  it('still applies configured aliases on top of the filtered discovery list', () => {
    expect(
      getPublishedCatalogModelIds(
        {
          'custom-fast': 'gemini-3.1-flash-lite',
        },
        ['chat_20706', 'gemini-3-flash'],
      ),
    ).toEqual(['custom-fast', 'gemini-3-flash']);
  });
});
