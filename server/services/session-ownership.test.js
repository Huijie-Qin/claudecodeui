import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionOwnershipRecorder } from './session-ownership.js';

test('recordProviderSession indexes provider sessions when ownership fields exist', () => {
  const seen = {};
  const recordProviderSession = createSessionOwnershipRecorder({
    sessions: {
      upsertSession: (payload) => {
        Object.assign(seen, payload);
        return payload;
      },
    },
  });

  recordProviderSession({
    options: {
      tenantId: 2,
      workspaceId: 10,
      userId: 7,
      sessionSummary: 'Build feature',
    },
    provider: 'claude',
    providerSessionId: 'abc',
    status: 'active',
  });

  assert.deepEqual(seen, {
    tenantId: 2,
    workspaceId: 10,
    userId: 7,
    provider: 'claude',
    providerSessionId: 'abc',
    summary: 'Build feature',
    status: 'active',
  });
});

test('recordProviderSession skips sessions without ownership context', () => {
  let called = false;
  const recordProviderSession = createSessionOwnershipRecorder({
    sessions: {
      upsertSession: () => {
        called = true;
      },
    },
  });

  recordProviderSession({
    options: { tenantId: 2, workspaceId: 10 },
    provider: 'codex',
    providerSessionId: 'abc',
  });

  assert.equal(called, false);
});
