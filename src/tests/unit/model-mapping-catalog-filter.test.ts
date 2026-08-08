import { describe, expect, it } from 'vitest';
import {
  type CatalogModelRoleIndex,
  type CompletionModelFlag,
  getAllDynamicModels,
  getPublishedCatalogModelIds,
  getUnpublishedCatalogModelIds,
  isNonChatCatalogModelId,
  resolveCatalogWithholdReason,
  resolveCompletionModelFlags,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';

const ALL_COMPLETION_FLAGS: CompletionModelFlag[] = [
  'requiresLeadInGeneration',
  'supportsCumulativeContext',
  'supportsEstimateTokenCounter',
];

function roleIndex(overrides: Partial<CatalogModelRoleIndex> = {}): CatalogModelRoleIndex {
  return {
    nonChatRoles: new Map(),
    chatModelIds: new Set(),
    hasChatRoleData: true,
    completionFlags: new Map(),
    ...overrides,
  };
}

describe('resolveCompletionModelFlags', () => {
  it('reports the markers the provider set, in a stable order', () => {
    expect(
      resolveCompletionModelFlags({
        supports_estimate_token_counter: true,
        requires_lead_in_generation: true,
      }),
    ).toEqual(['requiresLeadInGeneration', 'supportsEstimateTokenCounter']);
  });

  it('treats absent and false alike, and an absent detail as no markers', () => {
    expect(
      resolveCompletionModelFlags({
        requires_lead_in_generation: false,
        supports_cumulative_context: undefined,
      }),
    ).toEqual([]);
    expect(resolveCompletionModelFlags(undefined)).toEqual([]);
  });
});

describe('getPublishedCatalogModelIds', () => {
  it('drops ids the provider marks as editor completion models', () => {
    const index = roleIndex({
      completionFlags: new Map([
        ['chat_20706', ALL_COMPLETION_FLAGS],
        ['tab_flash_lite_preview', ALL_COMPLETION_FLAGS],
      ]),
    });
    const discovered = [
      'gemini-3-flash',
      'claude-sonnet-4-5',
      'chat_20706',
      'tab_flash_lite_preview',
    ];

    expect(getPublishedCatalogModelIds({}, discovered, index)).toEqual([
      'claude-sonnet-4-5',
      'gemini-3-flash',
    ]);
  });

  it('drops a single marker as readily as the full set', () => {
    const index = roleIndex({
      completionFlags: new Map([['tab_next_preview', ['requiresLeadInGeneration']]]),
    });

    expect(getPublishedCatalogModelIds({}, ['gemini-3-flash', 'tab_next_preview'], index)).toEqual([
      'gemini-3-flash',
    ]);
  });

  it('still drops the unprobed ids the dated table names', () => {
    const discovered = ['gemini-3-flash', 'chat_23310', 'tab_jump_flash_lite_preview'];

    expect(getPublishedCatalogModelIds({}, discovered)).toEqual(['gemini-3-flash']);
  });

  it('is case-insensitive and does not affect the raw routing engine list', () => {
    expect(isNonChatCatalogModelId('Chat_23310')).toBe(true);
    expect(isNonChatCatalogModelId('gemini-3-flash')).toBe(false);

    expect(getAllDynamicModels({}, ['chat_23310', 'gemini-3-flash'])).toEqual([
      'chat_23310',
      'gemini-3-flash',
    ]);
  });

  it('still applies configured aliases on top of the filtered discovery list', () => {
    expect(
      getPublishedCatalogModelIds(
        {
          'custom-fast': 'gemini-3.1-flash-lite',
        },
        ['chat_23310', 'gemini-3-flash'],
      ),
    ).toEqual(['custom-fast', 'gemini-3-flash']);
  });

  it('publishes ids the provider assigned only to a non-chat role', () => {
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
    ).toEqual(['gemini-3-flash', 'tab_lite_preview', 'transcriber_v2']);
  });

  it('keeps a tool-role model absent from the agent list, as measured live', () => {
    // The live regression: gemini-3-flash is the sole `command` model and is
    // not in agent_model_sorts, yet it answers chat requests normally.
    const index = roleIndex({
      nonChatRoles: new Map([
        ['gemini-3-flash', ['command']],
        ['gemini-3.1-flash-lite', ['commit_message', 'mquery', 'web_search']],
        ['gemini-3.1-flash-image', ['image_generation']],
        ['chat_20706', ['tab']],
      ]),
      chatModelIds: new Set(['gemini-3-pro', 'claude-sonnet-4-5']),
      completionFlags: new Map([['chat_20706', ALL_COMPLETION_FLAGS]]),
    });

    expect(
      getPublishedCatalogModelIds(
        {},
        [
          'gemini-3-pro',
          'claude-sonnet-4-5',
          'gemini-3-flash',
          'gemini-3.1-flash-lite',
          'gemini-3.1-flash-image',
          'chat_20706',
        ],
        index,
      ),
    ).toEqual([
      'claude-sonnet-4-5',
      'gemini-3-flash',
      'gemini-3-pro',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite',
    ]);
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
    const discovered = ['gemini-3-flash', 'chat_23310', 'tab_flash_lite_preview'];

    expect(
      getPublishedCatalogModelIds({}, discovered, roleIndex({ hasChatRoleData: false })),
    ).toEqual(getPublishedCatalogModelIds({}, discovered));
  });
});

describe('getUnpublishedCatalogModelIds', () => {
  it('does not report a role member no rule withholds', () => {
    const index = roleIndex({
      nonChatRoles: new Map([['tab_lite_preview', ['tab']]]),
      chatModelIds: new Set(['gemini-3-flash']),
    });

    expect(getUnpublishedCatalogModelIds(['gemini-3-flash', 'tab_lite_preview'], index)).toEqual(
      [],
    );
  });

  it('names the matching markers and reports the roles as corroboration', () => {
    const index = roleIndex({
      nonChatRoles: new Map([
        ['chat_20706', ['tab']],
        ['gemini-3-flash', ['command']],
      ]),
      chatModelIds: new Set(['gemini-3-pro']),
      completionFlags: new Map([
        ['chat_20706', ALL_COMPLETION_FLAGS],
        ['tab_flash_lite_preview', ['supportsCumulativeContext']],
      ]),
    });

    expect(
      getUnpublishedCatalogModelIds(
        ['chat_20706', 'gemini-3-flash', 'tab_flash_lite_preview'],
        index,
      ),
    ).toEqual([
      {
        id: 'chat_20706',
        reason: 'completion_model',
        flags: ALL_COMPLETION_FLAGS,
        roles: ['tab'],
      },
      {
        id: 'tab_flash_lite_preview',
        reason: 'completion_model',
        flags: ['supportsCumulativeContext'],
        roles: [],
      },
    ]);
  });

  it('names the dated table for an id no marker classifies', () => {
    const index = roleIndex({ chatModelIds: new Set(['gemini-3-flash']) });

    expect(getUnpublishedCatalogModelIds(['gemini-3-flash', 'chat_23310'], index)).toEqual([
      { id: 'chat_23310', reason: 'override', flags: [], roles: [] },
    ]);
  });
});
