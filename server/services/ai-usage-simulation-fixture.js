// Development/test fixture only. Never imported by the production entry point.
// The caller supplies a fresh empty database; seeding an existing database is refused.
import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';
import { migrateAiUsageExportSchema } from '../database/ai-usage-export-schema.js';

import { shiftDate } from './ai-usage-config.js';

export const simulationNight = () => new Date('2026-09-12T18:10:00.000Z');
export const simulationCounts = Object.freeze({ users: 43, skills: 30, requests: 600, toolMessages: 400, hookExecutions: 1200, hookRecords: 1200, turns: 121, templates: 5, businessRows: 3556 });

export function seedAiUsageSimulation(db) {
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) {
    throw new Error('Simulation requires a fresh empty database; existing data must not be modified');
  }
  db.exec(`
    CREATE TABLE ai_usage_simulation_guard(label TEXT NOT NULL);
    INSERT INTO ai_usage_simulation_guard VALUES('fixture-only-2026-09-12');
    CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,is_active INTEGER,is_system_admin INTEGER);
    CREATE TABLE tenant_users(tenant_id INTEGER,user_id INTEGER,role TEXT,status TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE workspace_agent_template_snapshots(workspace_id INTEGER PRIMARY KEY,template_id TEXT,template_name TEXT,
      template_updated_at TEXT,created_by_user_id INTEGER,created_at TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,
      provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,message_id TEXT,provider_timestamp TEXT,created_at TEXT,normalized_json TEXT,runtime_id TEXT,sequence INTEGER);
    CREATE TABLE hooks(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE hook_published_versions(hook_id TEXT,version INTEGER,config_json TEXT,PRIMARY KEY(hook_id,version));
    CREATE TABLE hook_executions(id TEXT PRIMARY KEY,hook_id TEXT,hook_version INTEGER,user_id INTEGER,tenant_id INTEGER,
      workspace_id INTEGER,session_id TEXT,event_name TEXT,status TEXT,duration_ms INTEGER,started_at TEXT,completed_at TEXT,
      started_at_ms INTEGER,completed_at_ms INTEGER,input_json TEXT,logs_json TEXT);
    CREATE TABLE hook_data_records(id TEXT PRIMARY KEY,execution_id TEXT,tenant_id INTEGER,user_id INTEGER,workspace_id INTEGER,
      session_id TEXT,hook_id TEXT,record_type TEXT,data_json TEXT,created_at TEXT,post_action_id TEXT,hook_version INTEGER,record_source TEXT);
    INSERT INTO tenants VALUES(10,'active'),(20,'inactive');
    INSERT INTO users VALUES(2,'林晨 · 租户管理员',1,0),(3,'陈晓 · 普通用户',1,0),(4,'未使用用户',1,0);
    INSERT INTO tenant_users VALUES(10,2,'tenant_admin','active'),(10,3,'member','active'),(10,4,'member','active'),(20,2,'tenant_admin','active'),(20,3,'member','active');
  `);
  migrateAiUsageSchema(db); migrateAiUsageExportSchema(db);
  db.transaction(() => {
    const member = db.prepare("INSERT INTO users VALUES(?,?,1,0)");
    const membership = db.prepare("INSERT INTO tenant_users VALUES(10,?,'member','active')");
    for (let i = 0; i < 40; i++) { member.run(100 + i, `模拟用户 ${String(i + 1).padStart(2, '0')}`); membership.run(100 + i); }
    const workspace = db.prepare("INSERT INTO workspaces VALUES(?,10,?,'active')");
    const template = db.prepare("INSERT INTO workspace_agent_template_snapshots VALUES(?,?,?,'2026-08-01T00:00:00Z',2,'2026-08-01T00:00:00Z')");
    for (let i = 0; i < 5; i++) {
      workspace.run(7 + i, `模拟工作区 ${i + 1}`);
      template.run(7 + i, `template-${i + 1}`, ['需求分析 Agent','SQL 分析 Agent','交付质量 Agent','文档助手','运营分析 Agent'][i]);
    }
    const publication = db.prepare(`INSERT INTO ai_skill_publications VALUES(?,10,?,?,?,'2026-08-01T00:00:00Z','confirmed','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`);
    const binding = db.prepare(`INSERT INTO ai_skill_binding_history(tenant_id,workspace_id,local_name,remote_skill_id,publisher_user_id,valid_from,evidence)
      VALUES(10,?,?,?,?,'2026-08-01T00:00:00Z','simulation')`);
    for (let i = 0; i < 30; i++) {
      const id = `sim-skill-${String(i + 1).padStart(2, '0')}`;
      publication.run(`publish-${id}`, 2 + i % 2, id, i < 2 ? 'SQL 分析' : i === 29 ? '待推广 Skill（零调用）' : `模拟 Skill ${i + 1}`);
      for (let w = 7; w < 12; w++) binding.run(w, id, id, 2 + i % 2);
    }
    const message = db.prepare(`INSERT INTO agent_session_messages(tenant_id,workspace_id,user_id,provider,provider_session_id,message_id,
      provider_timestamp,created_at,normalized_json,runtime_id,sequence) VALUES(10,?,?,'claude',?,?,?,?,?,?,?)`);
    const session = db.prepare("INSERT INTO session_index VALUES(10,?,?,'claude',?)");
    const turn = db.prepare(`INSERT INTO ai_usage_turn_facts(turn_key,tenant_id,user_id,workspace_id,session_key,provider,started_at,
      response_completed_at,terminal_status,source,updated_at) VALUES(?,10,?,? ,?,'claude',?,?,'completed','user',?)`);
    for (let i = 0; i < 600; i++) {
      const date = shiftDate('2026-08-14', i % 30); const at = `${date}T02:00:00.000Z`;
      const user = 100 + i % 40; const ws = 7 + i % 5; const sid = `sim-session-${i}`;
      const skill = `sim-skill-${String(i % 29 + 1).padStart(2, '0')}`;
      session.run(ws, user, sid);
      const request = { uuid: `request-${i}`, timestamp: at, type: 'user', message: { role: 'user', content: i % 3 === 1 ? '模拟请求' : `/${skill} 模拟任务` } };
      message.run(ws, user, sid, request.uuid, at, at, JSON.stringify(request), `runtime-${i}`, 1);
      if (i % 3 !== 2) {
        const toolAt = `${date}T02:00:01.000Z`;
        const tool = { uuid: `assistant-${i}`, timestamp: toolAt, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${i}`, name: 'Skill', input: { skill } }] } };
        message.run(ws, user, sid, tool.uuid, toolAt, toolAt, JSON.stringify(tool), `runtime-${i}`, 2);
      }
      if (i < 120) {
        const end = new Date(Date.parse(at) + (i % 5 + 1) * 60000).toISOString();
        turn.run(`turn-${i}`, user, ws, sid, at, end, end);
      }
    }
    // One actual request spanning midnight: 2 + 3 minutes, no fabricated next-day user message.
    turn.run('cross-midnight', 3, 7, 'cross-midnight', '2026-09-11T15:58:00.000Z', '2026-09-11T16:03:00.000Z', '2026-09-11T16:03:00.000Z');
    const hooks = [
      { id: 'hook-session-a', name: '会话记录 Hook', action: 'record-summary', type: 'conversation_record', fields: [
        { key: 'recordCount', label: '归档条数', type: 'number' },
        { key: 'qualityScore', label: '归档质量分', type: 'number' },
        { key: 'result', label: '处理结果', type: 'string', aggregation: 'none' }] },
      { id: 'hook-session-b', name: '会话记录 Hook', action: 'record-review', type: 'conversation_record', fields: [
        { key: 'reviewMinutes', label: '复核耗时', type: 'number' },
        { key: 'reviewScore', label: '复核评分', type: 'number' },
        { key: 'result', label: '处理结果', type: 'string', aggregation: 'none' }] },
      { id: 'hook-sql', name: 'SQL 产出记录', action: 'record-sql', type: 'sql_response_metrics', fields: [
        { key: 'statementCount', label: 'SQL 语句数', type: 'number' },
        { key: 'sqlLineCount', label: 'SQL 行数', type: 'number' }] },
    ];
    for (const hook of hooks) {
      db.prepare('INSERT INTO hooks VALUES(?,?)').run(hook.id, hook.name);
      for (const version of [1, 2]) db.prepare('INSERT INTO hook_published_versions VALUES(?,?,?)').run(hook.id, version,
        JSON.stringify({ postActions: [{ id: hook.action, type: 'write_record', config: { recordType: hook.type, reportFields: hook.fields } }] }));
    }
    const execution = db.prepare('INSERT INTO hook_executions VALUES(?,?,?,?,10,?,?,?,?,?,?,?,?,?,?,?)');
    const record = db.prepare('INSERT INTO hook_data_records VALUES(?,?,10,?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 1200; i++) {
      const hook = hooks[i % 3]; const version = 1 + Math.floor(i / 3) % 2;
      const date = shiftDate('2026-08-14', i % 30); const at = `${date}T03:00:00.000Z`;
      const ws = 7 + i % 5; const user = 100 + i % 40; const sid = `sim-session-${i % 600}`;
      const status = i % 20 === 0 ? 'failed' : i % 20 === 1 ? 'running' : 'succeeded';
      const duration = status === 'running' ? null : 100 + i % 90 * 10;
      const end = duration == null ? null : new Date(Date.parse(at) + duration).toISOString();
      execution.run(`exec-${i}`, hook.id, version, user, ws, sid, 'Stop', status, duration, at, end,
        Date.parse(at), end ? Date.parse(end) : null, '{"privatePrompt":"SIMULATION_PRIVATE"}', '["SIMULATION_PRIVATE"]');
      // Records can be written before later actions fail: record count is independent of execution success.
      const value = { recordCount: i % 5 + 1, qualityScore: 80 + i % 20, reviewMinutes: i % 9 + 1,
        reviewScore: 70 + i % 30, statementCount: i % 4 + 1, sqlLineCount: 10 + i % 50,
        result: i % 2 ? '已复核' : '已归档', privatePrompt: 'SIMULATION_PRIVATE' };
      record.run(`record-${i}`, `exec-${i}`, user, ws, sid, hook.id, hook.type, JSON.stringify(value), at, hook.action, version, 'post_action');
    }
  })();
  return simulationCounts;
}
