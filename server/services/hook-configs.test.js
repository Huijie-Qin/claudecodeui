import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  HOOK_CONFIG_SCHEMA_SQL,
  migrateHookActivationModel,
  migrateHookConfigurationModel,
} from '../database/hook-config-schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import { createHookConfigService } from './hook-configs.js';

function createFixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${HOOK_CONFIG_SCHEMA_SQL}
    ${MULTITENANCY_SCHEMA_SQL}
  `);
  migrateHookConfigurationModel(database);
  migrateHookActivationModel(database);
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
    extensionLogic: {
      language: 'javascript',
      code: 'export async function run(event, ccui) { await ccui.records.write("stop", event); return { output: { summary: "done" } }; }',
      outputs: [{ name: 'summary', type: 'string', description: '执行摘要' }],
    },
    postActions: [],
    claudeResponse: { bindings: {} },
    ...overrides,
  };
}

test('Hook configuration CRUD persists scripts, post actions, Claude response, and publication state', () => {
  const { database, service } = createFixture();
  try {
    const created = service.createHook({ input: publishableHook(), userId: 1 });
    assert.equal(created.status, 'draft');
    assert.equal(created.extensionLogic.language, 'javascript');
    assert.deepEqual(created.extensionLogic.outputs, [
      { name: 'summary', type: 'string', description: '执行摘要' },
    ]);

    const updated = service.updateHook({
      hookId: created.id,
      userId: 1,
      input: publishableHook({
        extensionLogic: {
          language: 'python',
          code: 'async def run(event, ccui):\n    await ccui.records.write("stop", event)\n    return {"output": {"summary": "done"}}',
          outputs: [{ name: 'summary', type: 'string', description: '执行摘要' }],
        },
        claudeResponse: {
          bindings: {
            systemMessage: {
              source: 'template',
              template: '执行结果：{{script.output.summary}}',
            },
          },
        },
      }),
    });
    assert.equal(updated.extensionLogic.language, 'python');
    assert.match(updated.extensionLogic.code, /async def run/);
    assert.deepEqual(updated.claudeResponse.bindings.systemMessage, {
      source: 'template',
      template: '执行结果：{{script.output.summary}}',
    });

    const published = service.publishHook({ hookId: created.id, userId: 1 });
    assert.equal(published.status, 'published');
    assert.equal(published.version, 1);
    assert.equal(published.boundUserCount, 0);
    assert.ok(published.publishedAt);

    const started = service.startHook({ hookId: created.id, userId: 1 });
    assert.equal(started.status, 'published');
    assert.equal(started.activationScope, 'all_users');
    assert.equal(started.boundUserCount, 0);
    assert.deepEqual(
      service.listActiveHooksForUser(1).map((hook) => hook.id),
      [created.id],
    );
    assert.deepEqual(
      service.listActiveHooksForUser(2).map((hook) => hook.id),
      [created.id],
    );

    database.prepare('INSERT INTO users (id, username) VALUES (3, ?)').run('new-member');
    assert.equal(service.getHook(created.id).boundUserCount, 0);
    assert.deepEqual(
      service.listActiveHooksForUser(3).map((hook) => hook.id),
      [created.id],
    );

    const stopped = service.stopHook({ hookId: created.id, userId: 1 });
    assert.equal(stopped.status, 'published');
    assert.equal(stopped.activationScope, 'manual');
    assert.equal(stopped.boundUserCount, 0);
    assert.deepEqual(service.listActiveHooksForUser(1), []);
    assert.deepEqual(service.listActiveHooksForUser(2), []);
    assert.deepEqual(service.listActiveHooksForUser(3), []);

    database
      .prepare(
        `
      INSERT INTO user_hook_bindings (user_id, hook_id, bound_by)
      VALUES (?, ?, ?)
    `,
      )
      .run(3, created.id, 3);
    assert.deepEqual(
      service.listActiveHooksForUser(3).map((hook) => hook.id),
      [created.id],
    );
    assert.deepEqual(service.listActiveHooksForUser(2), []);

    const restarted = service.startHook({ hookId: created.id, userId: 1 });
    assert.equal(restarted.boundUserCount, 1);
    assert.deepEqual(
      service.listActiveHooksForUser(1).map((hook) => hook.id),
      [created.id],
    );
    assert.deepEqual(
      service.listActiveHooksForUser(2).map((hook) => hook.id),
      [created.id],
    );
    database.prepare('INSERT INTO users (id, username) VALUES (4, ?)').run('later-member');
    assert.equal(service.getHook(created.id).boundUserCount, 1);
    assert.deepEqual(
      service.listActiveHooksForUser(4).map((hook) => hook.id),
      [created.id],
    );
    const stoppedAgain = service.stopHook({ hookId: created.id, userId: 1 });
    assert.equal(stoppedAgain.boundUserCount, 1);
    assert.deepEqual(
      service.listActiveHooksForUser(3).map((hook) => hook.id),
      [created.id],
    );
    assert.deepEqual(service.listActiveHooksForUser(4), []);
    const listed = service.listHooks()[0];
    assert.equal(listed.extensionLogic.language, 'python');

    assert.equal(service.deleteHook(created.id), true);
    assert.equal(service.getHook(created.id), null);
  } finally {
    database.close();
  }
});

test('publishing requires at least one configured effect', () => {
  const { database, service } = createFixture();
  try {
    const hook = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'PreToolUse',
        matcher: {},
        extensionLogic: { language: 'javascript', code: '   ', outputs: [] },
      }),
    });

    assert.throws(
      () => service.publishHook({ hookId: hook.id, userId: 1 }),
      /Configure a script, post action, or Claude response/,
    );
  } finally {
    database.close();
  }
});

test('execution audit and script data records can be queried for an Hook', () => {
  const { database, service } = createFixture();
  try {
    const hook = service.createHook({ input: publishableHook(), userId: 1 });
    database.prepare(`
      INSERT INTO hook_executions (
        id, hook_id, hook_version, user_id, event_name, status,
        input_json, script_output_json, actions_json, response_json, logs_json,
        duration_ms, completed_at
      ) VALUES (?, ?, 1, 1, 'Stop', 'succeeded', ?, ?, ?, ?, ?, 12, CURRENT_TIMESTAMP)
    `).run(
      'execution-1',
      hook.id,
      JSON.stringify({ hook_event_name: 'Stop' }),
      JSON.stringify({ rows: 3 }),
      JSON.stringify({}),
      JSON.stringify({ continue: true }),
      JSON.stringify([{ message: 'done' }]),
    );
    database.prepare(`
      INSERT INTO hook_data_records (
        id, execution_id, hook_id, user_id, record_type, data_json
      ) VALUES ('record-1', 'execution-1', ?, 1, 'sql_analysis', ?)
    `).run(hook.id, JSON.stringify({ rows: 3 }));

    const [execution] = service.listExecutions(hook.id, { limit: 1 });
    assert.equal(execution.id, 'execution-1');
    assert.deepEqual(execution.scriptOutput, { rows: 3 });
    assert.deepEqual(execution.response, { continue: true });
    const [record] = service.listDataRecords(hook.id, { limit: 1 });
    assert.equal(record.type, 'sql_analysis');
    assert.deepEqual(record.data, { rows: 3 });
  } finally {
    database.close();
  }
});

test('StopFailure can call a published MCP tool and then start a Skill recovery turn', () => {
  const { database, service } = createFixture();
  try {
    database.prepare("INSERT INTO tenants (id, code, name) VALUES (1, 'demo', 'Demo')").run();
    database.prepare(`
      INSERT INTO mcp_server_presets (
        tenant_id, name, display_name, config_json, status, last_test_status,
        tool_count, tools_json, created_by_user_id, updated_by_user_id
      ) VALUES (1, 'notify', '通知服务', '{}', 'published', 'healthy', 1, ?, 1, 1)
    `).run(JSON.stringify([{
      name: 'send_sms',
      description: '发送短信',
      inputSchema: {
        type: 'object',
        required: ['user_id', 'content'],
        properties: {
          user_id: { type: 'number' },
          content: { type: 'string' },
        },
      },
    }]));
    database.prepare(`
      INSERT INTO tenant_skill_presets (
        tenant_id, name, display_name, skill_id, remote_id, status,
        created_by_user_id, updated_by_user_id
      ) VALUES (1, 'notify-user', '通知用户', 'skill-1', 'remote-1', 'published', 1, 1)
    `).run();

    const created = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'StopFailure',
        matcher: { value: 'error' },
        extensionLogic: null,
        postActions: [
          {
            id: 'send-sms',
            type: 'call_mcp_tool',
            position: 0,
            config: {
              toolName: 'mcp__notify__send_sms',
              inputs: {
                user_id: { source: 'reference', path: 'ccui.env.userId' },
                content: { source: 'literal', value: '本轮执行失败' },
              },
            },
          },
          {
            id: 'recover',
            type: 'invoke_skill',
            position: 1,
            config: {
              skillName: 'notify-user',
              argumentsTemplate: '用户 {{ccui.env.userId}}，短信结果 {{actions.send-sms.output}}',
              maxTurns: 3,
            },
          },
        ],
        claudeResponse: { bindings: {} },
      }),
    });

    assert.equal(created.postActions.length, 2);
    assert.equal(created.postActions[0].position, 0);
    assert.equal(created.postActions[1].position, 1);
    const published = service.publishHook({ hookId: created.id, userId: 1 });
    assert.equal(published.status, 'published');
  } finally {
    database.close();
  }
});

test('post action and Claude response validation follows the selected event', () => {
  const { database, service } = createFixture();
  try {
    const stopSkill = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'Stop',
        postActions: [{
          id: 'recover',
          type: 'invoke_skill',
          position: 0,
          config: { skillName: 'notify-user', argumentsTemplate: '', maxTurns: 3 },
        }],
      }),
    });
    assert.equal(stopSkill.postActions[0].type, 'invoke_skill');

    assert.throws(() => service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'SessionEnd',
        postActions: [{
          id: 'recover',
          type: 'invoke_skill',
          position: 0,
          config: { skillName: 'notify-user', argumentsTemplate: '', maxTurns: 3 },
        }],
      }),
    }), /only supported for Stop and StopFailure/);

    const invalidOutput = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'Stop',
        claudeResponse: {
          bindings: {
            'hookSpecificOutput.updatedInput': { source: 'literal', value: {} },
          },
        },
      }),
    });
    assert.throws(
      () => service.publishHook({ hookId: invalidOutput.id, userId: 1 }),
      /is not supported for Stop/,
    );

    const missingTool = service.createHook({
      userId: 1,
      input: publishableHook({
        extensionLogic: null,
        postActions: [{
          id: 'missing-tool',
          type: 'call_mcp_tool',
          position: 0,
          config: { toolName: 'mcp__missing__tool', inputs: {} },
        }],
      }),
    });
    assert.throws(
      () => service.publishHook({ hookId: missingTool.id, userId: 1 }),
      /is not available/,
    );
  } finally {
    database.close();
  }
});

test('visible event settings are validated and persisted', () => {
  const { database, service } = createFixture();
  try {
    assert.deepEqual(service.getSettings().visibleEvents, ['Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
    assert.deepEqual(
      service.updateSettings({
        visibleEvents: ['StopFailure', 'StopFailure', 'PreToolUse'],
      }).visibleEvents,
      ['StopFailure', 'PreToolUse'],
    );
    assert.deepEqual(service.getSettings().visibleEvents, ['StopFailure', 'PreToolUse']);
    assert.throws(() => service.updateSettings({ visibleEvents: [] }), /Select at least one/);
  } finally {
    database.close();
  }
});

test('configuration migration replaces legacy gates, actions, and advanced scripts', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE hooks (
        id TEXT PRIMARY KEY,
        gate_json TEXT NOT NULL DEFAULT '{}',
        advanced_script_json TEXT
      );
      CREATE TABLE hook_actions (
        id TEXT PRIMARY KEY,
        hook_id TEXT NOT NULL
      );
      INSERT INTO hooks (id, advanced_script_json) VALUES ('legacy', '{"language":"javascript"}');
      INSERT INTO hook_actions (id, hook_id) VALUES ('action', 'legacy');
    `);

    assert.deepEqual(migrateHookConfigurationModel(database), {
      addedExtensionLogic: true,
      addedPostActions: true,
      addedClaudeResponse: true,
      removedGate: true,
      removedAdvancedScript: true,
    });
    assert.deepEqual(
      database
        .prepare('PRAGMA table_info(hooks)')
        .all()
        .map((column) => column.name),
      ['id', 'extension_logic_json', 'post_actions_json', 'claude_response_json'],
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'hook_actions'")
        .get().count,
      0,
    );
    assert.deepEqual(
      JSON.parse(
        database.prepare("SELECT extension_logic_json FROM hooks WHERE id = 'legacy'").get().extension_logic_json,
      ),
      null,
    );
  } finally {
    database.close();
  }
});

