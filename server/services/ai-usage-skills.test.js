import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import Database from 'better-sqlite3';

import { AI_USAGE_SCHEMA_SQL } from '../database/ai-usage-schema.js';

import { createAiUsageSkillRecorder } from './ai-usage-skills.js';
import { uploadAndPublishLocalSkill } from './skill-market.js';

const scope = { tenantId: 1, userId: 2, workspaceId: 3 };
const publishedAt = '2026-09-11T02:00:00.000Z';

function fixture() {
  const database = new Database(':memory:');
  database.exec(AI_USAGE_SCHEMA_SQL);
  const warnings = [];
  const recorder = createAiUsageSkillRecorder({ database, now: () => publishedAt,
    logger: { warn: (message) => warnings.push(message) } });
  return { database, recorder, warnings,
    events: () => database.prepare('SELECT * FROM ai_skill_publish_events ORDER BY requested_at,id').all(),
    rows: () => database.prepare('SELECT * FROM ai_skill_publications').all() };
}

test('publish click events are scoped, idempotent and preserve a remote success after local failure', () => {
  const f = fixture();
  try {
    const event = f.recorder.beginPublishEvent({ ...scope, operationId: 'click-1', skillName: 'Existing Skill', publishKind: 'update' });
    f.recorder.beginPublishEvent({ ...scope, operationId: 'click-1', skillName: 'Existing Skill', publishKind: 'update' });
    assert.equal(f.events().length, 1);
    assert.equal(f.events()[0].status, 'requested');
    assert.equal(f.recorder.succeedPublishEvent({ ...event, tenantId: 99, skillId: 'remote-1', publishedAt }), false);
    f.recorder.identifyPublishEvent({ ...event, skillId: 'remote-1' });
    f.recorder.succeedPublishEvent({ ...event, skillId: 'remote-1', publishedAt, publishedVersion: 4 });
    f.recorder.succeedPublishEvent({ ...event, skillId: 'remote-1', publishedAt: '2026-09-12T00:00:00Z', publishedVersion: 5 });
    f.recorder.failPublishEvent({ ...event, uncertain: true });
    assert.deepEqual(f.events().map(({ status, skill_id, workspace_id, published_at, published_version }) =>
      ({ status, skill_id, workspace_id, published_at, published_version })),
    [{ status: 'succeeded', skill_id: 'remote-1', workspace_id: 3, published_at: publishedAt, published_version: 4 }]);
    assert.equal(f.rows().length, 0, 'Event capture does not fabricate first-created publication history');
  } finally { f.database.close(); }
});

test('failed and unconfirmed publish actions remain separate from confirmed publications', () => {
  const f = fixture();
  try {
    for (const uncertain of [false, true]) {
      const event = f.recorder.beginPublishEvent({ ...scope, skillName: 'Skill', publishKind: 'create' });
      f.recorder.failPublishEvent({ ...event, uncertain });
    }
    assert.deepEqual(f.events().map(row => row.status).sort(), ['failed', 'unknown']);
    assert.ok(f.events().every(row => row.published_at === null));
    assert.equal(f.recorder.beginPublishEvent({ ...scope, tenantId: null, skillName: 'Skill', publishKind: 'create' }), null);
    assert.equal(f.rows().length, 0);
  } finally { f.database.close(); }
});

test('only confirmed first publications count and confirmation is idempotent', () => {
  const f = fixture();
  try {
    const operation = f.recorder.beginPublication({ ...scope, skillName: 'New Skill' });
    assert.equal(f.rows()[0].status, 'pending');
    f.recorder.saved({ ...operation, skillId: 'remote-1' });
    assert.equal(f.rows()[0].first_published_at, null);
    f.recorder.confirmed({ ...operation, skillId: 'remote-1', firstPublishedAt: publishedAt });
    f.recorder.confirmed({ ...operation, skillId: 'remote-1', firstPublishedAt: '2026-09-12T02:00:00.000Z' });
    f.recorder.reconciliationRequired(operation);
    assert.equal(f.rows().length, 1);
    assert.equal(f.rows()[0].status, 'confirmed');
    assert.equal(f.rows()[0].first_published_at, publishedAt);
  } finally { f.database.close(); }
});

