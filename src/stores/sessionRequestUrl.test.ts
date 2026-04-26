import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionMessagesUrl } from './sessionRequestUrl';

test('buildSessionMessagesUrl appends current tenant id to history requests', () => {
  const url = buildSessionMessagesUrl('session-123', {
    provider: 'claude',
    projectName: 'workspace-a',
    workspaceId: 27,
    tenantId: 3,
  });

  assert.equal(
    url,
    '/api/sessions/session-123/messages?provider=claude&projectName=workspace-a&workspaceId=27&tenantId=3',
  );
});
