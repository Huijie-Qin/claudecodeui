import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  HOOK_CONFIG_SCHEMA_SQL,
  migrateHookActivationModel,
  migrateHookConfigurationModel,
  migrateHookExecutionDiagnostics,
} from '../database/hook-config-schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import { createHookConfigService } from './hook-configs.js';

function createFixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT 1,
      is_system_admin BOOLEAN NOT NULL DEFAULT 0
    );
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
      outputs: [{ name: 'summary', type: 'string' }],
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
      { name: 'summary', type: 'string' },
    ]);

    const updated = service.updateHook({
      hookId: created.id,
      userId: 1,
      input: publishableHook({
        extensionLogic: {
          language: 'python',
          code: 'async def run(event, ccui):\n    await ccui.records.write("stop", event)\n    return {"output": {"summary": "done"}}',
          outputs: [{ name: 'summary', type: 'string' }],
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

    assert.deepEqual(service.listHookBindings(created.id).users.map((user) => ({
      id: user.id,
      bound: user.bound,
    })), [
      { id: 1, bound: false },
      { id: 2, bound: false },
    ]);

    const firstBinding = service.replaceHookBindings({ hookId: created.id, userIds: [1], boundBy: 1 });
    assert.equal(firstBinding.hook.status, 'published');
    assert.equal(firstBinding.hook.activationScope, 'manual');
    assert.equal(firstBinding.hook.boundUserCount, 1);
    assert.deepEqual(
      service.listActiveHooksForUser(1).map((hook) => hook.id),
      [created.id],
    );
    assert.deepEqual(service.listActiveHooksForUser(2), []);

    database.prepare('INSERT INTO users (id, username) VALUES (3, ?)').run('new-member');
    assert.deepEqual(service.listActiveHooksForUser(3), []);

    const reassigned = service.replaceHookBindings({
      hookId: created.id,
      userIds: [2, 3, 3],
      boundBy: 1,
    });
    assert.equal(reassigned.hook.boundUserCount, 2);
    assert.deepEqual(service.listActiveHooksForUser(1), []);
    assert.deepEqual(
      service.listActiveHooksForUser(2).map((hook) => hook.id),
      [created.id],
    );
    assert.deepEqual(
      service.listActiveHooksForUser(3).map((hook) => hook.id),
      [created.id],
    );
    database.prepare('INSERT INTO users (id, username) VALUES (4, ?)').run('later-member');
    assert.deepEqual(service.listActiveHooksForUser(4), []);

    database.prepare("INSERT INTO tenants (id, code, name, status) VALUES (1, 'alpha', 'Alpha', 'active')").run();
    database.prepare(`
      INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
      VALUES (1, 2, 'member', 'view', 'active')
    `).run();
    const tenantBinding = service.replaceHookBindings({
      hookId: created.id,
      scope: 'tenants',
      tenantIds: [1],
      boundBy: 1,
    });
    assert.equal(tenantBinding.hook.boundUserCount, 0);
    assert.equal(tenantBinding.hook.boundTenantCount, 1);
    assert.deepEqual(service.listActiveHooksForUser(1), []);
    assert.deepEqual(service.listActiveHooksForUser(2).map((hook) => hook.id), [created.id]);
    assert.deepEqual(service.listActiveHooksForUser(4), []);

    database.prepare(`
      INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
      VALUES (1, 4, 'member', 'view', 'active')
    `).run();
    assert.deepEqual(
      service.listActiveHooksForUser(4).map((hook) => hook.id),
      [created.id],
      'a user added to a bound tenant should become effective automatically',
    );

    const globalBinding = service.replaceHookBindings({
      hookId: created.id,
      scope: 'all_users',
      boundBy: 1,
    });
    assert.equal(globalBinding.hook.activationScope, 'all_users');
    assert.equal(globalBinding.hook.boundTenantCount, 0);
    assert.deepEqual(service.listActiveHooksForUser(1).map((hook) => hook.id), [created.id]);
    database.prepare('INSERT INTO users (id, username) VALUES (5, ?)').run('future-global-member');
    assert.deepEqual(
      service.listActiveHooksForUser(5).map((hook) => hook.id),
      [created.id],
      'a new active user should inherit an all-user Hook automatically',
    );

    const cleared = service.replaceHookBindings({
      hookId: created.id,
      scope: 'users',
      userIds: [],
      boundBy: 1,
    });
    assert.equal(cleared.hook.boundUserCount, 0);
    assert.equal(cleared.hook.boundTenantCount, 0);
    assert.equal(cleared.hook.activationScope, 'manual');
    assert.deepEqual(service.listActiveHooksForUser(2), []);
    assert.deepEqual(service.listActiveHooksForUser(3), []);
    const listed = service.listHooks()[0];
    assert.equal(listed.extensionLogic.language, 'python');

    assert.equal(service.deleteHook(created.id), true);
    assert.equal(service.getHook(created.id), null);
  } finally {
    database.close();
  }
});

test('Hook execution diagnostics expose outcomes, millisecond timestamps, and global filters', () => {
  const { database, service } = createFixture();
  try {
    const hook = service.createHook({ input: publishableHook(), userId: 1 });
    database.prepare(`
      INSERT INTO hook_executions (
        id, hook_id, hook_version, user_id, session_id, event_name, tool_use_id,
        status, input_json, actions_json, response_json, duration_ms,
        started_at_ms, completed_at_ms
      ) VALUES (?, ?, 2, 1, 'session-1', 'PreToolUse', 'tool-1',
        'succeeded', ?, '{}', ?, 25, 1000, 1025)
    `).run(
      'execution-1',
      hook.id,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pwd' } }),
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'blocked',
        },
      }),
    );

    const [execution] = service.listAllExecutions({ sessionId: 'session-1' });
    assert.equal(execution.hookName, hook.name);
    assert.equal(execution.username, 'admin');
    assert.equal(execution.toolName, 'Bash');
    assert.equal(execution.startedAtMs, 1000);
    assert.equal(execution.completedAtMs, 1025);
    assert.equal(execution.diagnostics.outcome, 'denied');
    assert.equal(execution.diagnostics.permissionDecision, 'deny');
    assert.equal(execution.input, null);
    const detail = service.getExecution('execution-1');
    assert.equal(detail.id, 'execution-1');
    assert.equal(detail.input.tool_name, 'Bash');
  } finally {
    database.close();
  }
});

