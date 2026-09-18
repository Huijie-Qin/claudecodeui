import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createPlatformAnalyticsService } from './platform-analytics.js';

test('platform analytics excludes inherited history from every view while retaining real branch activity', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE users(id INTEGER,username TEXT,is_active INTEGER,is_system_admin INTEGER,last_login TEXT,created_at TEXT);
    CREATE TABLE tenants(id INTEGER,code TEXT,name TEXT,status TEXT);
    CREATE TABLE tenant_users(user_id INTEGER,tenant_id INTEGER,status TEXT);
    CREATE TABLE user_invitations(user_id INTEGER,accepted_at TEXT,revoked_at TEXT,expires_at TEXT);
    CREATE TABLE workspaces(id INTEGER,tenant_id INTEGER,owner_user_id INTEGER,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,user_id INTEGER,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE agent_session_runtime(tenant_id INTEGER,user_id INTEGER,status TEXT,last_used_at TEXT);
    CREATE TABLE agent_session_messages(tenant_id INTEGER,user_id INTEGER,role TEXT,created_at TEXT,normalized_json TEXT);
    INSERT INTO users VALUES(1,'alice',1,0,NULL,datetime('now','-1 day')),(2,'bob',1,0,NULL,datetime('now','-1 day'));
    INSERT INTO tenants VALUES(1,'one','One','active'),(2,'two','Two','active');
    INSERT INTO tenant_users VALUES(1,1,'active'),(2,2,'active');
    INSERT INTO workspaces VALUES(1,1,1,'active'),(2,2,2,'active');
    INSERT INTO session_index VALUES(1,1,'completed',datetime('now','-1 day'),datetime('now','-1 day')),
      (1,1,'completed',datetime('now','-1 day'),datetime('now','-1 day')),
      (2,2,'completed',datetime('now','-1 day'),datetime('now','-1 day'));
    INSERT INTO agent_session_runtime VALUES(1,1,'idle',datetime('now','-1 day'));
  `);
  const insert = (role, message, { tenantId = 1, userId = tenantId, copied = false } = {}) => {
    database.prepare(`INSERT INTO agent_session_messages VALUES(?,?,?,datetime('now',?),?)`)
      .run(tenantId, userId, role, copied ? '+0 days' : '-1 day', JSON.stringify(message));
  };
  insert('user', { content: 'Original request' });
  insert('assistant', { usage: { total_tokens: 10 } });
  insert(null, { kind: 'hook_activity', status: 'succeeded' });
  insert('assistant', { inherited: false, forkedFrom: null, usage: { total_tokens: 20 } });
  insert('assistant', { usage: { total_tokens: 7 } }, { tenantId: 2 });
  const service = createPlatformAnalyticsService(database);
  const snapshot = (tenantIds) => ({ ...service.getOverview({ days: 7, tenantIds }), generatedAt: null });
  const beforeAll = snapshot([]);
  const beforeOne = snapshot([1]);
  assert.equal(beforeAll.overview.totalMessages, 5);
  assert.equal(beforeAll.overview.tokenCountInWindow, 37);
  assert.equal(beforeOne.overview.totalMessages, 4);
  assert.equal(beforeOne.overview.totalSessions, 2, 'a new branch is still a distinct session');
  assert.equal(beforeOne.overview.tokenCountInWindow, 30);
  const marker = { sessionId: 'parent-session', messageUuid: 'parent-message' };
  for (const tenantId of [1, 2]) {
    for (const role of ['user', 'assistant', null]) {
      for (const inherited of [
        { inherited: true },
        { forkedFrom: marker },
        { message: { forkedFrom: marker } },
        { type: 'claude-response', data: { inherited: true } },
        { type: 'claude-response', data: { message: { forkedFrom: marker } } },
      ]) insert(role, { ...inherited, usage: { total_tokens: 999 } }, { tenantId, copied: true });
    }
  }
  // Covers totals, role counts, tokens, daily buckets, active days, activity
  // timestamps, user rankings, tenant rankings, and tenant-filtered queries.
  assert.deepEqual(snapshot([]), beforeAll);
  assert.deepEqual(snapshot([1]), beforeOne);
});
