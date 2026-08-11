import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  HOOK_CONFIG_POST_MIGRATION_SQL,
  HOOK_CONFIG_SCHEMA_SQL,
} from '../database/hook-config-schema.js';

import { createHookConfigService } from './hook-configs.js';

function createFixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${HOOK_CONFIG_SCHEMA_SQL}
    ${HOOK_CONFIG_POST_MIGRATION_SQL}
  `);
  database.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('admin');
  database.prepare('INSERT INTO users (id, username) VALUES (2, ?)').run('member');
  const values = new Map();
  const configStore = {
    get: (key) => values.get(key) || null,
    set: (key, value) => values.set(key, value),
  };
  return {
    database,
    service: createHookConfigService({ database, configStore }),
  };
}

function publishableHook(overrides = {}) {
  return {
    name: 'SQL 审计',
    description: '记录回答中的 SQL 分析结果',
    eventName: 'Stop',
    matcher: {},
    gate: { mode: 'all', conditions: [] },
    advancedScript: null,
    actions: [
      {
        id: 'record',
        type: 'record_data',
        config: { fields: ['$event.lastAssistantMessage'] },
      },
    ],
    ...overrides,
  };
}

test('Hook configuration CRUD persists ordered actions and publication state', () => {
  const { database, service } = createFixture();
  try {
    const created = service.createHook({ input: publishableHook(), userId: 1 });
    assert.equal(created.status, 'draft');
    assert.equal(created.actions.length, 1);
    assert.equal(created.actions[0].position, 0);

    const updated = service.updateHook({
      hookId: created.id,
      userId: 1,
      input: publishableHook({
        actions: [
          { id: 'context', type: 'record_data', config: { fields: ['$context.userId'] } },
          { id: 'tool', type: 'call_tool', config: { toolName: 'mcp__audit__write', inputs: {} } },
        ],
      }),
    });
    assert.deepEqual(updated.actions.map((action) => action.id), ['context', 'tool']);

    const published = service.publishHook({ hookId: created.id, userId: 1 });
    assert.equal(published.status, 'published');
    assert.equal(published.version, 1);
    assert.equal(published.globalEnabled, false);
    assert.equal(published.boundUserCount, 0);
    assert.ok(published.publishedAt);

    const started = service.startHook({ hookId: created.id, userId: 1 });
    assert.equal(started.status, 'published');
    assert.equal(started.globalEnabled, true);
    assert.equal(started.boundUserCount, 2);
    assert.deepEqual(service.listActiveHooksForUser(2).map((hook) => hook.id), [created.id]);

    database.prepare('INSERT INTO users (id, username) VALUES (3, ?)').run('new-member');
    assert.equal(service.getHook(created.id).boundUserCount, 3);

    const stopped = service.stopHook({ hookId: created.id, userId: 1 });
    assert.equal(stopped.status, 'published');
    assert.equal(stopped.globalEnabled, false);
    assert.equal(stopped.boundUserCount, 3);
    assert.deepEqual(service.listActiveHooksForUser(2), []);
    const listed = service.listHooks()[0];
    assert.equal(listed.actionCount, 2);
    assert.deepEqual(listed.actions.map((action) => action.id), ['context', 'tool']);

    assert.equal(service.deleteHook(created.id), true);
    assert.equal(service.getHook(created.id), null);
  } finally {
    database.close();
  }
});

test('publishing rejects event actions that cannot be represented safely', () => {
  const { database, service } = createFixture();
  try {
    const hook = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'PreToolUse',
        matcher: {},
        actions: [
          {
            id: 'modify',
            type: 'update_input',
            config: {
              targetPath: 'tool_input.command',
              replacement: { source: 'literal', value: 'npm test' },
            },
          },
        ],
      }),
    });

    assert.throws(
      () => service.publishHook({ hookId: hook.id, userId: 1 }),
      /update_input is not available for PreToolUse/,
    );
  } finally {
    database.close();
  }
});

test('visible event settings are validated and persisted', () => {
  const { database, service } = createFixture();
  try {
    assert.deepEqual(service.getSettings().visibleEvents, [
      'Stop',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
    ]);
    assert.deepEqual(
      service.updateSettings({ visibleEvents: ['StopFailure', 'StopFailure', 'PreToolUse'] }).visibleEvents,
      ['StopFailure', 'PreToolUse'],
    );
    assert.deepEqual(service.getSettings().visibleEvents, ['StopFailure', 'PreToolUse']);
    assert.throws(() => service.updateSettings({ visibleEvents: [] }), /Select at least one/);
  } finally {
    database.close();
  }
});

test('matcher supports exact and validated regular-expression modes', () => {
  const { database, service } = createFixture();
  try {
    const exact = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'PreToolUse',
        matcher: { mode: 'exact', value: 'mcp__data__query' },
      }),
    });
    assert.deepEqual(exact.matcher, { mode: 'exact', value: 'mcp__data__query' });

    const regex = service.updateHook({
      hookId: exact.id,
      userId: 1,
      input: publishableHook({
        eventName: 'PreToolUse',
        matcher: { mode: 'regex', value: '^mcp__data_.*__query$' },
      }),
    });
    assert.deepEqual(regex.matcher, { mode: 'regex', value: '^mcp__data_.*__query$' });

    assert.throws(
      () => service.updateHook({
        hookId: exact.id,
        userId: 1,
        input: publishableHook({ matcher: { mode: 'regex', value: '[invalid' } }),
      }),
      /not a valid regular expression/,
    );
  } finally {
    database.close();
  }
});

test('resource catalog exposes only runtime-backed environment fields', () => {
  const { database, service } = createFixture();
  try {
    assert.deepEqual(
      service.getResources().environmentVariables,
      [
        { path: '$context.userId', type: 'number' },
        { path: '$context.username', type: 'string' },
        { path: '$context.tenantId', type: 'number' },
        { path: '$context.sessionId', type: 'string' },
        { path: '$context.projectId', type: 'number' },
      ],
    );
  } finally {
    database.close();
  }
});