test('Hook execution diagnostics paginate correlated event groups without splitting parallel Hooks', () => {
  const { database, service } = createFixture();
  try {
    const firstHook = service.createHook({ input: publishableHook({ name: 'First Hook' }), userId: 1 });
    const secondHook = service.createHook({ input: publishableHook({ name: 'Second Hook' }), userId: 1 });
    const insert = database.prepare(`
      INSERT INTO hook_executions (
        id, hook_id, hook_version, user_id, session_id, event_name, tool_use_id,
        status, input_json, actions_json, response_json, duration_ms,
        started_at_ms, completed_at_ms
      ) VALUES (?, ?, 1, 1, ?, 'PreToolUse', ?, 'succeeded', ?, '{}', ?, 10, ?, ?)
    `);
    const deniedResponse = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    const bashInput = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pwd' } });
    insert.run('parallel-1', firstHook.id, 'session-1', 'tool-1', bashInput, deniedResponse, 1000, 1010);
    insert.run('parallel-2', secondHook.id, 'session-1', 'tool-1', bashInput, deniedResponse, 1005, 1015);
    insert.run(
      'latest-standalone',
      firstHook.id,
      'session-2',
      'tool-2',
      JSON.stringify({ tool_name: 'Read' }),
      '{}',
      2000,
      2010,
    );

    const firstPage = service.listAllExecutionPage({ limit: 1, offset: 0 });
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.executionTotal, 3);
    assert.equal(firstPage.limit, 1);
    assert.equal(firstPage.offset, 0);
    assert.deepEqual(firstPage.executions.map((execution) => execution.id), ['latest-standalone']);

    const secondPage = service.listAllExecutionPage({ limit: 1, offset: 1 });
    assert.equal(secondPage.total, 2);
    assert.equal(secondPage.executionTotal, 3);
    assert.deepEqual(
      new Set(secondPage.executions.map((execution) => execution.id)),
      new Set(['parallel-1', 'parallel-2']),
    );

    const filtered = service.listAllExecutionPage({
      q: 'bash',
      bindingController: 'admin',
      outcome: 'denied',
      limit: 10,
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.executionTotal, 2);
    assert.equal(filtered.executions.every((execution) => execution.diagnostics.outcome === 'denied'), true);
  } finally {
    database.close();
  }
});

