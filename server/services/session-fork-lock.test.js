import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { withClaudeSessionForkLock } from '../claude-sdk.js';

test('fork locks reject a concurrent operation on the same scope and release after failure', async () => {
  const scope = { tenantId: 1, userId: 2, workspaceId: 3, sessionId: randomUUID() };
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = withClaudeSessionForkLock(scope, async () => { entered(); await gate; throw new Error('fixture failure'); });
  await started;
  await assert.rejects(withClaudeSessionForkLock(scope, () => assert.fail('must not run')), { code: 'SESSION_BUSY', statusCode: 409 });
  assert.equal(await withClaudeSessionForkLock({ ...scope, sessionId: randomUUID() }, () => 'independent'), 'independent');
  release();
  await assert.rejects(first, /fixture failure/);
  assert.equal(await withClaudeSessionForkLock(scope, () => 'retry'), 'retry');
});
