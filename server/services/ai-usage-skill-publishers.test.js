import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { AI_USAGE_SCHEMA_SQL } from '../database/ai-usage-schema.js';

import { createSkillPublisherResolver } from './ai-usage-skill-publishers.js';
import { createAiUsageSkillRecorder } from './ai-usage-skills.js';
import { fixture } from './ai-usage-test-fixture.js';

test('successful update events establish publisher evidence only from their confirmed time', (t) => {
  const db = new Database(':memory:'); t.after(() => db.close()); db.exec(AI_USAGE_SCHEMA_SQL);
  const recorder = createAiUsageSkillRecorder({ database: db });
  const event = { operationId: 'updated', tenantId: 10, userId: 2, workspaceId: 7,
    skillId: 'skill-a', skillName: 'Same name', publishKind: 'update', publishedAt: '2026-09-11T02:00:00Z' };
  recorder.beginPublishEvent(event); recorder.succeedPublishEvent(event);
  const uncertain = { ...event, operationId: 'uncertain', skillId: 'skill-b' };
  recorder.beginPublishEvent(uncertain); recorder.identifyPublishEvent(uncertain);
  recorder.failPublishEvent({ ...uncertain, uncertain: true });
  const resolve = createSkillPublisherResolver(db, 10);
  assert.equal(resolve({ remote_skill_id: 'skill-a' }, '2026-09-10T00:00:00Z'), null);
  assert.equal(resolve({ remote_skill_id: 'skill-a' }, '2026-09-12T00:00:00Z'), 2);
  assert.equal(resolve({ remote_skill_id: 'skill-b' }, '2026-09-12T00:00:00Z'), null);
  assert.equal(createSkillPublisherResolver(db, 20)({ remote_skill_id: 'skill-a' }, '2026-09-12T00:00:00Z'), null);
});

test('publisher resolution uses exact tenant/Skill evidence, not caller, names or account numbers', (t) => {
  const db = new Database(':memory:'); t.after(() => db.close()); db.exec(AI_USAGE_SCHEMA_SQL);
  const add = db.prepare(`INSERT INTO ai_skill_publications
    (operation_id,tenant_id,user_id,skill_id,skill_name,status,first_published_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const before = '2026-09-01T00:00:00Z'; const time = '2026-09-11T02:00:00Z';
  for (const [id, tenant, user, skill, status, at] of [
    ['confirmed', 10, 2, 'skill-a', 'confirmed', before],
    ['duplicate-proof', 10, 2, 'skill-a', 'confirmed', before],
    ['other-tenant', 20, 4, 'skill-a', 'confirmed', before],
    ['pending', 10, 3, 'skill-b', 'saved_pending_publish', before],
    ['future', 10, 3, 'skill-c', 'confirmed', '2026-09-12T00:00:00Z'],
    ['conflict-a', 10, 2, 'skill-d', 'confirmed', before],
    ['conflict-b', 10, 3, 'skill-d', 'confirmed', before],
  ]) add.run(id, tenant, user, skill, 'same-name', status, at, before, before);
  const resolve = createSkillPublisherResolver(db, 10);
  const binding = (id, publisher = null) => ({ remote_skill_id: id, publisher_user_id: publisher, publisher_account_id: '3' });
  assert.equal(resolve(binding('skill-a'), time), 2);
  for (const id of ['skill-b', 'skill-c', 'skill-d', 'same-name', 'unknown']) assert.equal(resolve(binding(id), time), null);
  assert.equal(resolve(binding('skill-a', 3), time), null, 'Conflicting author evidence is not guessed');
  assert.equal(resolve(binding('known-legacy', 2), time), 2, 'A trusted historical binding remains valid');
});

test('publisher owns published counts and cross-user calls in tables, filters and self scope', (t) => {
  const f = fixture(t); f.batch();
  f.row({ id: 'publication', dataset: 'skill_publications', subjectId: 'skill-a', userId: 2,
    value: { publisherUserId: 2, skillName: 'Published by admin' } });
  for (let i = 0; i < 3; i++) f.row({ id: `call-${i}`, dataset: 'skill_invocations', subjectId: 'skill-a', userId: 2,
    value: { publisherUserId: 2, callerUserId: 3, skillName: 'Published by admin' } });
  f.row({ id: 'caller-session', dataset: 'interactions', userId: 3 });
  const groups = { dataset: 'usage', groupBy: 'user', includeZeroUsers: true };
  const report = f.queryService.analysis(f.access, groups);
  const author = report.items.find((row) => row.groupKey === '2');
  const caller = report.items.find((row) => row.groupKey === '3');
  assert.equal(author.publishedSkillCount, undefined); assert.equal(author.skillInvocationCount, undefined); assert.equal(author.sessionCount, 0);
  assert.equal(caller.publishedSkillCount, undefined); assert.equal(caller.skillInvocationCount, undefined); assert.equal(caller.sessionCount, 1);
  const publisher = f.queryService.skills(f.access, { groupBy: 'publisher' }).items[0];
  assert.equal(publisher.publisherUserId, 2); assert.equal(publisher.publishedSkillCount, 1); assert.equal(publisher.invocationCount, 3);
  const skills = f.queryService.skills(f.access, { userId: 2 });
  assert.equal(skills.total, 1); assert.equal(skills.items[0].publisherName, 'tenant-admin');
  assert.equal(skills.items[0].invocationCount, 3); assert.equal(skills.items[0].callerCount, 1);
  assert.equal(f.queryService.skills(f.access, { userId: 3 }).total, 0);
  const self = f.accessService.resolve({ tenantId: 10, userId: 3 });
  assert.equal(f.queryService.analysis(self, groups).summary.skillInvocationCount, undefined);
  assert.equal(f.queryService.skills(self).total, 0);
});