test('Hook execution diagnostics migration adds and backfills millisecond timestamps', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE hook_executions (
        id TEXT PRIMARY KEY,
        duration_ms INTEGER,
        started_at DATETIME,
        completed_at DATETIME
      );
      INSERT INTO hook_executions (id, duration_ms, started_at, completed_at)
      VALUES ('execution-1', 50, '2026-01-01 00:00:00', '2026-01-01 00:00:00');
    `);
    assert.deepEqual(migrateHookExecutionDiagnostics(database), {
      addedStartedAtMs: true,
      addedCompletedAtMs: true,
    });
    const row = database.prepare('SELECT * FROM hook_executions').get();
    assert.equal(row.completed_at_ms, row.started_at_ms + 50);
    assert.deepEqual(migrateHookExecutionDiagnostics(database), {
      addedStartedAtMs: false,
      addedCompletedAtMs: false,
    });
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

test('legacy combined SQL Hook migrates into independent check and line-record Hooks', () => {
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL
      );
      INSERT INTO users (id, username) VALUES (1, 'admin'), (2, 'member');
      ${HOOK_CONFIG_SCHEMA_SQL}
      ${MULTITENANCY_SCHEMA_SQL}
    `);
    const legacyActions = [
      { id: 'check-sql', type: 'call_mcp_tool', position: 0, config: { toolName: 'mcp__sql__check' } },
      { id: 'record-lines', type: 'write_record', position: 1, config: { recordType: 'sql_response_metrics' } },
    ];
    database.prepare(`
      INSERT INTO hooks (
        id, name, description, status, event_name, matcher_json,
        extension_logic_json, post_actions_json, claude_response_json,
        version, created_by, updated_by, published_at
      ) VALUES ('legacy-sql', 'SQL 响应指标记录', 'combined', 'published', 'Stop', '{}',
        '{"language":"javascript","code":"return {};","outputs":[]}', ?, '{"bindings":{}}',
        6, 1, 1, CURRENT_TIMESTAMP)
    `).run(JSON.stringify(legacyActions));
    database.prepare(`
      INSERT INTO user_hook_bindings (user_id, hook_id, bound_by)
      VALUES (2, 'legacy-sql', 2)
    `).run();
    database.prepare(`
      INSERT INTO hook_executions (
        id, hook_id, hook_version, user_id, event_name, status
      ) VALUES ('legacy-execution', 'legacy-sql', 6, 2, 'Stop', 'succeeded')
    `).run();
    database.prepare(`
      INSERT INTO hook_data_records (
        id, execution_id, hook_id, user_id, record_type, data_json
      ) VALUES ('legacy-record', 'legacy-execution', 'legacy-sql', 2, 'sql_response_metrics', '{"sqlLineCount":3}')
    `).run();

    assert.deepEqual(migrateHookActivationModel(database), {
      migratedGlobalEnabled: false,
      addedActivationScope: false,
      addedBindingController: false,
      removedBindingSource: false,
      separatedSqlCheckHooks: 1,
    });

    const hooks = database.prepare(`
      SELECT id, name, binding_controller, post_actions_json
      FROM hooks
      ORDER BY name
    `).all();
    const checkHook = hooks.find((hook) => hook.name === 'SQL Check 强制校验');
    const recordHook = hooks.find((hook) => hook.name === 'SQL 行数记录');
    assert.equal(checkHook.id, 'legacy-sql');
    assert.equal(checkHook.binding_controller, 'sql_check');
    assert.deepEqual(JSON.parse(checkHook.post_actions_json).map((action) => action.type), ['call_mcp_tool']);
    assert.equal(recordHook.binding_controller, 'admin');
    assert.deepEqual(JSON.parse(recordHook.post_actions_json).map((action) => action.type), ['write_record']);
    assert.deepEqual(
      database.prepare('SELECT hook_id FROM user_hook_bindings WHERE user_id = 2 ORDER BY hook_id').all(),
      [{ hook_id: recordHook.id }, { hook_id: 'legacy-sql' }].sort((left, right) => left.hook_id.localeCompare(right.hook_id)),
    );
    assert.equal(
      database.prepare("SELECT hook_id FROM hook_data_records WHERE id = 'legacy-record'").get().hook_id,
      recordHook.id,
    );
  } finally {
    database.close();
  }
});

