import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';

test('fixed summary ignores interactive filters and counts cumulative published Skill IDs only', (t) => {
  const { queryService: query, access, accessService, batch, row } = fixture(t);
  batch('batch-1', 10, 'published', { activeUsers: 'complete', skillPublications: 'complete' });
  row({ id: 'session-1', dataset: 'interactions', date: '2026-08-14', sessionKey: 'shared-session' });
  row({ id: 'session-1-again', dataset: 'interactions', date: '2026-09-12', sessionKey: 'shared-session' });
  row({ id: 'session-2', dataset: 'interactions', userId: 4, sessionKey: 'another-session' });
  row({ id: 'old-session', dataset: 'interactions', date: '2026-08-13', sessionKey: 'out-of-range' });
  row({ id: 'dau', dataset: 'active_users', date: '2026-09-12', value: { isDau: true } });
  row({ id: 'dau-other-workspace', dataset: 'active_users', date: '2026-09-12', workspaceId: 8, value: { isDau: true } });
  row({ id: 'mau', dataset: 'active_users', date: '2026-09-12', userId: 4, value: { isDau: false } });
  // A publication older than the interactive 366-day limit still counts.
  row({ id: 'old-pub', dataset: 'skill_publications', date: '2024-01-01', workspaceId: null, subjectId: 'skill-a', value: { publisherUserId: 3, skillName: 'same-name' } });
  row({ id: 'repeat-pub', dataset: 'skill_publications', subjectId: 'skill-a', value: { publisherUserId: 3, skillName: 'same-name' } });
  row({ id: 'other-pub', dataset: 'skill_publications', userId: 4, subjectId: 'skill-b', value: { publisherUserId: 4, skillName: 'same-name' } });
  row({ id: 'unconfirmed-call', dataset: 'skill_invocations', subjectId: 'call-only-skill', value: { publisherUserId: 3 } });
  row({ id: 'future-pub', dataset: 'skill_publications', date: '2026-09-13', subjectId: 'future-skill' });
  const summary = query.summary(access);
  assert.deepEqual([summary.sessionCount, summary.publishedSkillCount, summary.dau, summary.mau], [2, 2, 1, 2]);
  assert.deepEqual([summary.from, summary.to, summary.mauFrom, summary.scope], ['2026-08-14', '2026-09-12', '2026-08-14', 'tenant']);
  assert.deepEqual(query.summary(access, { from: '2026-09-01', to: '2026-09-01', userId: 4, workspaceId: 999,
    search: 'no match', userSearch: 'no match', provider: 'codex', page: 99, pageSize: 1, groupBy: 'user', minValue: 999 }), summary);
  assert.deepEqual(query.summary({ ...access, scope: 'self' }), summary);
  // Filtered detail queries keep their original period-based semantics.
  assert.equal(query.overview(access, { from: '2026-09-12', to: '2026-09-12' }).publishedSkillCount, 0);
  assert.equal(query.overview(access, { userId: 4 }).sessionCount, 1);
  const self = query.summary(accessService.resolve({ tenantId: 10, userId: 3 }), { userId: 4, scope: 'tenant' });
  assert.deepEqual([self.scope, self.sessionCount, self.publishedSkillCount, self.dau, self.mau], ['self', 1, 1, 1, 1]);
});

test('fixed summary preserves batch isolation, unavailable values and deleted-publication suppression', (t) => {
  const { db, queryService: query, access, batch, row } = fixture(t);
  const missing = query.summary(access);
  assert.deepEqual([missing.sessionCount, missing.publishedSkillCount, missing.dau, missing.mau], [null, null, null, null]);
  batch('batch-1', 10, 'published', { activeUsers: 'complete', skillPublications: 'complete' });
  row({ id: 'old-pub', dataset: 'skill_publications', date: '2024-01-01', subjectId: 'skill-a' });
  batch('batch-2', 10, 'published', { activeUsers: 'complete', skillPublications: 'complete' });
  assert.equal(query.summary(access).publishedSkillCount, 0);
  assert.throws(() => query.summary(access, { batchId: 'batch-1' }), { code: 'reportUpdated' });
  row({ id: 'old-pub', dataset: 'skill_publications', date: '2024-01-01', subjectId: 'skill-a', batchId: 'batch-2' });
  assert.equal(query.summary(access).publishedSkillCount, 1);
  db.prepare('INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(?,?,?)').run(10, 'skill_publications', 'old-pub');
  assert.equal(query.summary(access).publishedSkillCount, 0);
  batch('building', 10, 'running'); batch('foreign', 20);
  assert.throws(() => query.summary(access, { batchId: 'building' }), { statusCode: 404 });
  assert.throws(() => query.summary(access, { batchId: 'foreign' }), { statusCode: 404 });
  batch('unavailable', 10, 'published', { skillPublications: 'unavailable' });
  const unavailable = query.summary(access);
  assert.deepEqual([unavailable.sessionCount, unavailable.publishedSkillCount, unavailable.dau, unavailable.mau], [0, null, null, null]);
});
