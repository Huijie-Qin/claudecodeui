import assert from 'node:assert/strict';
import test from 'node:test';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';
import { migrateIntegrationId } from '../database/ai-dashboard-integration-schema.js';

import { fixture } from './ai-usage-test-fixture.js';
import { projectIntegrationRow, shanghaiReportTime, buildIntegrationCandidate } from './ai-dashboard-integration.js';
import { createAiUsageStore } from './ai-usage-db.js';
import { runAiUsageWindow } from './ai-usage-batches.js';
import { readAiUsageConfig } from './ai-usage-config.js';
import { buildSplitCandidate } from './ai-dashboard-split.js';

const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
const night = day => () => new Date(`2026-09-${day}T18:10:00.000Z`);
const coverage = { activeUsers: 'complete', hooks: 'complete', duration: 'complete', skillPublications: 'complete', skillInvocations: 'complete', codeSubmissions: 'complete' };
const old = (dataset, value = {}, extra = {}) => ({ tenant_id: 10, dataset, row_key: 'source-1', stat_date: '2026-09-12',
  user_id: 3, workspace_id: 7, subject_id: 'subject-1', session_key: 'session-1', occurred_at: '2026-09-11T16:01:02.987Z', value_json: JSON.stringify(value), ...extra });
const project = row => projectIntegrationRow(row, '2026-09-13 02:10:00');