test('uncertain publication retains the saved remote identity without invented first publication time', () => {
  const f = fixture();
  try {
    const operation = f.recorder.beginPublication({ ...scope, skillName: 'New Skill' });
    f.recorder.saved({ ...operation, skillId: 'remote-1' });
    f.recorder.reconciliationRequired(operation);
    assert.equal(f.rows()[0].skill_id, 'remote-1');
    assert.equal(f.rows()[0].status, 'reconciliation_required');
    assert.equal(f.rows()[0].first_published_at, null);
    f.recorder.confirmed({ ...operation, tenantId: 9, skillId: 'remote-1', firstPublishedAt: publishedAt });
    assert.equal(f.rows()[0].status, 'reconciliation_required');
  } finally { f.database.close(); }
});

test('binding history preserves effective intervals and never converts external account IDs to user IDs', () => {
  const f = fixture();
  try {
    const first = { ...scope, accountId: '0007', at: '2026-09-11T01:00:00.000Z',
      bindings: { local: { id: 'remote-1', createUserId: '0007' }, other: { id: 'remote-2', createUserId: '984' } } };
    f.recorder.syncBindings(first); f.recorder.syncBindings(first);
    let rows = f.database.prepare('SELECT * FROM ai_skill_binding_history ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].publisher_user_id, scope.userId);
    assert.equal(rows[1].publisher_user_id, null);
    f.recorder.syncBindings({ ...first, at: publishedAt, bindings: { local: { id: 'remote-3', createUserId: '0007' } } });
    rows = f.database.prepare('SELECT * FROM ai_skill_binding_history ORDER BY id').all();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].valid_to, publishedAt);
    assert.equal(rows[1].valid_to, publishedAt);
    assert.equal(rows[2].valid_from, publishedAt);
    f.recorder.closeBinding({ ...scope, localName: 'local', at: '2026-09-12T00:00:00.000Z' });
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM ai_skill_binding_history WHERE valid_to IS NULL').get().n, 0);
    assert.equal(f.rows().length, 0, 'Binding snapshots never fabricate publication history');
  } finally { f.database.close(); }
});

async function publicationScenario(t, { failure = null, usageRecorder } = {}) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-usage-publication-'));
  const skillPath = path.join(workspacePath, '.claude', 'skills', 'first-skill');
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# First skill\n');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const endpoint = new URL(url).pathname;
    calls.push(endpoint);
    if (endpoint.endsWith('/publish') && failure === 'publish') throw new Error('Connection lost after remote publish');
    if (endpoint.endsWith('/publish') && failure === 'reject') return new Response(JSON.stringify({ code: 403, message: 'Publication rejected' }), { headers: { 'content-type': 'application/json' } });
    let data;
    if (endpoint.endsWith('/skillList')) data = [];
    else if (endpoint.endsWith('/save')) data = 'new-remote-skill';
    else if (endpoint.endsWith('/publish')) {
      data = { version: 1 };
      if (failure === 'local-after-publish') {
        await fs.mkdir(path.join(workspacePath, '.cloudcli'), { recursive: true });
        await fs.writeFile(path.join(workspacePath, '.cloudcli', 'skills'), 'Block the later local binding write');
      }
    }
    else assert.fail(`Unexpected remote call ${endpoint}`);
    return new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await uploadAndPublishLocalSkill({ workspacePath, name: 'first-skill', currentUsername: 'author',
      tenantCode: 'tenant', accountId: 'author', now: () => new Date(publishedAt), usageRecorder });
    return { result, calls };
  } catch (error) { return { error, calls }; }
  finally { await fs.rm(workspacePath, { recursive: true, force: true }); }
}

