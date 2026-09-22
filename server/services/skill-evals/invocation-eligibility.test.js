import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { isCreatedSkillInvocation, rebindSkillInvocations } from './invocation-eligibility.js';

const completedAt = '2026-09-22T01:00:00.000Z';
function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE skill_creation_jobs (tenant_id INTEGER, workspace_id INTEGER, user_id INTEGER, conversation_key TEXT, data TEXT);
    CREATE TABLE skill_eval_invocations (id TEXT, tenant_id INTEGER, workspace_id INTEGER, user_id INTEGER, data TEXT)`);
  const job = { provider: 'claude', sessionId: 'session-a', status: 'completed', result: { name: 'weekly-report' }, completedAt };
  const row = { tenant_id: 1, workspace_id: 2, user_id: 3, skill_name: 'weekly-report',
    data: JSON.stringify({ sessionId: 'session-a', startedAt: Date.parse(completedAt) + 1000 }) };
  function create(overrides = {}, scope = row) {
    const value = { ...job, ...overrides };
    db.prepare('INSERT INTO skill_creation_jobs VALUES (?,?,?,?,?)')
      .run(scope.tenant_id, scope.workspace_id, scope.user_id, `${value.provider}:${value.sessionId}`, JSON.stringify(value));
  }
  return { db, job, row, create };
}

test('only the same skill created earlier in the same conversation qualifies, including after reload', (t) => {
  const { db, row, create } = fixture(t);
  assert.equal(isCreatedSkillInvocation(db, row), false);
  create();
  assert.equal(isCreatedSkillInvocation(db, row), true);
  assert.equal(isCreatedSkillInvocation(db, JSON.parse(JSON.stringify(row))), true);
  assert.equal(isCreatedSkillInvocation(db, { ...row, skill_name: 'other-skill' }), false);
  const data = JSON.parse(row.data);
  assert.equal(isCreatedSkillInvocation(db, { ...row, data: JSON.stringify({ ...data, sessionId: 'session-b' }) }), false);
  assert.equal(isCreatedSkillInvocation(db, { ...row, data: JSON.stringify({ ...data, startedAt: Date.parse(completedAt) - 1 }) }), false);
});

test('creation jobs from another user, workspace, tenant or provider never qualify', (t) => {
  const { db, row, create } = fixture(t);
  for (const field of ['tenant_id', 'workspace_id', 'user_id']) create({}, { ...row, [field]: 99 });
  create({ provider: 'codex' });
  assert.equal(isCreatedSkillInvocation(db, row), false);
});

test('unfinished or unsuccessful creation and unverified historical invocations stay hidden', (t) => {
  const { db, row, create } = fixture(t);
  for (const status of ['queued', 'generating', 'saving', 'failed', 'cancelled']) create({ status });
  create({ completedAt: null }); create({ completedAt: 'invalid' });
  assert.equal(isCreatedSkillInvocation(db, row), false);
  create();
  for (const data of ['{}', 'null', '{invalid', JSON.stringify({ sessionId: 'session-a' }),
    JSON.stringify({ sessionId: 'session-a', startedAt: null })]) {
    assert.equal(isCreatedSkillInvocation(db, { ...row, data }), false);
  }
  assert.equal(isCreatedSkillInvocation(db, null), false);
});

test('first invocation becomes eligible after creation-only conversation binds to its native session', (t) => {
  const { db, row, create, job } = fixture(t);
  create({ sessionId: 'skill-creation:draft' });
  assert.equal(isCreatedSkillInvocation(db, row), false);
  db.prepare('UPDATE skill_creation_jobs SET conversation_key=?,data=?')
    .run(`claude:${job.sessionId}`, JSON.stringify(job));
  assert.equal(isCreatedSkillInvocation(db, row), true);
});

test('rebinding pending conversations preserves earlier eligibility without moving other users or providers', (t) => {
  const { db, row, create } = fixture(t);
  const scope = { tenantId: 1, workspaceId: 2, userId: 3, provider: 'claude', sessionId: 'pending:old' };
  const data = JSON.stringify({ ...JSON.parse(row.data), sessionId: scope.sessionId });
  const insert = db.prepare('INSERT INTO skill_eval_invocations VALUES (?,?,?,?,?)');
  insert.run('mine', 1, 2, 3, data);
  insert.run('other-user', 1, 2, 4, data);
  insert.run('other-workspace', 1, 9, 3, data);
  insert.run('other-tenant', 9, 2, 3, data);
  const read = (id) => JSON.parse(db.prepare('SELECT data FROM skill_eval_invocations WHERE id=?').get(id).data);
  rebindSkillInvocations(db, { ...scope, provider: 'codex' }, 'session-a');
  assert.equal(read('mine').sessionId, scope.sessionId);
  rebindSkillInvocations(db, scope, 'session-a');
  rebindSkillInvocations(db, scope, 'session-a');
  assert.equal(read('mine').sessionId, 'session-a');
  for (const id of ['other-user', 'other-workspace', 'other-tenant']) assert.equal(read(id).sessionId, scope.sessionId);
  create();
  assert.equal(isCreatedSkillInvocation(db, { ...row, data: JSON.stringify(read('mine')) }), true);
});
