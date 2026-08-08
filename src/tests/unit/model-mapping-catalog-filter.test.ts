import { describe, expect, it } from 'vitest';
import {
  type CatalogModelRoleIndex,
  getAllDynamicModels,
  getPublishedCatalogModelIds,
  getUnpublishedCatalogModelIds,
  isNonChatCatalogModelId,
  resolveCatalogWithholdReason,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';

function roleIndex(overrides: Partial<CatalogModelRoleIndex> = {}): CatalogModelRoleIndex {
  return {
    nonChatRoles: new Map(),
    chatModelIds: new Set(),
    hasChatRoleData: true,
    ...overrides,
  };
}

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

  it('withholds ids the provider assigned only to a non-chat role', () => {
    const index = roleIndex({
      nonChatRoles: new Map([
        ['tab_lite_preview', ['tab']],
        ['transcriber_v2', ['audio_transcription']],
      ]),
      chatModelIds: new Set(['gemini-3-flash']),
    });

    expect(
      getPublishedCatalogModelIds(
        {},
        ['gemini-3-flash', 'tab_lite_preview', 'transcriber_v2'],
        index,
      ),
    ).toEqual(['gemini-3-flash']);
  });

  it('keeps an id the provider also offers on the chat surface', () => {
    const index = roleIndex({
      nonChatRoles: new Map([['gemini-3-flash', ['command', 'commit_message']]]),
      chatModelIds: new Set(['gemini-3-flash']),
    });

    expect(getPublishedCatalogModelIds({}, ['gemini-3-flash'], index)).toEqual(['gemini-3-flash']);
    expect(resolveCatalogWithholdReason('gemini-3-flash', index)).toBeUndefined();
  });

  it('does not withhold on role membership when the chat role was never reported', () => {
    const index = roleIndex({
      nonChatRoles: new Map([['tab_lite_preview', ['tab']]]),
      hasChatRoleData: false,
    });

    expect(getPublishedCatalogModelIds({}, ['gemini-3-flash', 'tab_lite_preview'], index)).toEqual([
      'gemini-3-flash',
      'tab_lite_preview',
    ]);
  });

  it('behaves exactly as before when no role information is available', () => {
    const discovered = ['gemini-3-flash', 'chat_20706', 'tab_flash_lite_preview'];

    expect(
      getPublishedCatalogModelIds({}, discovered, roleIndex({ hasChatRoleData: false })),
    ).toEqual(getPublishedCatalogModelIds({}, discovered));
  });
});

describe('getUnpublishedCatalogModelIds', () => {
  it('reports the provider role that withheld an id', () => {
    const index = roleIndex({
      nonChatRoles: new Map([['tab_lite_preview', ['tab']]]),
      chatModelIds: new Set(['gemini-3-flash']),
    });

    expect(getUnpublishedCatalogModelIds(['gemini-3-flash', 'tab_lite_preview'], index)).toEqual([
      { id: 'tab_lite_preview', reason: 'role', roles: ['tab'] },
    ]);
  });

  it('falls back to the last-resort id table when role data cannot explain an id', () => {
    const index = roleIndex({ chatModelIds: new Set(['gemini-3-flash']) });

    expect(getUnpublishedCatalogModelIds(['gemini-3-flash', 'chat_20706'], index)).toEqual([
      { id: 'chat_20706', reason: 'override', roles: [] },
    ]);
  });

  it('prefers the provider role over the id table for a listed id', () => {
    const index = roleIndex({
      nonChatRoles: new Map([['tab_flash_lite_preview', ['tab']]]),
      chatModelIds: new Set(['gemini-3-flash']),
    });

    expect(getUnpublishedCatalogModelIds(['tab_flash_lite_preview'], index)).toEqual([
      { id: 'tab_flash_lite_preview', reason: 'role', roles: ['tab'] },
    ]);
  });
});
