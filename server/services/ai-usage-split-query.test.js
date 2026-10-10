import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';
import { splitReportCte } from './ai-dashboard-split-query.js';
import { integrationReportCte } from './ai-dashboard-integration-query.js';

const coverage = { activeUsers: 'complete', generatedSql: 'partial', duration: 'complete', hooks: 'complete', hookExecutions: 'complete',
  skillPublications: 'complete', skillInvocations: 'complete', templates: 'complete', codeSubmissions: 'complete' };

function seed(t) {
  const f = fixture(t);
  f.batch('batch-1', 10, 'published', coverage);
  f.db.exec("INSERT INTO workspaces VALUES(7,10,'研发工作区','active'),(8,10,'产品工作区','active')");
  f.row({ id: 'interaction', dataset: 'interactions', value: { templateId: 'agent', templateName: 'Agent' } });
  f.row({ id: 'interaction-2', dataset: 'interactions', date: '2026-09-12' });
  f.row({ id: 'duration-1', dataset: 'turns', value: { status: 'completed', durationMs: 100 } });
  f.row({ id: 'duration-2', dataset: 'turns', value: { status: 'completed', durationMs: 200 } });
  f.row({ id: 'duration-3', dataset: 'turns', date: '2026-09-12', value: { status: 'completed', durationMs: 1234 } });
  f.row({ id: 'duration-only', dataset: 'turns', userId: 4, workspaceId: 8, sessionKey: 'no-new-interaction', value: { status: 'completed', durationMs: 2000 } });
  f.row({ id: 'pub', dataset: 'skill_publications', subjectId: 'skill-a', date: '2024-01-01', value: { skillName: 'Skill A', publisherUserId: 3 } });
  f.row({ id: 'pub-new', dataset: 'skill_publications', subjectId: 'skill-b', value: { skillName: 'Skill B', publisherUserId: 3 } });
  f.row({ id: 'call', dataset: 'skill_invocations', subjectId: 'skill-a', value: { skillName: 'Skill A', publisherUserId: 3, callerUserId: 4 } });
  f.row({ id: 'hook-record', dataset: 'hook_records', subjectId: 'hook-sql', value: { hookName: 'SQL', recordType: 'sql_response_metrics', fields: [{ key: 'sqlLineCount', type: 'number', value: 900 }] } });
  f.row({ id: 'sql', dataset: 'sql_generations', value: { generatedLines: 41 } });
  f.row({ id: 'sql-unknown', dataset: 'sql_generations', userId: 4, workspaceId: 8, value: { generatedLines: null } });
  f.row({ id: 'code', dataset: 'code_submissions', value: { submittedLines: 50, repositoryUrl: 'repo', commitSha: 'sha' } });
  f.row({ id: 'code-unknown', dataset: 'code_submissions', userId: 4, workspaceId: 8, value: { submittedLines: null } });
  f.row({ id: 'execution', dataset: 'hook_executions', subjectId: 'hook-sql', value: { hookName: 'SQL', status: 'succeeded', durationMs: 20 } });
  return f;
}

function coreViews(f, filters = {}) {
  const q = f.queryService; const a = f.access;
  return {
    summary: q.summary(a, filters), overview: q.overview(a, filters), trend: q.trend(a, filters), users: q.users(a, filters),
    usage: ['user', 'workspace', 'day', 'week', 'month'].map(groupBy => q.analysis(a, { ...filters, groupBy })),
    skills: ['skill', 'publisher'].map(groupBy => q.skills(a, { ...filters, groupBy })),
    code: ['user', 'workspace', 'day', 'week', 'month'].map(groupBy => q.code(a, { ...filters, groupBy })),
    records: q.codeRecords(a, filters),
  };
}

test('five-table queries preserve wide-table results across filters, groups, summaries, trends and all export pages', t => {
  const f = seed(t); const prepare = f.db.prepare.bind(f.db);
  for (const filters of [{}, { userId: 3 }, { workspaceId: 8 }, { userSearch: 'member', workspaceSearch: '研发' },
    { from: '2026-09-12', to: '2026-09-12' }, { from: '2026-08-01', to: '2026-08-30' }, { pageSize: 1, page: 2 }]) {
    const actual = coreViews(f, filters);
    // Test-only reference to the previous query. Never a runtime fallback.
    f.db.prepare = sql => prepare(sql.replace(splitReportCte, integrationReportCte).replace('FROM split_report r', 'FROM integration_report r'));
    let expected;
    try { expected = coreViews(f, filters); } finally { f.db.prepare = prepare; }
    assert.deepEqual(actual, expected, JSON.stringify(filters));
  }
  assert.equal(f.queryService.overview(f.access).activeDurationMs, 3534);
  assert.equal(f.queryService.summary(f.access).sessionCount, 1, 'one session across two days');
  assert.equal(f.queryService.summary(f.access).mau, 1, 'duration-only rows cannot create active users');
  assert.equal(f.queryService.skills(f.access).summary.invocationCount, 1);
  assert.equal(f.queryService.skills(f.access, { userId: 4 }).total, 0, 'Skill contribution belongs to publisher, not caller');
});