test('scalar projection preserves sparse types, Shanghai timestamps, source identities and publisher/caller roles', () => {
  assert.equal(shanghaiReportTime('2026-09-11T16:01:02.987Z'), '2026-09-12 00:01:02');
  assert.equal(shanghaiReportTime('2026-09-12T00:01:02+08:00'), '2026-09-12 00:01:02');
  assert.throws(() => shanghaiReportTime('2026-09-12 00:01:02'), /AMBIGUOUS/);
  const turn = project(old('turns', { status: 'completed', durationMs: 1234 }));
  assert.equal(turn.ai_active_duration_ms, 1234);
  assert.equal(turn.has_ai_interaction, null); assert.equal(turn.submitted_code_lines, null);
  assert.equal(turn.id, project(old('turns', { status: 'completed', durationMs: 4321 })).id);
  assert.equal(project(old('turns', { status: 'pending' })), null);
  assert.equal(project(old('hook_executions')), null);
  assert.equal(project(old('template_applications')), null);
  const invocation = project(old('skill_invocations', { publisherUserId: 3, callerUserId: 4, userName: 'publisher', callerUserName: 'caller' }));
  assert.equal(invocation.user_id, 4); assert.equal(invocation.publisher_user_id, 3);
  assert.equal(invocation.user_name, 'caller'); assert.equal(invocation.publisher_user_name, 'publisher');
  assert.equal(project(old('skill_invocations', {})).user_id, null);
  const fields = value => ({ recordType: 'sql_response_metrics', fields: [{ key: 'sqlLineCount', type: 'number', value }] });
  assert.equal(project(old('hook_records', fields(0))).generated_sql_lines, 0);
  for (const value of [null, '50', -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.equal(project(old('hook_records', fields(value))).generated_sql_lines, null);
  assert.equal(project(old('hook_records', { ...fields(50), recordType: 'another_type' })), null);
  assert.throws(() => project(old('hook_records', { ...fields(50), fields: [...fields(50).fields, ...fields(50).fields] })), /DUPLICATE/);
  assert.equal(project(old('code_submissions', { submittedLines: 50 })).submitted_code_lines, 50);
});

test('core views read only the new facts; Hook and Agent views still read the old report', t => {
  const f = fixture(t); f.batch('batch-1', 10, 'published', coverage);
  f.row({ id: 'i', dataset: 'interactions', value: { templateId: 'template-1', templateName: 'Agent' } });
  f.row({ id: 'duration', dataset: 'turns', value: { status: 'completed', durationMs: 20 } });
  f.row({ id: 'pub', dataset: 'skill_publications', subjectId: 'skill-1', value: { skillName: 'Skill' } });
  f.row({ id: 'sql', dataset: 'hook_records', subjectId: 'hook-1', value: { hookName: 'SQL', recordType: 'sql_response_metrics', fields: [{ key: 'sqlLineCount', type: 'number', value: 41 }] } });
  f.row({ id: 'mr', dataset: 'code_submissions', value: { submittedLines: 50 } });
  const queries = [];
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => { queries.push(sql); return prepare(sql); };
  assert.equal(f.queryService.summary(f.access).sessionCount, 1);
  assert.equal(f.queryService.analysis(f.access).summary.activeDurationMs, 20);
  assert.equal(f.queryService.skills(f.access).summary.publishedSkillCount, 1);
  assert.equal(f.queryService.code(f.access).summary.generatedLines, 41);
  assert.ok(queries.every(sql => !sql.includes('ai_usage_report_rows')));
  f.db.prepare = prepare;
  // Mutate only the old report in this adversarial test: core values cannot follow it.
  f.db.exec("DELETE FROM ai_usage_report_rows WHERE dataset='interactions'; UPDATE ai_usage_report_rows SET value_json=json_set(value_json,'$.submittedLines',999) WHERE dataset='code_submissions'");
  assert.equal(f.queryService.summary(f.access).sessionCount, 1);
  assert.equal(f.queryService.code(f.access).summary.submittedLines, 50);
  assert.equal(f.queryService.analysis(f.access, { dataset: 'templates' }).summary.sessionCount, 0);
  assert.equal(f.queryService.hookRecords(f.access, 'hook-1').total, 1);
});

test('code filters, server-side totals, pagination and records use one population; nulls remain unknown', t => {
  const f = fixture(t); f.batch('batch-1', 10, 'published', coverage);
  f.row({ id: 'sql', dataset: 'hook_records', value: { recordType: 'sql_response_metrics', fields: [{ key: 'sqlLineCount', type: 'number', value: 41 }] } });
  f.row({ id: 'mr1', dataset: 'code_submissions', value: { submittedLines: 50 } });
  f.row({ id: 'mr2', dataset: 'code_submissions', userId: 4, workspaceId: 8, date: '2026-09-12', value: { submittedLines: 40 } });
  f.row({ id: 'mr3', dataset: 'code_submissions', userId: 2, date: '2026-09-12', value: { submittedLines: null } });
  const result = f.queryService.code(f.access, { pageSize: 1, sortBy: 'submittedLines' });
  assert.equal(result.items.length, 1); assert.equal(result.total, 3);
  assert.equal(result.summary.submittedLines, 90); assert.equal(result.summary.generatedLines, 41);
  assert.equal(result.summary.unknownSubmissions, 1);
  assert.equal(f.queryService.code(f.access, { userId: 2 }).summary.submittedLines, null);
  assert.equal(f.queryService.code(f.access, { userSearch: 'another-member' }).summary.submittedLines, 40);
  assert.equal(f.queryService.code(f.access, { workspaceId: 7 }).summary.submittedLines, 50);
  assert.equal(f.queryService.code(f.access, { from: '2026-09-12' }).summary.generatedLines, 0);
  const pages = [1,2,3].flatMap(page => f.queryService.code(f.access, { pageSize: 1, page }).items);
  assert.equal(new Set(pages.map(row => row.groupKey)).size, 3);
  const detail = f.queryService.codeRecords(f.access, { groupBy: 'user', groupKey: '4' });
  assert.equal(detail.total, 1); assert.equal(detail.items[0].submissionId, 'mr2');
  assert.equal(detail.items[0].occurredAt, '2026-09-12T18:00:00+08:00');
  assert.throws(() => f.queryService.code(f.access, { groupBy: 'provider' }), { code: 'invalidFilter' });
  assert.throws(() => f.queryService.code(f.accessService.resolve({ tenantId: 10, userId: 3 }), { userId: 4 }), { statusCode: 403 });
});

test('MR bootstrap and increments take additions only when merged, using merged_at Shanghai date; correction/deletion are idempotent', async t => {
  const f = fixture(t);
  f.db.exec(`CREATE TABLE session_index(tenant_id,workspace_id,user_id,provider,provider_session_id);
    CREATE TABLE agent_session_runtime(tenant_id,workspace_id,user_id,provider,provider_session_id,runtime_id,runtime_home_path);
    CREATE TABLE ai_mr_submissions(id INTEGER PRIMARY KEY,tenant_id,user_id,workspace_id,repository_url,commit_sha,additions,deletions,status,merged_at,created_at);
    INSERT INTO ai_mr_submissions VALUES
      (1,10,3,7,'repo','same-sha',50,900,'merged','2026-09-11T16:01:00Z','2026-09-01 00:00:00'),
      (2,10,3,7,'repo','pending',500,0,'opened',NULL,'2026-09-11 00:00:00'),
      (3,10,4,8,'repo','same-sha',40,0,'merged','2026-09-12T03:00:00Z','2026-09-01 00:00:00'),
      (4,20,3,7,'repo','foreign',10000,0,'merged','2026-09-11T01:00:00Z','2026-09-01 00:00:00'),
      (5,10,3,7,'repo','future',20,0,'merged','2026-09-12T16:01:00Z','2026-09-01 00:00:00');`);
  migrateAiUsageSchema(f.db);
  const run = day => runAiUsageWindow({ database: f.db, config, now: night(day) });
  assert.equal((await run(12)).published, 2);
  assert.equal(f.queryService.code(f.access).summary.submittedLines, 90);
  assert.deepEqual(f.db.prepare('SELECT code_submission_id,stat_date,occurred_at,submitted_code_lines FROM ai_dashboard_integration_detail WHERE tenant_id=10 ORDER BY code_submission_id').all(), [
    { code_submission_id: '1', stat_date: '2026-09-12', occurred_at: '2026-09-12 00:01:00', submitted_code_lines: 50 },
    { code_submission_id: '3', stat_date: '2026-09-12', occurred_at: '2026-09-12 11:00:00', submitted_code_lines: 40 },
  ]);
  const sumOld = () => f.db.prepare("SELECT SUM(json_extract(value_json,'$.submittedLines')) AS n FROM ai_usage_report_rows WHERE tenant_id=10 AND dataset='code_submissions'").get().n;
  assert.equal(sumOld(), 90);
  f.db.exec("UPDATE ai_mr_submissions SET additions=40 WHERE id=1; UPDATE ai_mr_submissions SET status='merged',merged_at='2026-09-13T01:00:00Z' WHERE id=2; DELETE FROM ai_mr_submissions WHERE id=3");
  assert.equal(f.queryService.code(f.access).summary.submittedLines, 90, 'business changes do not leak into published metrics');
  assert.equal((await run(13)).published, 2);
  assert.equal(f.queryService.code(f.access).summary.submittedLines, 560);
  assert.equal(sumOld(), 560);
  assert.equal((await run(13)).published, 0);
  assert.equal((await run(14)).published, 2);
  assert.equal(sumOld(), 560);
  f.db.exec("UPDATE ai_mr_submissions SET status='closed' WHERE id=2");
  await run(15);
  assert.equal(sumOld(), 60); assert.equal(f.queryService.code(f.access).summary.submittedLines, 60);
  f.db.exec(`INSERT INTO ai_mr_submissions VALUES
    (6,10,3,7,'repo','invalid-time',5000,0,'merged',NULL,'2026-09-01 00:00:00'),
    (7,10,3,7,'repo','unknown-additions',NULL,0,'merged','2026-09-13T01:00:00Z','2026-09-01 00:00:00')`);
  await run(16);
  const partial = f.queryService.code(f.access);
  assert.equal(partial.coverage.submittedCode, 'partial');
  assert.equal(partial.summary.submittedLines, 60);
  assert.equal(partial.summary.unknownSubmissions, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ai_dashboard_integration_detail WHERE tenant_id=10 AND code_submission_id='6'").get().n, 0);
});

test('new-table insertion failure rolls back BOTH formal tables and metadata; prepared candidate resumes safely', async t => {
  const f = fixture(t); f.batch('batch-1', 10, 'published', coverage);
  f.row({ id: 'original', dataset: 'interactions' });
  const store = createAiUsageStore(f.db, { clock: night(13) });
  const batch = store.claim(10, { scheduledFor: '2026-09-13T18:00:00Z', targetThrough: '2026-09-13T16:00:00Z' }, config);
  const progress = { stage: 'integration' };
  store.initializeStaging(batch, progress, config);
  f.row({ id: 'next', dataset: 'interactions', sessionKey: 'second-session', batchId: batch.id });
  let checks = 0;
  await assert.rejects(buildIntegrationCandidate({ store, batch, progress, config: { ...config, batchSize: 1 }, checkpoint: async () => {}, checkWindow: () => { if (++checks === 2) throw new Error('pause'); } }), /pause/);
  assert.equal(f.queryService.summary(f.access).sessionCount, 1);
  await buildIntegrationCandidate({ store, batch, progress, config, checkpoint: async () => {}, checkWindow: () => {} });
  progress.integration.ready = true;
  await buildSplitCandidate({ store, batch, progress, config, checkpoint: async () => {}, checkWindow: () => {} });
  progress.stage = 'publish'; store.checkpoint(batch, progress, config);
  const oldRows = f.db.prepare('SELECT * FROM ai_usage_report_rows').all();
  const newRows = f.db.prepare('SELECT * FROM ai_dashboard_integration_detail').all();
  f.db.exec("CREATE TRIGGER fail_integration BEFORE INSERT ON ai_dashboard_integration_detail BEGIN SELECT RAISE(ABORT,'integration failure'); END");
  assert.throws(() => store.publish(batch, coverage), /integration failure/);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_usage_report_rows').all(), oldRows);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_dashboard_integration_detail').all(), newRows);
  assert.equal(f.queryService.status(f.access).batchId, 'batch-1');
  f.db.exec('DROP TRIGGER fail_integration');
  store.publish(batch, coverage);
  assert.equal(f.queryService.summary(f.access).sessionCount, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_integration_staging').get().n, 0);
  assert.equal(f.db.prepare('SELECT DISTINCT refreshed_at FROM ai_dashboard_integration_detail').get().refreshed_at, '2026-09-14 02:10:00');
  assert.equal(f.db.prepare('PRAGMA table_info(ai_dashboard_integration_detail)').all().some(c => ['dataset','value_json','partition_id'].includes(c.name)), false);
});

test('id rename preserves published/staged values, is idempotent, and keeps live legacy previews readable', t => {
  const f = fixture(t); f.batch('batch-1', 10, 'published', coverage);
  f.row({ id: 'rename-interaction', dataset: 'interactions' });
  f.row({ id: 'rename-sql', dataset: 'hook_records', value: { recordType: 'sql_response_metrics', fields: [{ key: 'sqlLineCount', type: 'number', value: 41 }] } });
  f.db.exec("INSERT INTO ai_dashboard_integration_staging SELECT 'prepared-batch',d.* FROM ai_dashboard_integration_detail d");
  const published = f.db.prepare('SELECT * FROM ai_dashboard_integration_detail ORDER BY id').all();
  const staged = f.db.prepare('SELECT * FROM ai_dashboard_integration_staging ORDER BY id').all();
  const old = f.db.prepare('SELECT * FROM ai_usage_report_rows ORDER BY row_key').all();
  f.db.exec(`ALTER TABLE ai_dashboard_integration_detail RENAME COLUMN id TO detail_id;
    ALTER TABLE ai_dashboard_integration_staging RENAME COLUMN id TO detail_id;`);
  assert.equal(f.queryService.summary(f.access).sessionCount, 1, 'read-only legacy column compatibility');
  assert.equal(f.queryService.code(f.access).summary.generatedLines, 41);
  f.db.exec("INSERT INTO ai_usage_worker_lock(id,lease_until) VALUES(1,'2999-01-01T00:00:00.000Z')");
  assert.throws(() => migrateIntegrationId(f.db), /WORKER_ACTIVE/);
  assert.ok(f.db.prepare('PRAGMA table_info(ai_dashboard_integration_detail)').all().some(column => column.name === 'detail_id'));
  f.db.exec('DELETE FROM ai_usage_worker_lock');
  migrateAiUsageSchema(f.db); migrateAiUsageSchema(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_dashboard_integration_detail ORDER BY id').all(), published);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_dashboard_integration_staging ORDER BY id').all(), staged);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_usage_report_rows ORDER BY row_key').all(), old);
  assert.equal(f.queryService.summary(f.access).sessionCount, 1);
  assert.equal(f.queryService.code(f.access).summary.generatedLines, 41);
  assert.equal(f.queryService.status(f.access).batchId, 'batch-1');
});
