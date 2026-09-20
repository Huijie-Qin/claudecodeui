import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import Database from 'better-sqlite3';

import { createAiUsageAccessService } from './ai-usage-access.js';
import { runAiUsageWindow } from './ai-usage-batches.js';
import { readAiUsageConfig } from './ai-usage-config.js';
import { createAiUsageQueryService } from './ai-usage-query.js';
import { seedAiUsageSimulation, simulationCounts, simulationNight } from './ai-usage-simulation-fixture.js';

test('3556 seeded business rows run through the real nightly pipeline and report queries', async (t) => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const counts = seedAiUsageSimulation(db);
  const tables = ['agent_session_messages','hook_executions','hook_data_records','ai_usage_turn_facts','ai_skill_publications','workspace_agent_template_snapshots'];
  assert.equal(tables.reduce((n, table) => n + db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0), counts.businessRows);
  assert.ok(counts.businessRows >= 1000);
  assert.throws(() => seedAiUsageSimulation(db), /fresh empty database/);
  const started = performance.now();
  const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
  const batch = await runAiUsageWindow({ database: db, config, now: simulationNight });
  assert.equal(batch.published, 1, JSON.stringify(batch));
  t.diagnostic(`Fixture raw rows=${counts.businessRows}; nightly=${Math.round(performance.now() - started)}ms (isolated fixture, not a production load test)`);
  const accessService = createAiUsageAccessService({ db });
  const access = accessService.resolve({ tenantId: 10, userId: 2, scope: 'tenant' });
  const self = accessService.resolve({ tenantId: 10, userId: 3, scope: 'self' });
  const query = createAiUsageQueryService({ db });
  await t.test('fixed cards use 30-day sessions, all-time confirmed publications and published-date activity', () => {
    const summary = query.summary(access);
    assert.deepEqual([summary.sessionCount, summary.publishedSkillCount, summary.dau, summary.mau], [601, 30, 4, 41]);
    assert.deepEqual(query.summary(access, { from: '2026-09-12', to: '2026-09-12', userId: 3, workspaceId: 7, search: 'none' }), summary);
    assert.equal(query.overview(access).publishedSkillCount, 0);
    assert.equal(query.summary(self).publishedSkillCount, 15);
  });
  await t.test('individual Skill counts include older publications, zero calls and distinct same-name IDs', () => {
    const result = query.skills(access, { pageSize: 100 });
    assert.equal(result.total, simulationCounts.skills);
    assert.equal(result.items.reduce((sum, row) => sum + row.invocationCount, 0), 600);
    assert.equal(result.items.find((row) => row.skillId === 'sim-skill-30').invocationCount, 0);
    assert.equal(result.items.filter((row) => row.skillName === 'SQL 分析').length, 2);
    assert.ok(result.items.every((row) => row.firstPublishedAt.startsWith('2026-08-01')));
    const page = query.skills(access, { page: 2, pageSize: 20 });
    assert.equal(page.items.length, 10);
    assert.ok(page.items.every((row) => !query.skills(access, { pageSize: 20 }).items.some((first) => first.skillId === row.skillId)));
    assert.equal(query.skills(access, { search: 'SQL 分析' }).total, 2);
    assert.ok(query.skills(self, { pageSize: 100 }).items.every((row) => row.publisherUserId === 3));
    assert.throws(() => query.skills(access, { sortBy: 'input_json' }), /sort/);
  });
  await t.test('DAU, MAU, cross-midnight duration and full-result sorting remain exact', () => {
    assert.equal(query.overview(access).sessionCount, 601);
    assert.equal(query.overview(access).activeDurationMs, 21900000);
    assert.equal(query.overview(access).dau, 4);
    assert.equal(query.overview(access).mau, 41);
    assert.equal(query.overview(self).activeDurationMs, 300000);
    assert.equal(query.overview(self).dau, 0);
    assert.equal(query.overview(self).mau, 1);
    assert.equal(query.analysis(access, { groupBy: 'day', pageSize: 1 }).summary.sessionCount, 601);
    const full = query.users(access, { sortBy: 'activeDurationMs', sortDir: 'asc', pageSize: 100 });
    const paged = [1, 2, 3].flatMap((page) => query.users(access, { sortBy: 'activeDurationMs', sortDir: 'asc', pageSize: 20, page }).items);
    assert.deepEqual(paged, full.items);
  });
  await t.test('unified usage table retains every former user row and keeps grouped totals unchanged', () => {
    const merged = query.analysis(access, { dataset: 'usage', groupBy: 'user', includeZeroUsers: true, pageSize: 100 });
    const old = query.users(access, { pageSize: 100 });
    assert.equal(merged.total, old.total);
    assert.equal(merged.total, 43);
    for (const user of old.items) {
      const row = merged.items.find((item) => item.groupKey === String(user.userId));
      assert.ok(row);
      for (const key of ['sessionCount', 'activeDurationMs']) assert.equal(row[key], user[key]);
    }
    assert.deepEqual([merged.summary.sessionCount, merged.summary.activeDurationMs, merged.summary.activeUserCount], [601, 21900000, 41]);
    assert.equal(query.skills(access, { groupBy: 'publisher' }).summary.invocationCount, 600);
    assert.equal(query.analysis(self, { dataset: 'usage', groupBy: 'user', includeZeroUsers: true }).total, 1);
  });
  await t.test('unified Hook and template tables preserve counts and record drilldowns across versions', () => {
    const executions = query.analysis(access, { dataset: 'hookExecutions', groupBy: 'hook', pageSize: 100 });
    assert.equal(executions.summary.executionCount, 1200);
    for (const hook of executions.items) {
      const records = query.hookExecutionRecords(access, hook.groupKey, { pageSize: 100 });
      assert.equal(records.total, hook.executionCount);
      assert.ok(records.items.every((row) => row.hookVersion != null && row.eventName));
    }
    const hooks = query.analysis(access, { dataset: 'hooks', groupBy: 'hook', pageSize: 100 });
    assert.equal(hooks.summary.recordCount, 1200);
    for (const hook of hooks.items) assert.equal(query.hookRecords(access, hook.groupKey).total, hook.recordCount);
    const byUser = query.analysis(access, { dataset: 'hooks', groupBy: 'user', pageSize: 1 });
    assert.equal(byUser.summary.recordCount, hooks.summary.recordCount);
    const templates = query.analysis(access, { dataset: 'templates', groupBy: 'template', pageSize: 100 });
    for (const template of templates.items) {
      assert.equal(query.templateApplications(access, template.groupKey).total, template.applicationCount);
      assert.equal(query.templateSessions(access, template.groupKey).total, template.sessionCount);
    }
  });
  await t.test('recording Hooks expose actual field statistics independently of execution statistics', () => {
    const fields = query.hookFieldStatistics(access, { pageSize: 100 });
    assert.equal(fields.total, 12);
    assert.equal(fields.aggregationSource, 'daily');
    assert.equal(fields.numericStatisticsVersion, 1);
    assert.ok(fields.items.every((field) => ['sum','average','min','max'].every((key) => Number.isFinite(field[key]))));
    const score = fields.items.find((field) => field.hookId === 'hook-session-a' && field.hookVersion === 1 && field.key === 'qualityScore');
    assert.deepEqual(['validCount','sum','average','min','max'].map((key) => score[key]), [200, 17800, 89, 80, 98]);
    const a = fields.items.filter((row) => row.hookId === 'hook-session-a' && row.key === 'recordCount');
    assert.equal(a.length, 2);
    assert.equal(a.reduce((sum, row) => sum + row.sum, 0), 1200);
    assert.equal(query.hookFieldStatistics(access, { fieldKey: 'recordCount' }).total, 2);
    assert.equal(query.hookFieldStatistics(access, { search: '会话记录 Hook' }).total, 8);
    const perUser = query.hookFieldStatistics(access, { groupBy: 'user', fieldKey: 'recordCount', pageSize: 100 });
    assert.equal(perUser.aggregationSource, 'daily');
    assert.equal(perUser.items.reduce((sum, row) => sum + row.sum, 0), 1200);
    assert.ok(perUser.items.every((row) => Number.isInteger(row.userId) && row.userName));
    const first = perUser.items[0];
    const userFilters = { recordUserId: String(first.userId), postActionId: first.postActionId, hookVersion: String(first.hookVersion), recordType: first.recordType, recordSource: first.recordSource };
    assert.equal(query.hookRecords(access, first.hookId, userFilters).total, first.validCount);
    assert.ok(query.hookRecords(access, first.hookId, userFilters).items.every((row) => row.userId === first.userId));
    const records = query.hookRecords(access, 'hook-session-a', { pageSize: 100 });
    assert.equal(records.total, 400);
    assert.ok(records.items.every((row) => row.fields.some((field) => field.key === 'result')));
    const executions = query.hookExecutions(access, { pageSize: 100 });
    assert.equal(executions.items.reduce((sum, row) => sum + row.executionCount, 0), 1200);
    assert.equal(executions.items.reduce((sum, row) => sum + row.failureCount, 0), 60);
    assert.equal(executions.items.reduce((sum, row) => sum + row.runningCount, 0), 60);
    assert.equal(query.hookExecutionRecords(access, 'hook-session-a', { executionStatus: 'failed' }).total, 20);
    assert.equal(JSON.stringify([fields, records, executions, query.hookExecutionRecords(access, 'hook-session-a')]).includes('SIMULATION_PRIVATE'), false);
  });
  await t.test('published endpoints do not query raw message, Hook or publication tables', () => {
    const forbidden = /\b(?:agent_session_messages|hook_data_records|hook_executions|ai_usage_turn_facts|ai_skill_publications)\b/;
    const guarded = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql) => {
        // A dataset literal is safe; a raw table in FROM/JOIN is not.
        const withoutStrings = sql.replace(/'[^']*'/g, "''");
        assert.equal(forbidden.test(withoutStrings), false, sql);
        return target.prepare(sql);
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const reader = createAiUsageQueryService({ db: guarded });
    assert.equal(reader.summary(access).publishedSkillCount, 30);
    const timings = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      reader.overview(access); reader.skills(access); reader.hookFieldStatistics(access, { groupBy: 'user' }); reader.hookExecutions(access); reader.analysis(access, { groupBy: 'week' });
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    t.diagnostic(`20 rounds × 5 queries; median=${Math.round(timings[10])}ms, p95=${Math.round(timings[18])}ms per round; metadata projections only`);
  });
  await t.test('late execution completion repairs the next nightly snapshot; deleted records disappear immediately', async () => {
    const oldBatch = query.status(access).batchId;
    db.prepare("UPDATE hook_executions SET status='succeeded',duration_ms=500,completed_at='2026-08-15T03:00:00.500Z',completed_at_ms=? WHERE id='exec-1'")
      .run(Date.parse('2026-08-15T03:00:00.500Z'));
    assert.equal(query.hookExecutions(access, { pageSize: 100 }).items.reduce((sum, row) => sum + row.runningCount, 0), 60);
    db.exec("DELETE FROM hook_data_records WHERE id='record-0'");
    assert.equal(query.hookRecords(access, 'hook-session-a').total, 399);
    assert.equal(query.hookFieldStatistics(access, { fieldKey: 'recordCount' }).items.reduce((sum, row) => sum + row.sum, 0), 1199);
    db.exec("DELETE FROM hook_executions WHERE id='exec-0'");
    assert.equal(query.hookExecutions(access, { pageSize: 100 }).items.reduce((sum, row) => sum + row.executionCount, 0), 1199);
    assert.equal((await runAiUsageWindow({ database: db, config, now: () => new Date('2026-09-13T18:10:00.000Z') })).published, 1);
    assert.notEqual(query.status(access).batchId, oldBatch);
    assert.equal(query.hookExecutions(access, { from: '2026-08-14', pageSize: 100 }).items.reduce((sum, row) => sum + row.runningCount, 0), 59);
    assert.throws(() => query.hookExecutions(access, { batchId: oldBatch, pageSize: 100 }), { code: 'reportUpdated' });
  });
});