test('legacy failure notification and HTTP 200 recovery Hook migrates into two independent Hooks', () => {
  const { database } = createFixture();
  try {
    database.prepare("INSERT INTO tenants (id, code, name, status) VALUES (1, 'alpha', 'Alpha', 'active')").run();
    const legacyActions = [{
      id: 'notify-and-recover',
      type: 'invoke_skill',
      position: 0,
      config: {
        skillId: 'builtin:hook-notification',
        skillName: 'hook-notification',
        argumentsTemplate: 'status=failure details={{event.error_details}}',
      },
    }];
    database.prepare(`
      INSERT INTO hooks (
        id, name, description, status, event_name, matcher_json,
        extension_logic_json, post_actions_json, claude_response_json,
        version, activation_scope, binding_controller,
        created_by, updated_by, published_at
      ) VALUES ('legacy-failure-recovery', '失败通知与 HTTP 200 会话恢复', 'combined',
        'published', 'StopFailure', '{}', 'null', ?, '{"bindings":{}}',
        4, 'manual', 'admin', 1, 1, CURRENT_TIMESTAMP)
    `).run(JSON.stringify(legacyActions));
    database.prepare(`
      INSERT INTO user_hook_bindings (user_id, hook_id, bound_by)
      VALUES (2, 'legacy-failure-recovery', 1)
    `).run();
    database.prepare(`
      INSERT INTO hook_tenant_bindings (hook_id, tenant_id, bound_by)
      VALUES ('legacy-failure-recovery', 1, 1)
    `).run();

    migrateHookActivationModel(database);

    const hooks = database.prepare(`
      SELECT id, name, status, event_name, extension_logic_json, post_actions_json
      FROM hooks
      WHERE name IN ('失败通知', 'HTTP 200 会话恢复')
      ORDER BY name
    `).all();
    assert.equal(hooks.length, 2);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM hooks WHERE name = '失败通知与 HTTP 200 会话恢复'
    `).get().count, 0);

    const failureHook = hooks.find((hook) => hook.name === '失败通知');
    const recoveryHook = hooks.find((hook) => hook.name === 'HTTP 200 会话恢复');
    assert.equal(failureHook.id, 'legacy-failure-recovery');
    assert.equal(failureHook.status, 'published');
    assert.equal(failureHook.event_name, 'StopFailure');
    assert.equal(failureHook.extension_logic_json, 'null');
    const failureAction = JSON.parse(failureHook.post_actions_json)[0];
    assert.equal(failureAction.config.skillId, 'builtin:hook-notification');
    assert.equal(failureAction.config.condition, null);
    assert.doesNotMatch(failureAction.config.argumentsTemplate, /error_details|details=/);

    const recoveryExtension = JSON.parse(recoveryHook.extension_logic_json);
    const recoveryAction = JSON.parse(recoveryHook.post_actions_json)[0];
    assert.deepEqual(recoveryExtension.outputs.map((output) => output.name), ['shouldRecover']);
    assert.deepEqual(recoveryAction.config.condition, {
      source: 'reference',
      path: 'script.output.shouldRecover',
    });
    assert.match(recoveryAction.config.argumentsTemplate, /event\.error_details/);

    assert.deepEqual(
      database.prepare('SELECT hook_id FROM user_hook_bindings WHERE user_id = 2 ORDER BY hook_id').all(),
      [{ hook_id: failureHook.id }, { hook_id: recoveryHook.id }]
        .sort((left, right) => left.hook_id.localeCompare(right.hook_id)),
    );
    assert.deepEqual(
      database.prepare('SELECT hook_id FROM hook_tenant_bindings WHERE tenant_id = 1 ORDER BY hook_id').all(),
      [{ hook_id: failureHook.id }, { hook_id: recoveryHook.id }]
        .sort((left, right) => left.hook_id.localeCompare(right.hook_id)),
    );

    migrateHookActivationModel(database);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM hooks WHERE name IN ('失败通知', 'HTTP 200 会话恢复')
    `).get().count, 2);
  } finally {
    database.close();
  }
});

