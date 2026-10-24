import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { AI_USAGE_SCHEMA_SQL } from '../database/ai-usage-schema.js';

import { createHistoricalSkillResolver, HISTORICAL_SKILL_PUBLICATION_PREFIX } from './ai-usage-skill-history.js';

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close()); db.exec(AI_USAGE_SCHEMA_SQL);
  const write = db.prepare(`INSERT INTO ai_skill_publications
    (operation_id,tenant_id,user_id,skill_id,skill_name,first_published_at,status,created_at,updated_at)
    VALUES(@id,@tenant,@user,@skill,@name,@at,@status,@at,@at)`);
  return { db, add: (overrides = {}) => write.run({ id: `${HISTORICAL_SKILL_PUBLICATION_PREFIX}a`, tenant: 1, user: 2,
    skill: 'historical:a', name: 'report', at: '2026-09-01T00:00:00.000Z', status: 'confirmed', ...overrides }) };
}
const at = '2026-09-11T00:00:00.000Z';

test('only explicitly imported exact names authorize historical attribution, scoped by tenant and publication time', t => {
  const f = fixture(t); f.add(); f.add({ id: 'ordinary-publication', name: 'ordinary', skill: 'remote' });
  const resolve = createHistoricalSkillResolver(f.db, 1);
  assert.deepEqual(resolve('report', at).match, { skillId: 'historical:a', skillName: 'report', publisherUserId: 2,
    firstPublishedAt: '2026-09-01T00:00:00.000Z' });
  for (const name of ['Report', 'plugin:report', 'ordinary', 'missing']) assert.equal(resolve(name, at).match, null);
  assert.equal(resolve('report', '2026-08-31T00:00:00Z').reason, 'historical_publication_after_call');
  assert.equal(createHistoricalSkillResolver(f.db, 2)('report', at).match, null);
  assert.equal(resolve('report', 'invalid').match, null);
});

test('competing identities never choose a publisher by name; duplicate proof for one identity is accepted', t => {
  const f = fixture(t); f.add(); f.add({ id: 'duplicate-proof' });
  const resolve = createHistoricalSkillResolver(f.db, 1);
  assert.equal(resolve('report', at).match.publisherUserId, 2);
  f.add({ id: `${HISTORICAL_SKILL_PUBLICATION_PREFIX}other`, user: 3, skill: 'historical:b' }); resolve.clear();
  assert.equal(resolve('report', at).reason, 'historical_name_ambiguous');
  f.db.prepare('DELETE FROM ai_skill_publications WHERE user_id=3').run();
  f.add({ id: 'ordinary-other-skill', skill: 'remote-other' }); resolve.clear();
  assert.equal(resolve('report', at).reason, 'historical_name_ambiguous');
});

test('a later competing publication only prevents attribution from its own date', t => {
  const f = fixture(t); f.add(); f.add({ id: 'ordinary-other-publisher', skill: 'remote-other', user: 3,
    at: '2026-09-12T00:00:00Z' });
  const resolve = createHistoricalSkillResolver(f.db, 1);
  assert.ok(resolve('report', at).match);
  assert.equal(resolve('report', '2026-09-13T00:00:00Z').reason, 'historical_name_ambiguous');
});

test('confirmed publication events compete with historical names without authorizing name guessing themselves', t => {
  const f = fixture(t); f.add();
  f.db.prepare(`INSERT INTO ai_skill_publish_events
    (id,tenant_id,user_id,workspace_id,skill_id,skill_name,publish_kind,status,requested_at,published_at)
    VALUES('click',1,3,10,'remote','report','create','succeeded',?,?)`).run(at, at);
  assert.equal(createHistoricalSkillResolver(f.db, 1)('report', at).reason, 'historical_name_ambiguous');
  f.db.exec('DELETE FROM ai_skill_publications');
  assert.equal(createHistoricalSkillResolver(f.db, 1)('report', at).match, null);
});


test('legacy rows with missing source identity cannot abort historical attribution', t => {
  const f = fixture(t); f.add({ id: null, skill: 'legacy', name: 'orphan' });
  const resolve = createHistoricalSkillResolver(f.db, 1);
  assert.equal(resolve('orphan', at).match, null);
  f.add();
  assert.equal(resolve('report', at).match.publisherUserId, 2);
});