test('legacy global activation migrates to scope-only global execution without triggers', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY
      );
      CREATE TABLE hooks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'published',
        global_enabled INTEGER NOT NULL DEFAULT 0,
        updated_by INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE user_hook_bindings (
        user_id INTEGER NOT NULL,
        hook_id TEXT NOT NULL,
        bound_by INTEGER,
        PRIMARY KEY (user_id, hook_id)
      );
      INSERT INTO users (id) VALUES (1);
      INSERT INTO hooks (id, global_enabled) VALUES ('active', 1), ('stopped', 0);
      INSERT INTO user_hook_bindings (user_id, hook_id) VALUES (1, 'active'), (1, 'stopped');
    `);

    assert.deepEqual(migrateHookActivationModel(database), {
      migratedGlobalEnabled: true,
      addedActivationScope: true,
      removedBindingSource: false,
    });
    assert.equal(
      database
        .prepare('PRAGMA table_info(hooks)')
        .all()
        .some((column) => column.name === 'global_enabled'),
      false,
    );
    assert.deepEqual(database.prepare('SELECT user_id, hook_id FROM user_hook_bindings ORDER BY hook_id').all(), []);
    assert.equal(
      database.prepare("SELECT activation_scope FROM hooks WHERE id = 'active'").get().activation_scope,
      'all_users',
    );
    database.prepare('INSERT INTO users (id) VALUES (2)').run();
    assert.deepEqual(
      database.prepare('SELECT user_id FROM user_hook_bindings WHERE hook_id = ? ORDER BY user_id').all('active'),
      [],
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'").get().count, 0);
    assert.deepEqual(migrateHookActivationModel(database), {
      migratedGlobalEnabled: false,
      addedActivationScope: false,
      removedBindingSource: false,
    });
  } finally {
    database.close();
  }
});

test('binding-source migration keeps user bindings and removes global materializations', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE hooks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'published',
        activation_scope TEXT NOT NULL DEFAULT 'manual',
        updated_by INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE user_hook_bindings (
        user_id INTEGER NOT NULL,
        hook_id TEXT NOT NULL,
        bound_by INTEGER,
        binding_source TEXT NOT NULL DEFAULT 'user',
        PRIMARY KEY (user_id, hook_id)
      );
      INSERT INTO users (id) VALUES (1), (2);
      INSERT INTO hooks (id, activation_scope) VALUES ('global', 'all_users'), ('personal', 'manual');
      INSERT INTO user_hook_bindings (user_id, hook_id, binding_source)
      VALUES (1, 'global', 'admin_global'), (2, 'personal', 'user');
    `);

    assert.deepEqual(migrateHookActivationModel(database), {
      migratedGlobalEnabled: false,
      addedActivationScope: false,
      removedBindingSource: true,
    });
    assert.deepEqual(database.prepare('SELECT user_id, hook_id FROM user_hook_bindings').all(), [
      { user_id: 2, hook_id: 'personal' },
    ]);
    assert.equal(
      database
        .prepare('PRAGMA table_info(user_hook_bindings)')
        .all()
        .some((column) => column.name === 'binding_source'),
      false,
    );
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
    assert.deepEqual(exact.matcher, {
      mode: 'exact',
      value: 'mcp__data__query',
    });

    const regex = service.updateHook({
      hookId: exact.id,
      userId: 1,
      input: publishableHook({
        eventName: 'PreToolUse',
        matcher: { mode: 'regex', value: '^mcp__data_.*__query$' },
      }),
    });
    assert.deepEqual(regex.matcher, {
      mode: 'regex',
      value: '^mcp__data_.*__query$',
    });

    assert.throws(
      () =>
        service.updateHook({
          hookId: exact.id,
          userId: 1,
          input: publishableHook({
            eventName: 'PreToolUse',
            matcher: { mode: 'regex', value: '[invalid' },
          }),
        }),
      /not a valid regular expression/,
    );

    const unsupported = service.updateHook({
      hookId: exact.id,
      userId: 1,
      input: publishableHook({
        eventName: 'Stop',
        matcher: { mode: 'regex', value: '^ignored$' },
      }),
    });
    assert.deepEqual(unsupported.matcher, {});

    const fileNames = service.updateHook({
      hookId: exact.id,
      userId: 1,
      input: publishableHook({
        eventName: 'FileChanged',
        matcher: { mode: 'regex', value: '.envrc|.env' },
      }),
    });
    assert.deepEqual(fileNames.matcher, {
      mode: 'exact',
      value: '.envrc|.env',
    });

    const matchAll = service.updateHook({
      hookId: exact.id,
      userId: 1,
      input: publishableHook({
        eventName: 'PreToolUse',
        matcher: { mode: 'exact', value: '*' },
      }),
    });
    assert.deepEqual(matchAll.matcher, {});
  } finally {
    database.close();
  }
});

test('resource catalog exposes only runtime-backed environment fields', () => {
  const { database, service } = createFixture();
  try {
    assert.deepEqual(service.getResources().environmentVariables, [
      { path: 'ccui.env.userId', type: 'number' },
      { path: 'ccui.env.username', type: 'string' },
      { path: 'ccui.env.tenantId', type: 'number' },
      { path: 'ccui.env.workspaceId', type: 'number' },
      { path: 'ccui.env.sessionId', type: 'string' },
    ]);
  } finally {
    database.close();
  }
});
