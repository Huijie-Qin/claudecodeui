import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { backfillSkillPublications } from '../../scripts/backfill-ai-skill-publications.mjs';
import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { runAiUsageWindow } from './ai-usage-batches.js';
import { readAiUsageConfig } from './ai-usage-config.js';
import { logicalSessionKey, parseUsageMessage } from './ai-usage-parser.js';
import { createAiUsageSkillContextRecorder } from './ai-usage-skill-context.js';
import { createAiUsageSkillRecorder } from './ai-usage-skills.js';
import { createAiUsageQueryService } from './ai-usage-query.js';
import { createAiUsageTurnRecorder } from './ai-usage-turns.js';

const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
const scope = { tenant_id: 1, user_id: 1, workspace_id: 10, provider: 'claude', provider_session_id: 'session-a' };

function userMessage(id, time = '2026-09-11T02:00:00.000Z', content = 'A real user request') {
  return { uuid: id, timestamp: time, type: 'user', message: { role: 'user', content } };
}

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ccui-usage-indexer-'));
  const project = path.join(home, '.claude', 'projects', 'project');
  await mkdir(project, { recursive: true });
  const database = new Database(':memory:');
  t.after(async () => { database.close(); await rm(home, { recursive: true, force: true }); });
  database.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,
      provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,message_id TEXT,provider_timestamp TEXT,created_at TEXT,normalized_json TEXT,
      runtime_id TEXT,sequence INTEGER);
    INSERT INTO tenants VALUES(1,'active');
    INSERT INTO users VALUES(1,'alice');
    INSERT INTO workspaces VALUES(10,1,'Example','active');
    INSERT INTO session_index VALUES(1,10,1,'claude','session-a'),(1,10,1,'claude','session-b');`);
  database.prepare("INSERT INTO agent_session_runtime VALUES(1,10,1,'claude','session-a','runtime-a',?)").run(home);
  migrateAiUsageSchema(database);
  let day = 11;
  const now = () => new Date(`2026-09-${day}T18:10:00.000Z`);
  const file = (sessionId) => path.join(project, `${sessionId}.jsonl`);
  const facts = () => database.prepare('SELECT * FROM ai_usage_fact_rows ORDER BY source_key,row_key').all();
  const report = () => database.prepare('SELECT * FROM ai_usage_report_rows WHERE tenant_id=1').all();
  return { database, file, facts, report, now, nextNight: () => { day++; },
    run: (options = {}) => runAiUsageWindow({ database, config, now, ...options }),
    write: (sessionId, messages) => writeFile(file(sessionId), `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`),
    append: (sessionId, message) => appendFile(file(sessionId), `${JSON.stringify(message)}\n`),
    addCopy(message) {
      const sequence = database.prepare('SELECT COUNT(*)+1 AS n FROM agent_session_messages').get().n;
      database.prepare(`INSERT INTO agent_session_messages
        (tenant_id,workspace_id,user_id,provider,provider_session_id,message_id,provider_timestamp,created_at,normalized_json,runtime_id,sequence)
        VALUES(1,10,1,'claude','session-a',?,?,?,?,'runtime-a',?)`).run(message.uuid, message.timestamp, message.timestamp, JSON.stringify(message), sequence);
    },
  };
}

test('publish events reach dashboard topics once, preserving workspace and excluding updates/failures', async (t) => {
  const f = await fixture(t);
  const publishedAt = '2026-09-11T02:00:00.000Z';
  const recorder = createAiUsageSkillRecorder({ database: f.database, now: () => publishedAt });
  const scope = { tenantId: 1, userId: 1, workspaceId: 10, skillName: 'Published Skill' };
  const create = { ...scope, operationId: 'create-click', publishKind: 'create', skillId: 'skill-a', publishedAt };
  recorder.beginPublishEvent(create);
  recorder.succeedPublishEvent(create);
  // First-upload compatibility capture and new click capture describe ONE publication.
  recorder.beginPublication(create);
  recorder.confirmed({ ...create, firstPublishedAt: publishedAt });
  for (const [id, status] of [['failed-click', 'failed'], ['unknown-click', 'unknown'], ['waiting-click', 'requested']]) {
    const event = { ...scope, operationId: id, publishKind: 'create', skillId: id };
    recorder.beginPublishEvent(event);
    if (status !== 'requested') recorder.failPublishEvent({ ...event, uncertain: status === 'unknown' });
  }
  const update = { ...create, operationId: 'update-click', publishKind: 'update', skillId: 'historical-skill' };
  recorder.beginPublishEvent(update);
  recorder.succeedPublishEvent(update);
  assert.equal((await f.run()).published, 1);
  const publications = f.report().filter(row => row.dataset === 'skill_publications');
  assert.equal(publications.length, 1);
  assert.equal(publications[0].workspace_id, 10);
  assert.equal(JSON.parse(publications[0].value_json).publicationEventId, 'create-click');
  const detail = f.database.prepare('SELECT * FROM ai_dashboard_skill_publication_detail').all();
  assert.equal(detail.length, 1);
  assert.equal(detail[0].skill_id, 'skill-a');
  assert.equal(detail[0].workspace_id, 10);
  const query = createAiUsageQueryService({ db: f.database });
  const access = { tenantId: 1, userId: 1, scope: 'tenant', canViewTenant: true };
  assert.equal(query.summary(access).publishedSkillCount, 1);
  assert.equal(query.skills(access, { workspaceId: 10 }).items[0].skillId, 'skill-a');

  // Once bootstrapped, INSERT/UPDATE triggers must pick up new clicks incrementally.
  f.nextNight();
  const second = { ...create, operationId: 'second-create', skillId: 'skill-b', publishedAt: '2026-09-12T02:00:00Z' };
  recorder.beginPublishEvent(second);
  recorder.succeedPublishEvent(second);
  recorder.succeedPublishEvent(second);
  assert.equal((await f.run()).published, 1);
  assert.equal(query.summary(access).publishedSkillCount, 2);
  const day = query.skills(access, { groupBy: 'publisher', from: '2026-09-12', to: '2026-09-12' });
  assert.equal(day.items[0].publishedSkillCount, 1);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_skill_publication_detail').get().n, 2);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM ai_skill_publish_events').get().n, 6);
});

test('canonical JSONL appearance retracts an unchanged DB copy and disappearance restores it', async (t) => {
  const f = await fixture(t);
  const legacy = userMessage('legacy-copy', '2026-09-10T02:00:00.000Z');
  f.addCopy(legacy);
  assert.equal((await f.run()).published, 1);
  assert.equal(f.facts().filter((row) => row.source_key === 'message:1' && row.dataset === 'interactions').length, 1);
  assert.deepEqual(f.report().filter((row) => row.dataset === 'interactions').map((row) => row.stat_date), ['2026-09-10']);

  // No UPDATE is issued for the DB copy. Discovering canonical history itself
  // must invalidate its old, differently identified/day-attributed fact.
  await f.write('session-a', [userMessage('canonical')]);
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(f.facts().filter((row) => row.source_key === 'message:1').length, 0);
  assert.equal(f.facts().filter((row) => row.source_key.startsWith('jsonl:') && row.dataset === 'interactions').length, 1);
  assert.deepEqual(f.report().filter((row) => row.dataset === 'interactions').map((row) => row.stat_date), ['2026-09-11']);

  await unlink(f.file('session-a'));
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(f.facts().filter((row) => row.source_key.startsWith('jsonl:')).length, 0);
  assert.equal(f.facts().filter((row) => row.source_key === 'message:1' && row.dataset === 'interactions').length, 1);
  assert.deepEqual(f.report().filter((row) => row.dataset === 'interactions').map((row) => row.stat_date), ['2026-09-10']);
  assert.equal(JSON.parse(f.database.prepare('SELECT state_json FROM ai_usage_source_states').get().state_json).readable, 0);

  await f.write('session-a', [userMessage('canonical-restored')]);
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(f.facts().filter((row) => row.source_key === 'message:1').length, 0);
  assert.equal(f.facts().filter((row) => row.source_key.startsWith('jsonl:') && row.dataset === 'interactions').length, 1);
});

test('file cursor resumes traversal without marking unvisited or previously visited histories missing', async (t) => {
  const f = await fixture(t);
  await f.write('session-a', [userMessage('a-first')]);
  await f.write('session-b', [userMessage('b-first')]);
  assert.equal((await f.run()).published, 1);
  const previousBatch = f.database.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id;
  f.nextNight();

  // Stop immediately after visit(a) atomically persists its cursor and seen bit,
  // before visit(b). Both retained histories must remain valid while paused.
  const paused = await f.run({ shouldStop: () => Boolean(f.database.prepare(`SELECT 1
    FROM ai_usage_batches b JOIN ai_usage_batch_files f ON f.batch_id=b.id
    WHERE b.status='running' AND b.id<>? AND f.source_key LIKE '%/session-a.jsonl'`).get(previousBatch)) });
  assert.equal(paused.status, 'paused');
  const batch = f.database.prepare("SELECT * FROM ai_usage_batches WHERE status='paused'").get();
  assert.equal(JSON.parse(batch.progress_json).fileCursor[2], 'session-a.jsonl');
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM ai_usage_batch_files WHERE batch_id=?').get(batch.id).n, 1);
  assert.equal(f.database.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id, previousBatch);
  assert.equal(f.facts().filter(row => row.dataset === 'interactions').length, 2);
  assert.ok(f.database.prepare('SELECT state_json FROM ai_usage_source_states').all()
    .every((row) => JSON.parse(row.state_json).readable));

  await f.append('session-a', userMessage('a-after-checkpoint'));
  await f.append('session-b', userMessage('b-not-yet-visited'));
  assert.equal((await f.run()).published, 1);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM ai_usage_batch_files WHERE batch_id=?').get(batch.id).n, 2);
  assert.ok(f.facts().some((row) => row.row_key.endsWith(':b-not-yet-visited')));
  assert.ok(!f.facts().some((row) => row.row_key.endsWith(':a-after-checkpoint')),
    'Already checkpointed files are not rescanned during resume; later appends wait for the next batch');
  assert.ok(f.database.prepare('SELECT state_json FROM ai_usage_source_states').all()
    .every((row) => JSON.parse(row.state_json).readable));

  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(f.facts().filter(row => row.dataset === 'interactions').length, 4);
  assert.ok(f.facts().some((row) => row.row_key.endsWith(':a-after-checkpoint')));
});

test('Hook and MCP internal user wrappers are not user interaction records', () => {
  for (const content of [
    '<ccui-hook-recovery>\nPerform the configured post-action.\n</ccui-hook-recovery>',
    '  <ccui-hook-recovery activity="record-1">\nPost-action\n</ccui-hook-recovery>',
    [{ type: 'text', text: '<ccui-mcp-loop-results count="2">\nTool results\n</ccui-mcp-loop-results>' }],
    '<ccui-mcp-loop-results>\nFinal tool result\n</ccui-mcp-loop-results>',
  ]) {
    assert.deepEqual(parseUsageMessage(scope, userMessage('internal', undefined, content), { timeZone: config.timeZone }), []);
  }
  const real = parseUsageMessage(scope, userMessage('real'), { timeZone: config.timeZone });
  assert.equal(real.length, 1);
  assert.equal(real[0].session_key, logicalSessionKey(scope));
  assert.equal(real[0].dataset, 'interactions');
});

function bindSkill(f, name = 'report') {
  f.database.prepare(`INSERT INTO ai_skill_binding_history
    (tenant_id,workspace_id,local_name,remote_skill_id,publisher_user_id,valid_from)
    VALUES(1,10,?,?,1,'2026-09-01T00:00:00.000Z')`).run(name, `market:${name}`);
}

function skillTool(id, time = '2026-09-11T02:01:00.000Z', name = 'report', toolName = 'Skill') {
  return { uuid: `assistant-${id}`, timestamp: time, type: 'assistant', message: {
    role: 'assistant', content: [{ type: 'tool_use', id, name: toolName, input: { skill: name } }],
  } };
}

const skillReport = (f) => f.report().filter((row) => row.dataset === 'skill_invocations')
  .map((row) => ({ ...row, value: JSON.parse(row.value_json) }));
const contextRecorder = (f) => createAiUsageSkillContextRecorder({ database: f.database,
  now: () => '2026-09-11T02:00:00.000Z', logger: { warn: (message) => assert.fail(message) } });
const contextScope = { tenantId: 1, userId: 1, workspaceId: 10, provider: 'claude', sessionId: 'session-a' };

test('forks and repeated forks count only new interactions, skills, tokens and active time', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  const turnRecorder = createAiUsageTurnRecorder({ database: f.database, now: f.now,
    logger: { warn: (message) => assert.fail(message) } });
  const ownTurn = (sessionId, start, seconds, total) => {
    const request = userMessage(`${sessionId}-request`, start, '/report');
    const end = new Date(Date.parse(start) + seconds * 1000).toISOString();
    const response = skillTool(`${sessionId}-tool`, end);
    Object.assign(response.message, { id: `${sessionId}-response`, stop_reason: 'tool_use',
      usage: { input_tokens: total - 1, output_tokens: 1 } });
    const identity = turnRecorder.start({ tenantId: 1, userId: 1, workspaceId: 10,
      provider: 'claude', sessionKey: sessionId, requestKey: request.uuid, startedAt: start });
    turnRecorder.complete({ ...identity, responseCompletedAt: end, terminalAt: end });
    const toolResult = { uuid: `${sessionId}-result`, timestamp: end, type: 'user', message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `${sessionId}-tool`, content: 'Completed' }] } };
    const final = { uuid: `${sessionId}-final`, timestamp: end, type: 'assistant', message: {
      id: `${sessionId}-final-response`, role: 'assistant', content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } };
    return [request, response, toolResult, final].map((message) => ({ ...message, sessionId }));
  };
  const inherited = (messages, sessionId, parentSessionId) => messages.map((message) => ({
    ...message, sessionId, uuid: `${sessionId}-${message.uuid}`,
    forkedFrom: message.forkedFrom || { sessionId: parentSessionId, messageUuid: message.uuid },
  }));
  const original = ownTurn('session-a', '2026-09-11T02:00:00.000Z', 60, 10);
  const copied = inherited(original, 'session-b', 'session-a');
  await f.write('session-a', original);
  await f.write('session-b', copied);
  const directory = path.join(path.dirname(f.file('session-b')), 'session-b');
  await mkdir(directory);
  await writeFile(path.join(directory, 'display-commands.jsonl'), `${JSON.stringify({
    messageId: copied[0].uuid, displayCommand: '/report', forkedFrom: copied[0].forkedFrom,
  })}\n`);
  assert.equal((await f.run()).published, 1);
  assert.deepEqual(f.database.prepare('SELECT session_id,total_tokens,ai_active_duration_seconds FROM ai_session_summary').all(), [
    { session_id: 'session-a', total_tokens: 10, ai_active_duration_seconds: 60 },
  ]);
  assert.equal(f.facts().filter((row) => row.session_key === logicalSessionKey({ ...scope,
    provider_session_id: 'session-b' })).length, 0, 'An unused fork has no usage facts, including sidecar evidence');

  const ownBranch = ownTurn('session-b', '2026-09-11T03:00:00.000Z', 120, 20);
  for (const message of ownBranch) await f.append('session-b', message);
  f.database.exec("INSERT INTO session_index VALUES(1,10,1,'claude','session-c')");
  await f.write('session-c', [
    ...inherited([...copied, ...ownBranch], 'session-c', 'session-b'),
    ...ownTurn('session-c', '2026-09-11T04:00:00.000Z', 180, 30),
  ]);
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(f.facts().filter((row) => row.dataset === 'interactions'
    && row.source_key.startsWith('jsonl:')).length, 3);
  assert.equal(skillReport(f).length, 3);
  assert.deepEqual(f.database.prepare(`SELECT session_id,total_tokens,ai_active_duration_seconds,start_time
    FROM ai_session_summary ORDER BY session_id`).all(), [
    { session_id: 'session-a', total_tokens: 10, ai_active_duration_seconds: 60, start_time: '2026-09-11 10:00:00' },
    { session_id: 'session-b', total_tokens: 20, ai_active_duration_seconds: 120, start_time: '2026-09-11 11:00:00' },
    { session_id: 'session-c', total_tokens: 30, ai_active_duration_seconds: 180, start_time: '2026-09-11 12:00:00' },
  ]);
});

test('legacy DB fallback excludes inherited normalized messages and keeps new branch events', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  f.addCopy({ ...userMessage('old-request', undefined, '/report'), inherited: true });
  f.addCopy({ ...skillTool('old-tool'), forkedFrom: { sessionId: 'parent', messageUuid: 'old-tool' } });
  f.addCopy(userMessage('new-request', undefined, '/report'));
  f.addCopy(skillTool('new-tool'));
  assert.equal((await f.run()).published, 1);
  assert.equal(f.facts().filter((row) => row.dataset === 'interactions').length, 1);
  assert.deepEqual(skillReport(f).map((row) => row.value.toolUseId), ['new-tool']);
});

test('late publication associates another user\'s historical slash/tool calls with the publisher at night', async (t) => {
  const f = await fixture(t);
  f.database.exec(`INSERT INTO users VALUES(2,'publisher');
    INSERT INTO ai_skill_binding_history(tenant_id,workspace_id,local_name,remote_skill_id,valid_from)
    VALUES(1,10,'report','remote-report','2026-09-01T00:00:00.000Z');
    INSERT INTO ai_skill_publications VALUES('publish',1,2,'remote-report','Report',NULL,
      'saved_pending_publish','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');`);
  await f.write('session-a', [userMessage('slash', undefined, '/report'), skillTool('tool'),
    userMessage('slash-only', '2026-09-11T03:00:00.000Z', '/report')]);
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 2);
  assert.ok(skillReport(f).every((row) => row.user_id === null && row.value.publisherUserId === null));
  // No transcript, context or binding changes: confirmation alone must dirty
  // calls made by user 1 in a workspace different from the publisher's own.
  f.database.exec(`UPDATE ai_skill_publications SET status='confirmed',first_published_at='2026-09-01T00:00:00.000Z'
    WHERE operation_id='publish'`);
  f.nextNight(); assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 2);
  assert.ok(skillReport(f).every((row) => row.user_id === 2 && row.value.publisherUserId === 2
    && row.value.callerUserId === 1 && row.value.userName === 'publisher' && row.value.callerUserName === 'alice'));
  assert.deepEqual(skillReport(f).map((row) => row.value.invocationKind).sort(), ['slash', 'tool']);
  assert.equal(f.report().filter((row) => row.dataset === 'skill_publications' && row.user_id === 2).length, 1);
  assert.equal(f.database.prepare(`SELECT COUNT(*) AS n FROM ai_usage_report_rows
    WHERE tenant_id=1 AND dataset='skill_invocations' AND user_id IS NULL`).get().n, 0);
  // A removed confirmation repairs the same historical dates, without double counting.
  f.database.exec("DELETE FROM ai_skill_publications WHERE operation_id='publish'");
  f.nextNight(); assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 2);
  assert.ok(skillReport(f).every((row) => row.user_id === null));
});

test('slash and native Skill are correlated without merging distinct tool calls or counting Read/Bash', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  await f.write('session-a', [userMessage('slash', undefined, '/report private arguments'),
    skillTool('one'), skillTool('two'), skillTool('read', undefined, 'report', 'Read'),
    skillTool('bash', undefined, 'report', 'Bash'), userMessage('builtin', undefined, '/help')]);
  const result = await f.run();
  assert.equal(result.published, 1, JSON.stringify(result));
  assert.deepEqual(skillReport(f).map((row) => row.value.toolUseId).sort(), ['one', 'two']);
  assert.ok(f.report().every((row) => row.dataset !== 'skill_evidence'));
  assert.ok(f.facts().filter((row) => row.dataset === 'skill_evidence').every((row) => !row.value_json.includes('private arguments')));
});

test('late native Skill replaces a slash-only invocation and repairs both historical dates', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  await f.write('session-a', [userMessage('slash', '2026-09-11T15:59:00.000Z', '/report')]);
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f)[0].value.invocationKind, 'slash');
  const firstKey = skillReport(f)[0].row_key;
  await f.append('session-a', skillTool('late', '2026-09-11T16:01:00.000Z'));
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 1);
  assert.equal(skillReport(f)[0].value.toolUseId, 'late');
  assert.equal(skillReport(f)[0].stat_date, '2026-09-12');
  assert.notEqual(skillReport(f)[0].row_key, firstKey);
  assert.ok(!skillReport(f).some((row) => row.stat_date === '2026-09-11'));
});

test('Hook origin survives file checkpoints and a subsequent real user restores user origin', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  await f.write('session-a', [userMessage('hook', undefined, '<ccui-hook-recovery>internal</ccui-hook-recovery>')]);
  await f.run();
  await f.append('session-a', skillTool('internal'));
  await f.append('session-a', userMessage('real', '2026-09-11T03:00:00.000Z', '/report'));
  await f.append('session-a', skillTool('real-tool', '2026-09-11T03:01:00.000Z'));
  f.nextNight();
  const result = await f.run();
  assert.equal(result.published, 1, JSON.stringify(result));
  assert.deepEqual(skillReport(f).map((row) => row.value.toolUseId), ['real-tool']);
});

test('database fallback correlates slash/tool and excludes tools following a Hook boundary', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  f.addCopy(userMessage('slash', undefined, '/report'));
  f.addCopy(skillTool('user-tool'));
  f.addCopy(userMessage('hook', '2026-09-11T03:00:00.000Z', '<ccui-hook-recovery>private</ccui-hook-recovery>'));
  f.addCopy(skillTool('hook-tool', '2026-09-11T03:01:00.000Z'));
  const result = await f.run();
  assert.equal(result.published, 1, JSON.stringify(result));
  assert.deepEqual(skillReport(f).map((row) => row.value.toolUseId), ['user-tool']);
});

test('late trusted Hook and Graph/Top session metadata retract unchanged raw tool facts', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  await f.write('session-a', [skillTool('main')]);
  await f.write('session-b', [skillTool('graph')]);
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 2);
  const recorder = contextRecorder(f);
  recorder.recordTool({ ...contextScope, contextId: 'main', requestId: null,
    origin: 'hook', skillName: 'report', occurredAt: '2026-09-11T02:01:00.000Z' });
  recorder.recordSession({ ...contextScope, sessionId: 'session-b', contextId: 'session:session-b', origin: 'agent_graph' });
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 0);
  recorder.recordTool({ ...contextScope, sessionId: 'top-session', contextId: 'top-tool', origin: 'user', skillName: 'report' });
  recorder.recordSession({ ...contextScope, sessionId: 'top-session', contextId: 'session:top-session', origin: 'top_skill' });
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 0);
});

test('display-command metadata waits for a real message timestamp and never uses file mtime', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  await writeFile(f.file('session-a'), '');
  const directory = path.join(path.dirname(f.file('session-a')), 'session-a');
  await mkdir(directory);
  await writeFile(path.join(directory, 'display-commands.jsonl'), `${JSON.stringify({
    messageId: 'display-id', displayCommand: '/report private arguments',
  })}\n`);
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 0);
  await f.append('session-a', userMessage('display-id', '2026-09-11T02:00:00.000Z', 'Expanded model content'));
  f.nextNight();
  const result = await f.run();
  assert.equal(result.published, 1, JSON.stringify(result));
  assert.equal(skillReport(f).length, 1);
  assert.equal(skillReport(f)[0].occurred_at, '2026-09-11T02:00:00.000Z');
});

test('context-only slash candidates become countable after a historical binding is confirmed', async (t) => {
  const f = await fixture(t);
  contextRecorder(f).recordRequest({ ...contextScope, contextId: 'request', requestId: 'request',
    origin: 'user', skillName: 'report' });
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 0);
  bindSkill(f);
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 1);
});

test('large conversation Skill metadata pages resume from staged source references', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  await f.write('session-a', Array.from({ length: 25 }, (_, index) => [
    userMessage(`request-${index}`, undefined, '/report'), skillTool(`tool-${index}`),
  ]).flat());
  const small = { ...config, batchSize: 3 };
  const result = await f.run({ config: small, shouldStop: () => {
    const row = f.database.prepare("SELECT progress_json FROM ai_usage_batches WHERE status='running'").get();
    const current = row && JSON.parse(row.progress_json).skillSession;
    return current?.phase === 'evidence' && current.cursor[0] !== '';
  } });
  assert.equal(result.status, 'paused');
  const paused = f.database.prepare("SELECT * FROM ai_usage_batches WHERE status='paused'").get();
  const saved = JSON.parse(paused.progress_json);
  assert.ok(saved.skillSession.cursor[0]);
  assert.ok(f.database.prepare('SELECT COUNT(*) AS n FROM ai_usage_skill_work_items WHERE batch_id=?').get(paused.id).n > 0);
  assert.ok(paused.progress_json.length < 2000, 'Progress must not serialize the complete evidence array');
  assert.equal((await f.run({ config: small })).published, 1);
  assert.equal(skillReport(f).length, 25);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM ai_usage_skill_work_items').get().n, 0);
});

test('database boundaries use provider sequence rather than UUID ordering for equal timestamps', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  f.addCopy(userMessage('z-user', undefined, '/report'));
  f.addCopy(skillTool('first', '2026-09-11T02:00:00.000Z'));
  f.addCopy(userMessage('a-hook', undefined, '<ccui-hook-recovery>internal</ccui-hook-recovery>'));
  f.addCopy(skillTool('hook-tool', '2026-09-11T02:00:00.000Z'));
  // A future request with the same timestamp must not taint preceding tools.
  f.addCopy(userMessage('zz-last', undefined, 'Another request'));
  assert.equal((await f.run()).published, 1);
  assert.deepEqual(skillReport(f).map((row) => row.value.toolUseId), ['first']);
});

test('calculation upgrade reindexes and withdraws legacy direct native-tool facts', async (t) => {
  const f = await fixture(t);
  bindSkill(f);
  await f.write('session-a', [skillTool('native')]);
  assert.equal((await f.run()).published, 1);
  const rawSource = f.database.prepare('SELECT source_key FROM ai_usage_source_states LIMIT 1').get().source_key;
  f.database.prepare(`INSERT INTO ai_usage_fact_rows
    SELECT tenant_id,?,dataset,'legacy-tool-key',stat_date,user_id,workspace_id,subject_id,session_key,occurred_at,value_json,30
    FROM ai_usage_fact_rows WHERE dataset='skill_invocations' LIMIT 1`).run(rawSource);
  f.database.prepare("UPDATE ai_usage_tenant_state SET calculation_version='request_response_interval_v1'").run();
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 1);
  assert.ok(!f.facts().some((row) => row.row_key === 'legacy-tool-key'));
});

test('fork accounting upgrade retracts already indexed inherited interactions from unchanged files', async (t) => {
  const f = await fixture(t);
  const source = userMessage('original');
  const copy = { ...userMessage('fork-copy'), forkedFrom: { sessionId: 'session-a', messageUuid: source.uuid } };
  await f.write('session-a', [source]);
  await f.write('session-b', [copy]);
  assert.equal((await f.run()).published, 1);
  const forkSource = f.database.prepare("SELECT source_key FROM ai_usage_source_states WHERE source_key LIKE '%/session-b.jsonl'").get().source_key;
  const forkScope = { ...scope, provider_session_id: 'session-b' };
  // Reproduce the pre-upgrade fact while preserving the indexed file fingerprint.
  const [oldFact] = parseUsageMessage(forkScope, { ...copy, forkedFrom: undefined }, { timeZone: config.timeZone });
  f.database.prepare(`INSERT INTO ai_usage_fact_rows
    (tenant_id,source_key,dataset,row_key,stat_date,user_id,workspace_id,session_key,occurred_at,value_json,priority)
    VALUES(1,?,?,?,?,?,?,?,?,?,30)`).run(forkSource, oldFact.dataset, oldFact.row_key, oldFact.stat_date,
    oldFact.user_id, oldFact.workspace_id, oldFact.session_key, oldFact.occurred_at, JSON.stringify(oldFact.value));
  f.database.prepare('UPDATE ai_usage_tenant_state SET calculation_version=?').run(config.calculationVersion.replace('_fork_lineage_v9', ''));
  f.nextNight();
  assert.equal((await f.run()).published, 1);
  assert.equal(f.facts().filter((row) => row.dataset === 'interactions').length, 1);
  assert.ok(!f.facts().some((row) => row.session_key === logicalSessionKey(forkScope)));
  assert.deepEqual(f.database.prepare('SELECT session_id FROM ai_session_summary').all(), [{ session_id: 'session-a' }]);
});


test('name-only publication backfill repairs old native Skill calls without bindings, dedupes copies and survives full rebuild', async (t) => {
  const f = await fixture(t);
  f.database.exec(`INSERT INTO users VALUES(2,'historical-publisher');
    CREATE TABLE tenant_users(tenant_id INTEGER,user_id INTEGER);
    INSERT INTO tenant_users VALUES(1,1),(1,2);`);
  const first = skillTool('first');
  const second = { type: 'claude-response', data: skillTool('second', '2026-09-11T04:01:00.000Z'),
    uuid: 'wrapped', timestamp: '2026-09-11T04:01:00.000Z' };
  const messages = [userMessage('slash', undefined, '/report'), first, first,
    userMessage('slash-only', '2026-09-11T03:00:00.000Z', '/report'),
    userMessage('request', '2026-09-11T04:00:00.000Z', 'run the skill'), second,
    userMessage('builtin', '2026-09-11T05:00:00.000Z', '/help'),
    userMessage('hook', '2026-09-11T06:00:00.000Z', '<ccui-hook-recovery>automated</ccui-hook-recovery>'),
    skillTool('hook-tool', '2026-09-11T06:01:00.000Z')];
  await f.write('session-a', messages);
  for (const message of messages) f.addCopy(message);
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 2);
  assert.ok(skillReport(f).every(row => row.user_id === null));
  const records = [{ tenantId: 1, username: 'historical-publisher', skillName: 'report',
    firstPublishedAt: '2026-09-01 08:00:00' }];
  const imported = backfillSkillPublications(f.database, records, { apply: true, now: '2026-09-12T00:00:00Z' });
  assert.equal(imported.inserted, 1);
  assert.ok(imported.rows[0].skillId.startsWith('historical:'));
  // Source data and files do not change: the publication must queue old unbound sessions.
  f.nextNight(); assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 3);
  assert.ok(skillReport(f).every(row => row.subject_id === imported.rows[0].skillId && row.user_id === 2
    && row.value.callerUserId === 1 && row.value.callerUserName === 'alice'
    && row.value.attributionSource === 'historical_publication'));
  const query = createAiUsageQueryService({ db: f.database });
  const access = { tenantId: 1, userId: 2, scope: 'tenant', canViewTenant: true };
  const skill = query.skills(access, { from: '2026-09-01', to: '2026-09-12' }).items[0];
  assert.equal(skill.invocationCount, 3); assert.equal(skill.publishedSkillCount, 1); assert.equal(skill.callerCount, 1);
  const repeated = backfillSkillPublications(f.database, records, { apply: true, now: '2026-09-12T00:00:00Z' });
  assert.equal(repeated.unchanged, 1); assert.equal(repeated.inserted, 0);
  f.nextNight();
  const full = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_INCREMENTAL_ENABLED: 'false' });
  assert.equal((await f.run({ config: full })).published, 1);
  assert.equal(query.skills(access, { from: '2026-09-01', to: '2026-09-13' }).items[0].invocationCount, 3);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM ai_skill_publications').get().n, 1);
});

test('competing or removed historical publications retract old attribution without changed transcripts', async (t) => {
  const f = await fixture(t);
  f.database.exec(`INSERT INTO users VALUES(2,'author'),(3,'other-author');
    CREATE TABLE tenant_users(tenant_id INTEGER,user_id INTEGER);
    INSERT INTO tenant_users VALUES(1,2),(1,3);`);
  const imported = backfillSkillPublications(f.database, [{ tenantId: 1, userId: 2, skillName: 'report',
    firstPublishedAt: '2026-09-01 08:00:00' }], { apply: true, now: '2026-09-11T00:00:00Z' });
  await f.write('session-a', [userMessage('slash', undefined, '/report'), skillTool('one'),
    userMessage('only-slash', '2026-09-11T03:00:00Z', '/report')]);
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 2);
  assert.ok(skillReport(f).every(row => row.user_id === 2));
  f.database.exec(`INSERT INTO ai_skill_publications VALUES('other',1,3,'other-id','report',
    '2026-09-01T00:00:00Z','confirmed','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')`);
  f.nextNight(); assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 1);
  assert.equal(skillReport(f)[0].user_id, null);
  assert.equal(skillReport(f)[0].value.attributionReason, 'historical_name_ambiguous');
  const batch = f.database.prepare('SELECT coverage_json FROM ai_usage_batches WHERE id=(SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1)').get();
  assert.equal(JSON.parse(batch.coverage_json).skillInvocationDiagnostics.historical_name_ambiguous, 1);
  f.database.exec("DELETE FROM ai_skill_publications WHERE operation_id='other'");
  f.nextNight(); assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 2);
  assert.ok(skillReport(f).every(row => row.user_id === 2));
  f.database.prepare('DELETE FROM ai_skill_publications WHERE operation_id=?').run(imported.rows[0].operationId);
  f.nextNight(); assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 1);
  assert.equal(skillReport(f)[0].user_id, null);
  assert.equal(skillReport(f)[0].value.attributionReason, 'historical_mapping_missing');
});

test('historical name fallback cannot override an effective remote binding with an unknown author', async (t) => {
  const f = await fixture(t);
  f.database.exec(`INSERT INTO users VALUES(2,'author');
    CREATE TABLE tenant_users(tenant_id INTEGER,user_id INTEGER);
    INSERT INTO tenant_users VALUES(1,2);
    INSERT INTO ai_skill_binding_history(tenant_id,workspace_id,local_name,remote_skill_id,valid_from)
      VALUES(1,10,'report','unrelated-remote','2026-09-01T00:00:00Z');`);
  backfillSkillPublications(f.database, [{ tenantId: 1, userId: 2, skillName: 'report',
    firstPublishedAt: '2026-09-01 08:00:00' }], { apply: true, now: '2026-09-11T00:00:00Z' });
  await f.write('session-a', [userMessage('req'), skillTool('tool')]);
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f)[0].subject_id, 'unrelated-remote');
  assert.equal(skillReport(f)[0].user_id, null);
  assert.equal(skillReport(f)[0].value.attributionReason, 'publisher_unresolved');
});


test('v17 re-reads unchanged v16 histories and safely restarts a paused old-version candidate', async (t) => {
  const f = await fixture(t);
  f.database.exec(`INSERT INTO users VALUES(2,'author');
    CREATE TABLE tenant_users(tenant_id INTEGER,user_id INTEGER);
    INSERT INTO tenant_users VALUES(1,2);`);
  backfillSkillPublications(f.database, [{ tenantId: 1, userId: 2, skillName: 'report',
    firstPublishedAt: '2026-09-01 08:00:00' }], { apply: true, now: '2026-09-11T00:00:00Z' });
  await f.write('session-a', [userMessage('request'), { type: 'claude-response', data: skillTool('wrapped') }]);
  const old = { ...config, calculationVersion: config.calculationVersion.replace(/_skill_history_v17$/, '') };
  assert.notEqual(old.calculationVersion, config.calculationVersion);
  assert.equal((await f.run({ config: old })).published, 1);
  // Model the actual v16 cache: the file is indexed to EOF, but wrapped Skill
  // events had no collected evidence or published invocation. Do not alter bytes.
  f.database.exec(`DELETE FROM ai_usage_fact_rows WHERE dataset IN ('skill_evidence','skill_invocations');
    DELETE FROM ai_usage_report_rows WHERE dataset='skill_invocations';
    DELETE FROM ai_dashboard_integration_detail WHERE skill_call_count IS NOT NULL;
    DELETE FROM ai_dashboard_skill_invocation_detail;
    DELETE FROM ai_usage_dirty_skill_sessions; DELETE FROM ai_usage_source_changes;`);
  f.nextNight(); assert.equal((await f.run({ config: old })).published, 1);
  assert.equal(skillReport(f).length, 0, 'same-version incremental cache remains unchanged');
  const active = f.database.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id;
  f.nextNight();
  await f.run({ config: old, shouldStop: () => Boolean(f.database.prepare(`SELECT 1 FROM ai_usage_batches
    WHERE status='running' AND json_extract(progress_json,'$.stage')='skills'`).get()) });
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM ai_usage_batches WHERE status='paused'").get().n, 1);
  await f.run({ shouldStop: () => Boolean(f.database.prepare(`SELECT 1 FROM ai_usage_batches
    WHERE status='running' AND calculation_version=? AND json_extract(progress_json,'$.stage')='transcripts'`)
    .get(config.calculationVersion)) });
  assert.equal(f.database.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id, active);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM ai_dashboard_skill_invocation_detail').get().n, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM ai_skill_publications').get().n, 1);
  assert.equal((await f.run()).published, 1);
  assert.equal(skillReport(f).length, 1);
  assert.equal(skillReport(f)[0].value.toolUseId, 'wrapped');
  assert.equal(skillReport(f)[0].user_id, 2);
});
