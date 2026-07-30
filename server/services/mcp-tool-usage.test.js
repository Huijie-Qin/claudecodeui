import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { buildMcpToolUsageSummary } from './mcp-tool-usage.js';

function currentSqlDateTime() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function createTestDb() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE agent_session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      runtime_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_session_id TEXT,
      message_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT,
      content_text TEXT,
      normalized_json TEXT NOT NULL,
      provider_timestamp TEXT,
      sequence INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return database;
}

function insertMessage(database, {
  provider = 'codex',
  kind = 'tool_use',
  message,
  sequence = 1,
  createdAt = currentSqlDateTime(),
}) {
  database.prepare(`
    INSERT INTO agent_session_messages (
      tenant_id,
      workspace_id,
      user_id,
      runtime_id,
      provider,
      provider_session_id,
      message_id,
      kind,
      role,
      content_text,
      normalized_json,
      provider_timestamp,
      sequence,
      created_at,
      updated_at
    ) VALUES (1, 2, 3, 'runtime-1', ?, 'session-1', ?, ?, NULL, '', ?, ?, ?, ?, ?)
  `).run(
    provider,
    `message-${provider}-${sequence}`,
    kind,
    JSON.stringify(message),
    createdAt,
    sequence,
    createdAt,
    createdAt,
  );
}

test('buildMcpToolUsageSummary groups MCP tool calls by server and tool', () => {
  const database = createTestDb();
  insertMessage(database, {
    message: { toolName: 'search_docs', server: 'docs', status: 'success' },
    sequence: 1,
  });
  insertMessage(database, {
    message: { toolName: 'mcp__github__list_issues', status: 'failed' },
    sequence: 2,
  });
  insertMessage(database, {
    message: { toolName: 'shell_command', status: 'success' },
    sequence: 3,
  });

  const summary = buildMcpToolUsageSummary({ rangeDays: 30, database });

  assert.equal(summary.totals.callCount, 2);
  assert.equal(summary.totals.successCount, 1);
  assert.equal(summary.totals.errorCount, 1);
  assert.equal(summary.totals.serverCount, 2);
  assert.deepEqual(summary.byServer.map((server) => server.serverName).sort(), ['docs', 'github']);
  assert.equal(summary.byTool.find((tool) => tool.serverName === 'github')?.toolName, 'list_issues');
  assert.equal(summary.recentCalls.length, 2);
});

test('buildMcpToolUsageSummary filters by provider', () => {
  const database = createTestDb();
  insertMessage(database, {
    provider: 'codex',
    message: { toolName: 'read_docs', server: 'docs' },
    sequence: 1,
  });
  insertMessage(database, {
    provider: 'claude',
    message: { toolName: 'mcp__github__list_issues' },
    sequence: 2,
  });

  const summary = buildMcpToolUsageSummary({ rangeDays: 30, provider: 'claude', database });

  assert.equal(summary.totals.callCount, 1);
  assert.equal(summary.recentCalls[0].provider, 'claude');
  assert.equal(summary.recentCalls[0].serverName, 'github');
});