test('SQL Check Hook bindings are controlled by each user enforcement preference', () => {
  const { database, service } = createFixture();
  try {
    const created = service.createHook({
      userId: 1,
      input: publishableHook({ name: 'SQL Check 强制校验' }),
    });
    assert.equal(created.bindingController, 'sql_check');
    const published = service.publishHook({ hookId: created.id, userId: 1 });
    assert.equal(published.status, 'published');
    assert.deepEqual(service.getSqlCheckEnforcement({ userId: 2 }), {
      available: true,
      enabled: false,
      hookId: created.id,
      hookName: 'SQL Check 强制校验',
      hookStatus: 'published',
      reason: null,
    });

    assert.throws(
      () => service.listHookBindings(created.id),
      /managed by each user from the SQL Check page/,
    );
    assert.throws(
      () => service.replaceHookBindings({
        hookId: created.id,
        scope: 'all_users',
        boundBy: 1,
      }),
      /managed by each user from the SQL Check page/,
    );
    assert.throws(
      () => service.deleteHook(created.id),
      /cannot be deleted/,
    );

    const enabled = service.setSqlCheckEnforcement({ userId: 2, enabled: true });
    assert.equal(enabled.enabled, true);
    assert.equal(service.getHook(created.id).boundUserCount, 1);
    assert.deepEqual(service.listActiveHooksForUser(2).map((hook) => hook.id), [created.id]);

    const disabled = service.setSqlCheckEnforcement({ userId: 2, enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(service.getHook(created.id).boundUserCount, 0);
    assert.deepEqual(service.listActiveHooksForUser(2), []);
  } finally {
    database.close();
  }
});

test('write_record is a publishable post action and validates its field references', () => {
  const { database, service } = createFixture();
  try {
    const created = service.createHook({
      userId: 1,
      input: publishableHook({
        extensionLogic: null,
        postActions: [{
          id: 'record-stop',
          type: 'write_record',
          config: {
            recordType: 'conversation_completion',
            condition: null,
            fields: {
              sessionId: { source: 'reference', path: 'event.session_id' },
              status: { source: 'literal', value: 'success' },
            },
          },
        }],
      }),
    });
    const published = service.publishHook({ hookId: created.id, userId: 1 });
    assert.equal(published.status, 'published');
    assert.equal(published.postActions[0].type, 'write_record');
    assert.equal(published.postActions[0].config.recordType, 'conversation_completion');
    assert.deepEqual(published.postActions[0].config.fields.sessionId, {
      source: 'reference',
      path: 'event.session_id',
    });
  } finally {
    database.close();
  }
});

test('execution audit and script data records can be queried for an Hook', () => {
  const { database, service } = createFixture();
  try {
    const hook = service.createHook({ input: publishableHook(), userId: 1 });
    assert.equal(hook.hasDataRecords, false);
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
    assert.equal(service.getHook(hook.id).hasDataRecords, true);
    assert.equal(service.listHooks().find((item) => item.id === hook.id).hasDataRecords, true);
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
              condition: { source: 'literal', value: true },
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
              skillId: 'builtin:hook-notification',
              skillName: 'hook-notification',
              condition: { source: 'literal', value: true },
              argumentsTemplate: '用户 {{ccui.env.userId}}，短信结果 {{actions.send-sms.output}}',
            },
          },
        ],
        claudeResponse: { bindings: {} },
      }),
    });

    assert.equal(created.postActions.length, 2);
    assert.equal(created.postActions[0].position, 0);
    assert.equal(created.postActions[1].position, 1);
    assert.deepEqual(created.postActions[0].config.condition, { source: 'literal', value: true });
    assert.deepEqual(created.postActions[1].config.condition, { source: 'literal', value: true });
    const published = service.publishHook({
      hookId: created.id,
      userId: 1,
      validatedSkills: [{ skillId: 'builtin:hook-notification', name: 'hook-notification' }],
    });
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
          config: {
            skillId: 'builtin:hook-notification',
            skillName: 'hook-notification',
            argumentsTemplate: '',
          },
        }],
      }),
    });
    assert.equal(stopSkill.postActions[0].type, 'invoke_skill');

    assert.throws(() => service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'Stop',
        postActions: [{
          id: 'legacy-market-skill',
          type: 'invoke_skill',
          position: 0,
          config: { skillId: 'skill-1', skillName: 'notify-user', argumentsTemplate: '' },
        }],
      }),
    }), /must reference a built-in Hook Skill/);

    assert.throws(() => service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'SessionEnd',
        postActions: [{
          id: 'recover',
          type: 'invoke_skill',
          position: 0,
          config: { skillName: 'notify-user', argumentsTemplate: '' },
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

test('legacy non-built-in Skill references remain readable but cannot be republished', () => {
  const { database, service } = createFixture();
  try {
    const created = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'Stop',
        postActions: [{
          id: 'notify',
          type: 'invoke_skill',
          position: 0,
          config: {
            skillId: 'builtin:hook-notification',
            skillName: 'hook-notification',
            argumentsTemplate: '',
          },
        }],
      }),
    });
    database.prepare('UPDATE hooks SET post_actions_json = ? WHERE id = ?').run(JSON.stringify([{
      id: 'notify',
      type: 'invoke_skill',
      position: 0,
      config: {
        skillId: 'legacy-market-skill',
        skillName: 'legacy-notifier',
        argumentsTemplate: '',
      },
    }]), created.id);

    const listed = service.listHooks().find((hook) => hook.id === created.id);
    assert.equal(listed.postActions[0].config.skillId, 'legacy-market-skill');
    assert.throws(() => service.publishHook({
      hookId: created.id,
      userId: 1,
      validatedSkills: [],
    }), /must reference a built-in Hook Skill/);
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

test('requested Hook example initialization marker is persisted', () => {
  const { database, service } = createFixture();
  try {
    assert.equal(service.areRequestedExamplesInitialized(), false);
    service.markRequestedExamplesInitialized();
    assert.equal(service.areRequestedExamplesInitialized(), true);
  } finally {
    database.close();
  }
});

test('configuration migration removes legacy script output descriptions', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE hooks (
        id TEXT PRIMARY KEY,
        extension_logic_json TEXT NOT NULL DEFAULT 'null'
      );
      INSERT INTO hooks (id, extension_logic_json) VALUES (
        'legacy-output',
        '{"language":"javascript","code":"return {};","outputs":[{"name":"result","type":"string","description":"legacy label"}]}'
      );
    `);

    migrateHookConfigurationModel(database);

    assert.deepEqual(
      JSON.parse(database.prepare(`
        SELECT extension_logic_json FROM hooks WHERE id = 'legacy-output'
      `).get().extension_logic_json),
      {
        language: 'javascript',
        code: 'return {};',
        outputs: [{ name: 'result', type: 'string' }],
      },
    );
  } finally {
    database.close();
  }
});

test('legacy global activation migrates to a dynamic all-user scope without binding triggers', () => {
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
      addedBindingController: true,
      removedBindingSource: false,
      separatedSqlCheckHooks: 0,
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
      addedBindingController: false,
      removedBindingSource: false,
      separatedSqlCheckHooks: 0,
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
      addedBindingController: true,
      removedBindingSource: true,
      separatedSqlCheckHooks: 0,
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
    assert.deepEqual(
      database.prepare('SELECT id, activation_scope FROM hooks ORDER BY id').all(),
      [
        { id: 'global', activation_scope: 'all_users' },
        { id: 'personal', activation_scope: 'manual' },
      ],
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
      { path: 'ccui.env.sqlCheckRuleIds', type: 'array' },
    ]);
  } finally {
    database.close();
  }
});
