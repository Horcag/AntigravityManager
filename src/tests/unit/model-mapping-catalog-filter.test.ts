import { describe, expect, it } from 'vitest';
import {
  type CatalogModelRoleIndex,
  type CompletionModelFlag,
  getAllDynamicModels,
  getPublishedCatalogModelIds,
  getUnpublishedCatalogModelIds,
  isNonChatCatalogModelId,
  NON_CHAT_CATALOG_MODEL_IDS,
  resolveCatalogWithholdReason,
  resolveCompletionModelFlags,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';

const ALL_COMPLETION_FLAGS: CompletionModelFlag[] = [
  'requiresLeadInGeneration',
  'supportsCumulativeContext',
  'supportsEstimateTokenCounter',
];

/**
 * The table ships empty, so the escape hatch it exists for is only observable
 * with an entry put there for the duration of one test.
 */
function withOverrideEntry(modelId: string, run: () => void): void {
  const table = NON_CHAT_CATALOG_MODEL_IDS as Set<string>;
  table.add(modelId);
  try {
    run();
  } finally {
    table.delete(modelId);
  }
}

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

  it('withholds the last two table ids on the markers measured live on them', () => {
    // 0.19.28-local1: both carry all three, which is why the table is empty.
    const index = roleIndex({
      completionFlags: new Map([
        ['chat_23310', ALL_COMPLETION_FLAGS],
        ['tab_jump_flash_lite_preview', ALL_COMPLETION_FLAGS],
      ]),
    });
    const discovered = ['gemini-3-flash', 'chat_23310', 'tab_jump_flash_lite_preview'];

    expect(getPublishedCatalogModelIds({}, discovered, index)).toEqual(['gemini-3-flash']);
  });

  it('publishes those same ids when no marker reaches them', () => {
    // The emptied table withholds nothing on its own.
    const discovered = ['gemini-3-flash', 'chat_23310', 'tab_jump_flash_lite_preview'];

    expect(getPublishedCatalogModelIds({}, discovered)).toEqual([
      'chat_23310',
      'gemini-3-flash',
      'tab_jump_flash_lite_preview',
    ]);
  });

  it('ships an empty table and does not affect the raw routing engine list', () => {
    expect(NON_CHAT_CATALOG_MODEL_IDS.size).toBe(0);
    expect(isNonChatCatalogModelId('Chat_23310')).toBe(false);
    expect(isNonChatCatalogModelId('gemini-3-flash')).toBe(false);

    expect(getAllDynamicModels({}, ['chat_23310', 'gemini-3-flash'])).toEqual([
      'chat_23310',
      'gemini-3-flash',
    ]);
  });

  it('still applies configured aliases on top of the filtered discovery list', () => {
    const index = roleIndex({
      completionFlags: new Map([['chat_23310', ALL_COMPLETION_FLAGS]]),
    });

    expect(
      getPublishedCatalogModelIds(
        {
          'custom-fast': 'gemini-3.1-flash-lite',
        },
        ['chat_23310', 'gemini-3-flash'],
        index,
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

  it('reports nothing for an id no marker classifies, now the table is empty', () => {
    const index = roleIndex({ chatModelIds: new Set(['gemini-3-flash']) });

    expect(getUnpublishedCatalogModelIds(['gemini-3-flash', 'chat_23310'], index)).toEqual([]);
  });

  it('still names the table for an injected id, case-insensitively', () => {
    // The escape hatch for an id the marker rule cannot read: emptying the
    // table must not silently delete it.
    const index = roleIndex({ chatModelIds: new Set(['gemini-3-flash']) });

    withOverrideEntry('probe_pending_id', () => {
      expect(isNonChatCatalogModelId('Probe_Pending_Id')).toBe(true);
      expect(getUnpublishedCatalogModelIds(['gemini-3-flash', 'probe_pending_id'], index)).toEqual([
        { id: 'probe_pending_id', reason: 'override', flags: [], roles: [] },
      ]);
      expect(
        getPublishedCatalogModelIds({}, ['gemini-3-flash', 'probe_pending_id'], index),
      ).toEqual(['gemini-3-flash']);
    });

    expect(isNonChatCatalogModelId('probe_pending_id')).toBe(false);
    expect(getUnpublishedCatalogModelIds(['gemini-3-flash', 'probe_pending_id'], index)).toEqual(
      [],
    );
  });
});
