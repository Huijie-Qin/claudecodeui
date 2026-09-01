import assert from 'node:assert/strict';
import test from 'node:test';

import { createHookDraftSignature, createHookItemId } from './editorUtils';
import type { HookConfigDraft } from './types';

test('createHookItemId uses randomUUID when the browser supports it', () => {
  assert.equal(createHookItemId({ randomUUID: () => 'generated-uuid' }), 'generated-uuid');
});

test('createHookItemId falls back when randomUUID is unavailable', () => {
  assert.equal(
    createHookItemId({
      now: () => 1_700_000_000_000,
      random: () => 0.123456789,
    }),
    'hook_item_loyw3v28_4fzzzxjy',
  );
});

test('createHookDraftSignature ignores persisted metadata but detects editable changes', () => {
  const draft: HookConfigDraft = {
    name: 'SQL Check',
    description: 'Validate SQL',
    eventName: 'Stop',
    matcher: {},
    extensionLogic: null,
    postActions: [],
    claudeResponse: { bindings: {} },
  };
  const persisted = {
    ...draft,
    id: 'hook-1',
    status: 'published' as const,
    version: 2,
    createdBy: 1,
    updatedBy: 1,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:01:00.000Z',
    publishedAt: '2026-08-23T00:01:00.000Z',
    activationScope: 'manual' as const,
    bindingController: 'admin' as const,
    boundUserCount: 0,
    boundTenantCount: 0,
    hasDataRecords: false,
  };

  assert.equal(createHookDraftSignature(draft), createHookDraftSignature(persisted));
  assert.notEqual(
    createHookDraftSignature(draft),
    createHookDraftSignature({ ...draft, description: 'Changed locally' }),
  );
});