test('new Skill publish chain records save identity before publish confirmation', async (t) => {
  const f = fixture();
  const usageRecorder = Object.fromEntries(Object.keys(f.recorder).map((method) => [method,
    (input) => f.recorder[method]({ ...input, ...scope })]));
  try {
    const { result, calls, error } = await publicationScenario(t, { usageRecorder });
    assert.equal(error, undefined);
    assert.equal(result.skill.id, 'new-remote-skill');
    assert.equal(calls.filter((endpoint) => endpoint.endsWith('/save')).length, 1);
    assert.equal(calls.filter((endpoint) => endpoint.endsWith('/publish')).length, 1);
    assert.equal(f.rows()[0].status, 'confirmed');
    assert.equal(f.rows()[0].first_published_at, publishedAt);
    assert.equal(f.events()[0].status, 'succeeded');
    assert.equal(f.events()[0].skill_id, 'new-remote-skill');
    assert.equal(f.events()[0].publish_kind, 'create');
  } finally { f.database.close(); }
});

test('an uncertain remote response is not retried and remains pending reconciliation', async (t) => {
  const f = fixture();
  const usageRecorder = Object.fromEntries(Object.keys(f.recorder).map((method) => [method,
    (input) => f.recorder[method]({ ...input, ...scope })]));
  try {
    const { error, calls } = await publicationScenario(t, { usageRecorder, failure: 'publish' });
    assert.match(error.message, /Connection lost/);
    assert.equal(calls.filter((endpoint) => endpoint.endsWith('/publish')).length, 1);
    assert.equal(f.rows()[0].status, 'reconciliation_required');
    assert.equal(f.rows()[0].skill_id, 'new-remote-skill');
    assert.equal(f.rows()[0].first_published_at, null);
    assert.equal(f.events()[0].status, 'unknown');
    assert.equal(f.events()[0].skill_id, 'new-remote-skill');
  } finally { f.database.close(); }
});

test('analytics writes failing after remote success never resend or fail the business operation', async (t) => {
  const f = fixture();
  const usageRecorder = Object.fromEntries(Object.keys(f.recorder).map((method) => [method,
    (input) => {
      if (method === 'confirmed') throw new Error('Stats database busy');
      return f.recorder[method]({ ...input, ...scope });
    }]));
  try {
    const { error, result, calls } = await publicationScenario(t, { usageRecorder });
    assert.equal(error, undefined);
    assert.equal(result.skill.id, 'new-remote-skill');
    assert.equal(calls.filter((endpoint) => endpoint.endsWith('/publish')).length, 1);
    assert.equal(f.rows()[0].status, 'reconciliation_required');
  } finally { f.database.close(); }
});

test('a confirmed remote rejection is recorded as failed, not a successful publish', async (t) => {
  const f = fixture();
  const usageRecorder = Object.fromEntries(Object.keys(f.recorder).map(method => [method,
    input => f.recorder[method]({ ...input, ...scope })]));
  try {
    const { error, calls } = await publicationScenario(t, { usageRecorder, failure: 'reject' });
    assert.match(error.message, /Publication rejected/);
    assert.equal(calls.filter(endpoint => endpoint.endsWith('/publish')).length, 1);
    assert.equal(f.events()[0].status, 'failed');
    assert.equal(f.events()[0].published_at, null);
  } finally { f.database.close(); }
});

test('local binding failure after remote confirmation cannot retract a successful publish event', async (t) => {
  const f = fixture();
  const usageRecorder = Object.fromEntries(Object.keys(f.recorder).map(method => [method,
    input => f.recorder[method]({ ...input, ...scope })]));
  try {
    const { error, calls } = await publicationScenario(t, { usageRecorder, failure: 'local-after-publish' });
    assert.ok(error, 'The local binding cannot be written');
    assert.equal(calls.filter(endpoint => endpoint.endsWith('/publish')).length, 1);
    assert.equal(f.events()[0].status, 'succeeded');
    assert.equal(f.events()[0].published_at, publishedAt);
    assert.equal(f.rows()[0].status, 'confirmed');
  } finally { f.database.close(); }
});