test('every core metric query reads only the five topic tables, never old/wide/raw facts; Hook and Agent stay on old report', t => {
  const f = seed(t); const before = coreViews(f);
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    assert.doesNotMatch(sql, /\b(ai_usage_report_rows|ai_dashboard_integration_detail|ai_usage_fact_rows|ai_mr_submissions|ai_session_summary)\b/);
    return prepare(sql);
  };
  try { assert.deepEqual(coreViews(f), before); } finally { f.db.prepare = prepare; }
  f.db.exec(`DELETE FROM ai_usage_report_rows WHERE dataset='interactions';
    UPDATE ai_usage_report_rows SET value_json=json_set(value_json,'$.submittedLines',999) WHERE dataset='code_submissions';
    DELETE FROM ai_dashboard_integration_detail;`);
  assert.deepEqual(coreViews(f), before, 'neither old nor wide edits can affect published topic-table metrics');
  assert.equal(f.queryService.analysis(f.access, { dataset: 'templates' }).summary.sessionCount, 0);
  assert.equal(f.queryService.hookRecords(f.access, 'hook-sql').total, 1);
  assert.equal(f.queryService.hookExecutions(f.access).items[0].executionCount, 1);
  f.db.exec(`UPDATE ai_dashboard_ai_detail SET ai_active_duration_seconds=10 WHERE tenant_id=10 AND user_id=3 AND stat_date='2026-09-11';
    UPDATE ai_dashboard_sql_generation_detail SET generated_sql_lines=42 WHERE sql_record_id='sql';
    UPDATE ai_dashboard_code_submission_detail SET submitted_code_lines=40 WHERE code_submission_id='code';
    DELETE FROM ai_dashboard_skill_invocation_detail;
    DELETE FROM ai_dashboard_skill_publication_detail WHERE skill_id='skill-b';`);
  assert.equal(f.queryService.overview(f.access).activeDurationMs, 13234);
  assert.equal(f.queryService.code(f.access).summary.generatedLines, 42);
  assert.equal(f.queryService.code(f.access).summary.submittedLines, 40);
  assert.equal(f.queryService.skills(f.access).summary.invocationCount, 0);
  assert.equal(f.queryService.summary(f.access).publishedSkillCount, 1);
});

test('missing, obsolete or mismatched topic snapshots fail explicitly without fallback; empty published snapshots are valid', t => {
  const f = seed(t);
  for (const change of ["UPDATE ai_dashboard_split_state SET batch_id='stale'", 'UPDATE ai_dashboard_split_state SET schema_version=3', 'DELETE FROM ai_dashboard_split_state']) {
    f.db.exec(change);
    for (const method of ['summary', 'overview', 'trend', 'users', 'analysis', 'skills', 'code', 'codeRecords']) {
      assert.throws(() => f.queryService[method](f.access), { code: 'splitNotReady', statusCode: 409 }, method);
    }
    assert.equal(f.queryService.hookRecords(f.access, 'hook-sql').total, 1);
    assert.equal(f.queryService.analysis(f.access, { dataset: 'templates' }).summary.sessionCount, 1);
    f.db.exec("INSERT OR REPLACE INTO ai_dashboard_split_state VALUES(10,'batch-1',4)");
  }
  f.batch('empty', 20, 'published', coverage);
  const access = { ...f.access, tenantId: 20 };
  assert.equal(f.queryService.summary(access).sessionCount, 0);
  assert.equal(f.queryService.code(access).summary.generatedLines, 0);
  assert.equal(f.queryService.summary(f.access).sessionCount, 1, 'empty other tenant cannot change current tenant');
  f.db.exec('DROP TABLE ai_dashboard_split_state');
  assert.throws(() => f.queryService.summary(f.access), { code: 'splitNotReady' });
});

test('MAU includes pre-filter interaction history, excludes day-minus-30 and never uses duration-only days', t => {
  const f = fixture(t); f.batch('batch-1', 10, 'published', coverage);
  f.row({ id: 'edge', dataset: 'interactions', date: '2026-08-14' });
  f.row({ id: 'outside', dataset: 'interactions', date: '2026-08-13', userId: 4, sessionKey: 'outside' });
  f.row({ id: 'time', dataset: 'turns', date: '2026-09-12', userId: 2, sessionKey: 'duration-only', value: { status: 'completed', durationMs: 100 } });
  const oneDay = f.queryService.overview(f.access, { from: '2026-09-12', to: '2026-09-12' });
  assert.equal(oneDay.sessionCount, 0); assert.equal(oneDay.dau, 0); assert.equal(oneDay.mau, 1);
  assert.equal(oneDay.activeDurationMs, 100);
});
