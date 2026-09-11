import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { executeHookScript } from './hook-script-executor.js';
import { createHookRuntimeSession } from './hook-runtime.js';

const MCP_LOOP_TERMINATION_SCRIPT = `async def run(event, ccui):
    status = (event.get("result") or {}).get("status")
    return {"output": {"status": status if status in ("success", "failed") else "running"}}
`;

function createFixture({ hookMcpServers = [], hookMcpTools = [] } = {}) {
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
    service: createHookConfigService({
      database,
      configStore,
      hookMcpCatalog: {
        listServers: () => hookMcpServers,
        listToolResources: () => hookMcpTools,
      },
    }),
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

test('subagent switch persists across edits and immutable published versions', () => {
  const { database, service } = createFixture();
  try {
    const created = service.createHook({ userId: 1, input: publishableHook({ eventName: 'PreToolUse' }) });
    assert.equal(created.includeSubagents, false);
    service.publishHook({ hookId: created.id, userId: 1 });
    const updated = service.updateHook({
      hookId: created.id, userId: 1,
      input: publishableHook({ eventName: 'PreToolUse', includeSubagents: true }),
    });
    assert.equal(updated.includeSubagents, true);
    service.publishHook({ hookId: created.id, userId: 1 });
    assert.equal(service.getPublishedHookVersion({ hookId: created.id, version: 1 }).includeSubagents, false);
    assert.equal(service.getPublishedHookVersion({ hookId: created.id, version: 2 }).includeSubagents, true);
    // An older client changing a description must not silently turn it off.
    assert.equal(service.updateHook({
      hookId: created.id, userId: 1, input: publishableHook({ eventName: 'PreToolUse', description: 'Edited' }),
    }).includeSubagents, true);
    assert.equal(service.updateHook({
      hookId: created.id, userId: 1,
      input: publishableHook({ eventName: 'PreToolUse', includeSubagents: false }),
    }).includeSubagents, false);
  } finally { database.close(); }
});

test('legacy subagent defaults preserve tool callbacks without adding Stop callbacks', () => {
  const { database, service } = createFixture();
  try {
    for (const eventName of ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop']) {
      const created = service.createHook({ userId: 1, input: publishableHook({ eventName }) });
      database.prepare('UPDATE hooks SET include_subagents = NULL WHERE id = ?').run(created.id);
      const expected = ['PreToolUse', 'PostToolUse'].includes(eventName);
      assert.equal(service.getHook(created.id).includeSubagents, expected);
      service.publishHook({ hookId: created.id, userId: 1 });
      const snapshot = JSON.parse(database.prepare('SELECT config_json FROM hook_published_versions WHERE hook_id = ?').get(created.id).config_json);
      delete snapshot.includeSubagents;
      database.prepare('UPDATE hook_published_versions SET config_json = ? WHERE hook_id = ?').run(JSON.stringify(snapshot), created.id);
      assert.equal(service.getPublishedHookVersion({ hookId: created.id, version: 1 }).includeSubagents, expected);
      migrateHookConfigurationModel(database);
      assert.equal(service.getHook(created.id).includeSubagents, expected);
    }
  } finally { database.close(); }
});

test('subagent switch rejects invalid values and events with no equivalent child callback', () => {
  const { database, service } = createFixture();
  try {
    for (const includeSubagents of ['true', 1, null, {}]) {
      assert.throws(() => service.createHook({ userId: 1, input: publishableHook({ includeSubagents }) }), /includeSubagents must be boolean/);
    }
    for (const eventName of ['UserPromptSubmit', 'SessionStart', 'StopFailure', 'SubagentStop']) {
      assert.throws(() => service.createHook({ userId: 1, input: publishableHook({ eventName, includeSubagents: true }) }), /不支持同时对子代理生效/);
    }
  } finally { database.close(); }
});

test('extensionLogic failClosed is optional, strictly boolean, and survives persistence', () => {
  const { database, service } = createFixture();
  try {
    const legacy = publishableHook();
    const original = service.createHook({ input: legacy, userId: 1 });
    assert.deepEqual(original.extensionLogic, legacy.extensionLogic);
    assert.equal(Object.hasOwn(original.extensionLogic, 'failClosed'), false);
    for (const failClosed of [true, false]) {
      const created = service.createHook({
        userId: 1,
        input: publishableHook({ extensionLogic: { ...legacy.extensionLogic, failClosed } }),
      });
      assert.equal(created.extensionLogic.failClosed, failClosed);
      assert.equal(service.getHook(created.id).extensionLogic.failClosed, failClosed);
      assert.equal(service.publishHook({ hookId: created.id, userId: 1 }).extensionLogic.failClosed, failClosed);
    }
    for (const failClosed of ['true', 1, null, {}]) {
      assert.throws(() => service.createHook({
        userId: 1,
        input: publishableHook({ extensionLogic: { ...legacy.extensionLogic, failClosed } }),
      }), /failClosed must be boolean/);
    }
  } finally { database.close(); }
});

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
    assert.equal(firstBinding.hook.scopedUserCount, 1);
    assert.equal(firstBinding.hook.boundUserCount, 0);
    assert.equal(service.listAvailableHooksForUser(1)[0].enabled, false);
    assert.deepEqual(service.listActiveHooksForUser(1), []);
    assert.deepEqual(service.listActiveHooksForUser(2), []);
    service.setUserHookEnabled({ userId: 1, hookId: created.id, enabled: true });
    assert.deepEqual(service.listActiveHooksForUser(1).map((hook) => hook.id), [created.id]);
    assert.equal(service.listActiveHooksForUser(1)[0].showInChat, true);
    service.setUserHookChatVisibility({ userId: 1, hookId: created.id, showInChat: false });
    assert.equal(service.listAvailableHooksForUser(1)[0].showInChat, false);
    assert.equal(service.listActiveHooksForUser(1)[0].showInChat, false);
    assert.equal(service.getUserHookChatVisibility({ userId: 1, hookId: created.id }), false);
    service.setUserHookEnabled({ userId: 1, hookId: created.id, enabled: false });
    service.setUserHookEnabled({ userId: 1, hookId: created.id, enabled: true });
    assert.equal(service.listActiveHooksForUser(1)[0].showInChat, false);

    database.prepare('INSERT INTO users (id, username) VALUES (3, ?)').run('new-member');
    assert.deepEqual(service.listAvailableHooksForUser(3), []);
    assert.deepEqual(service.listActiveHooksForUser(3), []);

    const reassigned = service.replaceHookBindings({
      hookId: created.id,
      userIds: [2, 3, 3],
      boundBy: 1,
    });
    assert.equal(reassigned.hook.scopedUserCount, 2);
    assert.equal(reassigned.hook.boundUserCount, 0);
    assert.deepEqual(service.listActiveHooksForUser(1), []);
    assert.equal(service.listAvailableHooksForUser(2)[0].enabled, false);
    service.setUserHookEnabled({ userId: 2, hookId: created.id, enabled: true });
    service.setUserHookEnabled({ userId: 3, hookId: created.id, enabled: true });
    assert.equal(service.listActiveHooksForUser(2)[0].showInChat, true);
    assert.deepEqual(service.listActiveHooksForUser(2).map((hook) => hook.id), [created.id]);
    assert.deepEqual(service.listActiveHooksForUser(3).map((hook) => hook.id), [created.id]);
    database.prepare('INSERT INTO users (id, username) VALUES (4, ?)').run('later-member');
    assert.deepEqual(service.listActiveHooksForUser(4), []);

    const globalBinding = service.replaceHookBindings({
      hookId: created.id,
      scope: 'all_users',
      boundBy: 1,
    });
    assert.equal(globalBinding.hook.activationScope, 'all_users');
    assert.equal(globalBinding.hook.boundTenantCount, 0);
    assert.equal(service.listAvailableHooksForUser(1)[0].enabled, false);
    assert.deepEqual(service.listActiveHooksForUser(1), []);
    database.prepare('INSERT INTO users (id, username) VALUES (5, ?)').run('future-global-member');
    assert.equal(service.listAvailableHooksForUser(5)[0].enabled, false);
    assert.deepEqual(service.listActiveHooksForUser(5), []);
    service.setUserHookEnabled({ userId: 5, hookId: created.id, enabled: true });
    assert.deepEqual(service.listActiveHooksForUser(5).map((hook) => hook.id), [created.id]);

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

test('tenant Hook scopes dynamically grant visibility to active tenant members', () => {
  const { database, service } = createFixture();
  try {
    database.prepare(`
      INSERT INTO tenants (id, code, name, status)
      VALUES (1, 'alpha', 'Alpha', 'active'), (2, 'disabled', 'Disabled', 'disabled')
    `).run();
    database.prepare(`
      INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
      VALUES (1, 2, 'member', 'view', 'active')
    `).run();

    const created = service.createHook({ input: publishableHook(), userId: 1 });
    service.publishHook({ hookId: created.id, userId: 1 });
    const tenantScope = service.replaceHookBindings({
      hookId: created.id,
      scope: 'tenants',
      tenantIds: [1, 1],
      boundBy: 1,
    });

    assert.equal(tenantScope.hook.activationScope, 'manual');
    assert.equal(tenantScope.hook.scopedUserCount, 0);
    assert.equal(tenantScope.hook.boundTenantCount, 1);
    assert.deepEqual(service.listHookBindings(created.id).tenants.map((tenant) => ({
      id: tenant.id,
      active: tenant.active,
      activeUserCount: tenant.activeUserCount,
      bound: tenant.bound,
    })), [
      { id: 1, active: true, activeUserCount: 1, bound: true },
      { id: 2, active: false, activeUserCount: 0, bound: false },
    ]);
    assert.equal(service.listHookBindings(created.id).scope, 'tenants');
    assert.deepEqual(service.listAvailableHooksForUser(1), []);
    assert.equal(service.listAvailableHooksForUser(2)[0].enabled, false);
    assert.throws(
      () => service.setUserHookEnabled({ userId: 1, hookId: created.id, enabled: true }),
      /not available/,
    );

    service.setUserHookEnabled({ userId: 2, hookId: created.id, enabled: true });
    assert.deepEqual(service.listActiveHooksForUser(2).map((hook) => hook.id), [created.id]);

    database.prepare('INSERT INTO users (id, username) VALUES (3, ?)').run('future-member');
    database.prepare(`
      INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
      VALUES (1, 3, 'member', 'view', 'active')
    `).run();
    assert.equal(service.listAvailableHooksForUser(3)[0].enabled, false);
    service.setUserHookEnabled({ userId: 3, hookId: created.id, enabled: true });
    assert.deepEqual(service.listActiveHooksForUser(3).map((hook) => hook.id), [created.id]);

    database.prepare(`
      UPDATE tenant_users SET status = 'disabled' WHERE tenant_id = 1 AND user_id = 2
    `).run();
    assert.deepEqual(service.listAvailableHooksForUser(2), []);
    assert.deepEqual(service.listActiveHooksForUser(2), []);

    const userScope = service.replaceHookBindings({
      hookId: created.id,
      scope: 'users',
      userIds: [1],
      boundBy: 1,
    });
    assert.equal(userScope.hook.boundTenantCount, 0);
    assert.equal(userScope.hook.scopedUserCount, 1);
    assert.equal(userScope.hook.boundUserCount, 0);
    assert.deepEqual(service.listActiveHooksForUser(3), []);

    assert.throws(
      () => service.replaceHookBindings({
        hookId: created.id,
        scope: 'tenants',
        tenantIds: [],
        boundBy: 1,
      }),
      /Select at least one active tenant/,
    );
    assert.throws(
      () => service.replaceHookBindings({
        hookId: created.id,
        scope: 'tenants',
        tenantIds: [2],
        boundBy: 1,
      }),
      /do not exist or are inactive/,
    );
  } finally {
    database.close();
  }
});

function createTenantScopedWorkspaceHookFixture() {
  const fixture = createFixture();
  const { database, service } = fixture;
  database.prepare(`
    INSERT INTO tenants (id, code, name, status)
    VALUES (10, 'alpha', 'Alpha', 'active'), (20, 'beta', 'Beta', 'active')
  `).run();
  database.prepare(`
    INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
    VALUES (10, 2, 'member', 'view', 'active'), (20, 2, 'member', 'view', 'active')
  `).run();
  database.prepare(`
    INSERT INTO workspaces (id, tenant_id, owner_user_id, slug, display_name, path)
    VALUES
      (100, 10, 2, 'alpha-first', 'Alpha First', '/tmp/hook-alpha-first'),
      (101, 10, 2, 'alpha-second', 'Alpha Second', '/tmp/hook-alpha-second'),
      (200, 20, 2, 'beta', 'Beta', '/tmp/hook-beta')
  `).run();
  const hook = service.createHook({ input: publishableHook(), userId: 1 });
  service.publishHook({ hookId: hook.id, userId: 1 });
  service.replaceHookBindings({ hookId: hook.id, scope: 'tenants', tenantIds: [10], boundBy: 1 });
  return {
    ...fixture,
    hookId: hook.id,
    alpha: { userId: 2, tenantId: 10, workspaceId: 100 },
    alphaSecond: { userId: 2, tenantId: 10, workspaceId: 101 },
    beta: { userId: 2, tenantId: 20, workspaceId: 200 },
  };
}

test('admin defaults directly enable selected users and hidden Hooks still execute and record data', async () => {
  const { database, service, hookId, alpha, beta } = createTenantScopedWorkspaceHookFixture();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-admin-defaults-'));
  try {
    service.updateHook({ hookId, userId: 1, input: publishableHook({
      extensionLogic: null,
      postActions: [{ id: 'record', type: 'write_record', config: {
        recordType: 'admin_default_execution',
        fields: { status: { source: 'literal', value: 'done' } },
      } }],
    }) });
    service.publishHook({ hookId, userId: 1 });
    const saved = service.replaceHookBindings({
      hookId, userIds: [2], defaultEnabled: true, defaultShowInChat: false, boundBy: 1,
    });
    assert.equal(saved.hook.defaultEnabled, true);
    assert.equal(saved.hook.defaultShowInChat, false);
    const bindings = service.listHookBindings(hookId);
    assert.equal(bindings.defaultEnabled, true);
    assert.equal(bindings.defaultShowInChat, false);
    assert.equal(bindings.users.find((user) => user.id === 2).enabled, true);
    assert.deepEqual(service.listActiveHooksForUser(1), []);
    assert.deepEqual(service.listEffectiveHooksForContext({ ...alpha, userId: 1 }), []);
    assert.equal(service.listActiveHooksForUser(2)[0].showInChat, false);
    for (const context of [alpha, beta]) {
      assert.equal(service.listEffectiveHooksForContext(context)[0].showInChat, false);
      assert.equal(service.getUserHookChatVisibility({ ...context, hookId }), false);
      assert.equal(service.getWorkspaceUserHookChatVisibility({ ...context, hookId }), false);
    }
    assert.equal(service.getUserHookChatVisibility({ userId: 2, hookId }), false);
    const hook = service.listEffectiveHooksForContext(alpha)[0];
    const runtime = createHookRuntimeSession({ hooks: [hook], ...alpha, workspaceRoot, database });
    await runtime.executeHook(hook, { hook_event_name: 'Stop', session_id: 'admin-defaults', last_assistant_message: 'done' });
    const record = database.prepare('SELECT record_type, data_json FROM hook_data_records WHERE hook_id = ?').get(hookId);
    assert.equal(record.record_type, 'admin_default_execution');
    assert.deepEqual(JSON.parse(record.data_json), { status: 'done' });
    assert.equal(database.prepare('SELECT status FROM hook_executions WHERE hook_id = ?').get(hookId).status, 'succeeded');
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('admin tenant and all-user defaults include future users while keeping tenant scope and validation', () => {
  const { database, service, hookId, alpha, beta } = createTenantScopedWorkspaceHookFixture();
  try {
    service.replaceHookBindings({ hookId, scope: 'tenants', tenantIds: [10], defaultEnabled: true, defaultShowInChat: false, boundBy: 1 });
    assert.equal(service.listEffectiveHooksForContext(alpha)[0].id, hookId);
    assert.deepEqual(service.listEffectiveHooksForContext(beta), []);
    database.prepare("INSERT INTO users (id, username) VALUES (3, 'future-member')").run();
    database.prepare("INSERT INTO tenant_users (tenant_id, user_id, status) VALUES (10, 3, 'active')").run();
    assert.equal(service.listActiveHooksForUser(3)[0].showInChat, false);
    assert.equal(service.listEffectiveHooksForContext({ ...alpha, userId: 3 })[0].id, hookId);
    database.prepare("UPDATE tenant_users SET status = 'disabled' WHERE tenant_id = 10 AND user_id = 3").run();
    assert.deepEqual(service.listActiveHooksForUser(3), []);
    assert.deepEqual(service.listEffectiveHooksForContext({ ...alpha, userId: 3 }), []);
    const before = service.listHookBindings(hookId);
    for (const invalid of [{ defaultEnabled: 'true' }, { defaultShowInChat: 0 }, { defaultShowInChat: null }]) {
      assert.throws(() => service.replaceHookBindings({ hookId, scope: 'all_users', boundBy: 1, ...invalid }), { statusCode: 400 });
      assert.deepEqual(service.listHookBindings(hookId), before);
    }
    // Older clients that only save scope must not reset defaults.
    service.replaceHookBindings({ hookId, scope: 'all_users', boundBy: 1 });
    database.prepare("INSERT INTO users (id, username) VALUES (4, 'future-global-member')").run();
    assert.equal(service.listActiveHooksForUser(4)[0].showInChat, false);
    assert.equal(service.listEffectiveHooksForContext(beta)[0].showInChat, false);
    service.replaceHookBindings({ hookId, userIds: [], boundBy: 1 });
    assert.deepEqual(service.listActiveHooksForUser(4), []);
    assert.deepEqual(service.listEffectiveHooksForContext(alpha), []);
  } finally { database.close(); }
});

test('normal saves and publication preserve personal choices; overwrite requires an explicit opt-in each time', () => {
  for (const enabled of [false, true]) {
    for (const showInChat of [false, true]) {
      const { database, service, hookId, alpha, alphaSecond } = createTenantScopedWorkspaceHookFixture();
      try {
        service.replaceHookBindings({ hookId, userIds: [2], boundBy: 1 });
        service.setUserHookEnabled({ hookId, userId: 2, enabled });
        service.setUserHookChatVisibility({ hookId, userId: 2, showInChat });
        for (const context of [alpha, alphaSecond]) {
          service.setWorkspaceUserHookEnabled({ ...context, hookId, enabled });
          service.setWorkspaceUserHookChatVisibility({ ...context, hookId, showInChat });
        }
        const preferences = () => Object.fromEntries([
          'user_hook_bindings', 'user_hook_opt_outs', 'user_hook_preferences', 'user_workspace_hook_preferences',
        ].map(table => [table, database.prepare(`SELECT * FROM ${table} WHERE hook_id = ?`).all(hookId)]));
        const initialPreferences = preferences();
        const check = (expectedEnabled, expectedShowInChat) => {
          for (const context of [alpha, alphaSecond]) {
            const hook = service.listAvailableHooksForContext(context)[0];
            assert.equal(hook.enabled, expectedEnabled);
            assert.equal(hook.showInChat, expectedShowInChat);
            assert.equal(service.getUserHookChatVisibility({ ...context, hookId }), expectedShowInChat);
          }
          assert.equal(service.listAvailableHooksForUser(2)[0].enabled, expectedEnabled);
          assert.equal(service.getUserHookChatVisibility({ userId: 2, hookId }), expectedShowInChat);
        };
        const save = (options = {}) => service.replaceHookBindings({
          hookId, userIds: [2], defaultEnabled: !enabled, defaultShowInChat: !showInChat, boundBy: 1, ...options,
        });
        // Omitted and explicitly disabled overwrite flags are both safe.
        for (const options of [{}, { overwriteUserPreferences: false }]) {
          save(options);
          check(enabled, showInChat);
          assert.deepEqual(preferences(), initialPreferences);
          assert.equal(service.getHook(hookId).defaultEnabled, !enabled);
          assert.equal(service.getHook(hookId).defaultShowInChat, !showInChat);
        }
        // The editor saves a draft and republishes before opening the bindings dialog.
        service.updateHook({ hookId, userId: 1, input: publishableHook({ description: 'Republished without overwriting users' }) });
        service.publishHook({ hookId, userId: 1 });
        save();
        check(enabled, showInChat);
        assert.deepEqual(preferences(), initialPreferences);
        save({ overwriteUserPreferences: true });
        check(!enabled, !showInChat);
        // Opt-in is not persisted; a later normal save cannot repeat it.
        service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled });
        service.setWorkspaceUserHookChatVisibility({ ...alpha, hookId, showInChat });
        const afterUserChange = preferences();
        save();
        assert.deepEqual(preferences(), afterUserChange);
        assert.equal(service.listAvailableHooksForContext(alpha)[0].enabled, enabled);
        assert.equal(service.listAvailableHooksForContext(alpha)[0].showInChat, showInChat);
      } finally { database.close(); }
    }
  }
});

test('invalid overwrite flags are rejected before modifying defaults or preferences', () => {
  const { database, service, hookId } = createTenantScopedWorkspaceHookFixture();
  try {
    const before = service.getHook(hookId);
    for (const overwriteUserPreferences of [null, 'true', 1, {}]) {
      assert.throws(() => service.replaceHookBindings({
        hookId, scope: 'all_users', defaultEnabled: true, overwriteUserPreferences, boundBy: 1,
      }), /overwriteUserPreferences must be a boolean/);
      assert.deepEqual(service.getHook(hookId), before);
    }
  } finally { database.close(); }
});

test('administrator and workspace user saves overwrite each other independently, including unchanged admin values', () => {
  const { database, service, hookId, alpha, alphaSecond } = createTenantScopedWorkspaceHookFixture();
  try {
    service.replaceHookBindings({ overwriteUserPreferences: true, hookId, scope: 'all_users', boundBy: 1 });
    service.setUserHookEnabled({ hookId, userId: 2, enabled: false });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: false });
    service.setWorkspaceUserHookEnabled({ ...alphaSecond, hookId, enabled: false });
    const saveAdmin = (settings) => service.replaceHookBindings({ overwriteUserPreferences: true, hookId, userIds: [2], boundBy: 1, ...settings });
    const check = (context, enabled, showInChat) => {
      const hook = service.listAvailableHooksForContext(context)[0];
      assert.equal(hook.enabled, enabled);
      assert.equal(hook.showInChat, showInChat);
      assert.equal(service.getWorkspaceUserHookChatVisibility({ ...context, hookId }), showInChat);
      assert.equal(service.getUserHookChatVisibility({ ...context, hookId }), showInChat);
      assert.equal(service.listEffectiveHooksForContext(context).length, Number(enabled));
    };
    for (const adminEnabled of [true, false, true]) {
      saveAdmin({ defaultEnabled: adminEnabled, defaultShowInChat: false });
      check(alpha, adminEnabled, false);
      check(alphaSecond, adminEnabled, false);
      service.setWorkspaceUserHookChatVisibility({ ...alpha, hookId, showInChat: true });
      check(alpha, adminEnabled, true);
      service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: !adminEnabled });
      check(alpha, !adminEnabled, true);
      check(alphaSecond, adminEnabled, false);
      // Re-saving the same admin values must still overwrite newer user choices.
      saveAdmin({ defaultEnabled: adminEnabled, defaultShowInChat: false });
      check(alpha, adminEnabled, false);
      service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: !adminEnabled });
      saveAdmin({ defaultShowInChat: true });
      check(alpha, !adminEnabled, true);
      saveAdmin({ defaultEnabled: adminEnabled });
      check(alpha, adminEnabled, true);
      service.setWorkspaceUserHookChatVisibility({ ...alpha, hookId, showInChat: false });
      saveAdmin({}); // Older clients changing only scope must preserve both choices.
      check(alpha, adminEnabled, false);
    }
    assert.deepEqual(service.listActiveHooksForUser(1), []);
  } finally { database.close(); }
});

test('legacy user saves can override administrator activation and visibility, then be overwritten again', () => {
  const { database, service, hookId, alpha } = createTenantScopedWorkspaceHookFixture();
  try {
    service.assignWorkspaceHook({ workspaceId: alpha.workspaceId, hookId, defaultEnabled: true, createdBy: 1 });
    for (const defaultEnabled of [true, false]) {
      service.replaceHookBindings({ overwriteUserPreferences: true, hookId, scope: 'all_users', defaultEnabled, defaultShowInChat: false, boundBy: 1 });
      assert.equal(service.listAvailableHooksForUser(2)[0].enabled, defaultEnabled);
      service.setUserHookChatVisibility({ userId: 2, hookId, showInChat: true });
      assert.equal(service.listAvailableHooksForUser(2)[0].enabled, defaultEnabled);
      assert.equal(service.listAvailableHooksForContext(alpha)[0].enabled, defaultEnabled);
      service.setUserHookEnabled({ userId: 2, hookId, enabled: !defaultEnabled });
      assert.equal(service.listAvailableHooksForUser(2)[0].enabled, !defaultEnabled);
      assert.equal(service.listHookBindings(hookId).users.find(user => user.id === 2).enabled, !defaultEnabled);
      assert.equal(service.listAvailableHooksForContext(alpha)[0].enabled, !defaultEnabled);
      assert.equal(service.getUserHookChatVisibility({ userId: 2, hookId }), true);
      assert.equal(service.getUserHookChatVisibility({ ...alpha, hookId }), true);
      service.replaceHookBindings({ overwriteUserPreferences: true, hookId, scope: 'all_users', defaultEnabled, defaultShowInChat: false, boundBy: 1 });
      assert.equal(service.listAvailableHooksForUser(2)[0].enabled, defaultEnabled);
      assert.equal(service.listAvailableHooksForContext(alpha)[0].enabled, defaultEnabled);
      assert.equal(service.getUserHookChatVisibility({ userId: 2, hookId }), false);
      assert.equal(service.getUserHookChatVisibility({ ...alpha, hookId }), false);
    }
  } finally { database.close(); }
});

test('administrator activation overrides historical chat-only and captured-off records without a migration', () => {
  for (const enabled of [null, 0]) {
    const { database, service, hookId, alpha } = createTenantScopedWorkspaceHookFixture();
    try {
      database.prepare(`INSERT INTO user_workspace_hook_preferences (workspace_id, user_id, hook_id, enabled, show_in_chat)
        VALUES (?, ?, ?, ?, 0)`).run(alpha.workspaceId, 2, hookId, enabled);
      database.prepare('INSERT INTO user_hook_preferences (user_id, hook_id, show_in_chat) VALUES (2, ?, 0)').run(hookId);
      database.prepare('INSERT INTO user_hook_opt_outs (user_id, hook_id) VALUES (2, ?)').run(hookId);
      service.replaceHookBindings({ overwriteUserPreferences: true, hookId, scope: 'all_users', defaultEnabled: true, boundBy: 1 });
      assert.equal(service.listEffectiveHooksForContext(alpha)[0].id, hookId);
      assert.equal(service.listEffectiveHooksForContext(alpha)[0].showInChat, false);
      assert.equal(service.listActiveHooksForUser(2)[0].id, hookId);
      service.replaceHookBindings({ overwriteUserPreferences: true, hookId, scope: 'all_users', defaultEnabled: true, boundBy: 1 });
      assert.equal(service.listEffectiveHooksForContext(alpha)[0].id, hookId);
      assert.equal(database.prepare('SELECT enabled FROM user_workspace_hook_preferences WHERE hook_id = ?').get(hookId).enabled, 1);
    } finally { database.close(); }
  }
});

test('administrator activation overrides template defaults only inside its scope and still requires a usable version', () => {
  const { database, service, hookId, alpha, beta } = createTenantScopedWorkspaceHookFixture();
  try {
    for (const context of [alpha, beta]) {
      service.assignWorkspaceHook({ workspaceId: context.workspaceId, hookId, source: 'agent_template', sourceTemplateId: 88,
        defaultEnabled: false, defaultShowInChat: true, installStatus: 'ready', createdBy: 1 });
    }
    service.replaceHookBindings({ overwriteUserPreferences: true, hookId, scope: 'tenants', tenantIds: [10], defaultEnabled: true, defaultShowInChat: false, boundBy: 1 });
    assert.equal(service.listEffectiveHooksForContext(alpha)[0].enabled, true);
    assert.equal(service.listEffectiveHooksForContext(alpha)[0].showInChat, false);
    assert.equal(service.getWorkspaceUserHookChatVisibility({ ...alpha, hookId }), false);
    assert.equal(service.getUserHookChatVisibility({ ...alpha, hookId }), false);
    assert.equal(service.getWorkspaceUserHookChatVisibility({ ...beta, hookId }), true);
    assert.equal(service.getUserHookChatVisibility({ ...beta, hookId }), true);
    service.setWorkspaceUserHookChatVisibility({ ...beta, hookId, showInChat: false });
    assert.equal(service.getUserHookChatVisibility({ ...beta, hookId }), false);
    assert.equal(service.listAvailableHooksForContext(beta)[0].enabled, false);
    assert.deepEqual(service.listEffectiveHooksForContext(beta), []);
    service.setWorkspaceUserHookEnabled({ ...beta, hookId, enabled: true });
    assert.equal(service.listEffectiveHooksForContext(beta)[0].id, hookId);
    for (const installStatus of ['pending', 'failed', 'ready']) {
      service.assignWorkspaceHook({ workspaceId: alpha.workspaceId, hookId, source: 'agent_template', sourceTemplateId: 88,
        defaultEnabled: false, installStatus, createdBy: 1 });
      assert.equal(service.listAvailableHooksForContext(alpha)[0].enabled, installStatus === 'ready');
    }
    database.prepare('UPDATE hook_published_versions SET revoked_at = CURRENT_TIMESTAMP WHERE hook_id = ?').run(hookId);
    assert.deepEqual(service.listEffectiveHooksForContext(alpha), []);
  } finally { database.close(); }
});

test('admin saves cover shared assignments, skip deleted projects, and preserve users outside the selected scope', () => {
  const { database, service, hookId, alpha, alphaSecond } = createTenantScopedWorkspaceHookFixture();
  try {
    service.replaceHookBindings({ overwriteUserPreferences: true, hookId, scope: 'all_users', boundBy: 1 });
    service.assignWorkspaceHook({ workspaceId: alpha.workspaceId, hookId, source: 'agent_template',
      sourceTemplateId: 88, defaultEnabled: true, defaultShowInChat: true, createdBy: 1 });
    database.prepare('INSERT INTO workspace_acl (workspace_id, user_id, permission, created_by_user_id) VALUES (?, 1, ?, 1)')
      .run(alpha.workspaceId, 'view');
    service.setWorkspaceUserHookEnabled({ ...alphaSecond, hookId, enabled: true });
    database.prepare("UPDATE workspaces SET status = 'deleted' WHERE id = ?").run(alphaSecond.workspaceId);
    service.replaceHookBindings({ overwriteUserPreferences: true, hookId, userIds: [1], defaultEnabled: false, defaultShowInChat: false, boundBy: 1 });
    assert.equal(service.listAvailableHooksForContext({ ...alpha, userId: 1 })[0].enabled, false);
    assert.equal(service.listAvailableHooksForContext({ ...alpha, userId: 1 })[0].showInChat, false);
    assert.equal(service.listAvailableHooksForContext(alpha)[0].enabled, true);
    assert.equal(service.listAvailableHooksForContext(alpha)[0].showInChat, true);
    service.replaceHookBindings({ overwriteUserPreferences: true, hookId, userIds: [2], defaultEnabled: false, defaultShowInChat: false, boundBy: 1 });
    assert.equal(service.listAvailableHooksForContext(alpha)[0].enabled, false);
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true });
    service.setWorkspaceUserHookChatVisibility({ ...alpha, hookId, showInChat: true });
    assert.equal(service.listAvailableHooksForContext(alpha)[0].enabled, true);
    assert.equal(service.listAvailableHooksForContext(alpha)[0].showInChat, true);
  } finally { database.close(); }
});

test('direct enablement waits for required personal variables', () => {
  const { database, service, hookId, alpha, alphaSecond } = createTenantScopedWorkspaceHookFixture();
  try {
    service.updateHook({ hookId, userId: 1, input: publishableHook({ userVariables: [{ name: 'token', required: true, secret: true }] }) });
    service.publishHook({ hookId, userId: 1 });
    service.replaceHookBindings({ hookId, scope: 'all_users', defaultEnabled: true, defaultShowInChat: false, boundBy: 1 });
    assert.deepEqual(service.listActiveHooksForUser(2), []);
    assert.deepEqual(service.listEffectiveHooksForContext(alpha), []);
    assert.deepEqual(service.listAvailableHooksForContext(alpha)[0].missingRequiredUserVariables, ['token']);
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true, userVariables: { token: 'test-token' } });
    assert.equal(service.listEffectiveHooksForContext(alpha)[0].showInChat, false);
    assert.deepEqual(service.listEffectiveHooksForContext(alphaSecond), []);
  } finally { database.close(); }
});

test('admin Hook defaults migrate safely and persist across repeated startup migrations', () => {
  const { database, service } = createFixture();
  try {
    const hook = service.createHook({ input: publishableHook(), userId: 1 });
    service.publishHook({ hookId: hook.id, userId: 1 });
    database.exec('ALTER TABLE hooks DROP COLUMN default_enabled; ALTER TABLE hooks DROP COLUMN default_show_in_chat; DROP TABLE user_hook_opt_outs;');
    migrateHookConfigurationModel(database);
    assert.equal(service.getHook(hook.id).defaultEnabled, false);
    assert.equal(service.getHook(hook.id).defaultShowInChat, true);
    service.replaceHookBindings({ hookId: hook.id, scope: 'all_users', defaultEnabled: true, defaultShowInChat: false, boundBy: 1 });
    database.prepare('INSERT INTO user_hook_opt_outs (user_id, hook_id) VALUES (2, ?)').run(hook.id);
    migrateHookConfigurationModel(database);
    migrateHookActivationModel(database);
    assert.equal(service.getHook(hook.id).defaultEnabled, true);
    assert.equal(service.getHook(hook.id).defaultShowInChat, false);
    assert.deepEqual(service.listActiveHooksForUser(2), []);
    assert.equal(service.listActiveHooksForUser(1)[0].showInChat, false);
  } finally { database.close(); }
});

test('workspace Hook tenant scopes use the current project tenant while legacy visibility stays user-wide', () => {
  const { database, service, hookId, alpha, beta } = createTenantScopedWorkspaceHookFixture();
  try {
    assert.deepEqual(service.listAvailableHooksForUser(2).map((hook) => hook.id), [hookId]);
    assert.deepEqual(service.listAvailableHooksForContext(alpha).map((hook) => ({ id: hook.id, enabled: hook.enabled })), [
      { id: hookId, enabled: false },
    ]);
    assert.deepEqual(service.listAvailableHooksForContext(beta), []);
    // A legacy enablement must not activate the tenant-scoped Hook in another tenant.
    service.setUserHookEnabled({ userId: 2, hookId, enabled: true });
    assert.deepEqual(service.listEffectiveHooksForContext(alpha).map((hook) => hook.id), [hookId]);
    assert.deepEqual(service.listEffectiveHooksForContext(beta), []);
    for (const enabled of [true, false]) {
      assert.throws(
        () => service.setWorkspaceUserHookEnabled({ ...beta, hookId, enabled }),
        (error) => error.statusCode === 403 && /not available/.test(error.message),
      );
    }
    assert.throws(
      () => service.setWorkspaceUserHookChatVisibility({ ...beta, hookId, showInChat: false }),
      (error) => error.statusCode === 403 && /not available/.test(error.message),
    );
    assert.equal(service.getWorkspaceHookAssignment({ workspaceId: beta.workspaceId, hookId }), null);
  } finally {
    database.close();
  }
});

test('tenant-scoped Hooks can be manually enabled and hidden within a single project', () => {
  const { database, service, hookId, alpha, alphaSecond, beta } = createTenantScopedWorkspaceHookFixture();
  try {
    service.setWorkspaceUserHookChatVisibility({ ...alpha, hookId, showInChat: false });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true });
    const activeHook = service.listEffectiveHooksForContext(alpha)[0];
    assert.equal(activeHook.id, hookId);
    assert.equal(activeHook.showInChat, false);
    assert.equal(activeHook.workspaceAssignment.source, 'manual');
    assert.equal(service.listAvailableHooksForContext(alphaSecond)[0].enabled, false);
    assert.equal(service.listAvailableHooksForContext(alphaSecond)[0].showInChat, true);
    assert.deepEqual(service.listAvailableHooksForContext(beta), []);
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: false });
    assert.deepEqual(service.listEffectiveHooksForContext(alpha), []);
    assert.equal(service.listAvailableHooksForContext(alphaSecond)[0].enabled, false);
  } finally {
    database.close();
  }
});

test('unassigned workspace Hooks track active tenant membership and tenant availability', () => {
  const { database, service, hookId, alpha } = createTenantScopedWorkspaceHookFixture();
  try {
    database.prepare("UPDATE tenant_users SET status = 'disabled' WHERE tenant_id = 10 AND user_id = 2").run();
    assert.deepEqual(service.listAvailableHooksForContext(alpha), []);
    assert.throws(
      () => service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true }),
      (error) => error.statusCode === 403,
    );
    database.prepare("UPDATE tenant_users SET status = 'active' WHERE tenant_id = 10 AND user_id = 2").run();
    assert.equal(service.listAvailableHooksForContext(alpha)[0].id, hookId);
    database.prepare("UPDATE tenants SET status = 'disabled' WHERE id = 10").run();
    assert.deepEqual(service.listAvailableHooksForContext(alpha), []);
    assert.throws(
      () => service.setWorkspaceUserHookChatVisibility({ ...alpha, hookId, showInChat: false }),
      (error) => error.statusCode === 403,
    );
  } finally {
    database.close();
  }
});

test('explicit user and all-user Hook scopes retain visibility across workspace tenants', () => {
  const { database, service, hookId, alpha, beta } = createTenantScopedWorkspaceHookFixture();
  try {
    for (const scope of ['users', 'all_users']) {
      service.replaceHookBindings({ hookId, scope, userIds: scope === 'users' ? [2] : [], boundBy: 1 });
      for (const context of [alpha, beta]) {
        assert.equal(service.listAvailableHooksForContext(context)[0].id, hookId);
        service.setWorkspaceUserHookChatVisibility({ ...context, hookId, showInChat: false });
        assert.equal(service.listAvailableHooksForContext(context)[0].showInChat, false);
      }
    }
  } finally {
    database.close();
  }
});

test('template Hook assignments remain independent of later tenant scope changes', () => {
  const { database, service, hookId, alpha, beta } = createTenantScopedWorkspaceHookFixture();
  try {
    service.assignWorkspaceHook({
      workspaceId: beta.workspaceId,
      hookId,
      hookVersion: 1,
      source: 'agent_template',
      sourceTemplateId: 88,
      defaultEnabled: true,
      installStatus: 'ready',
      createdBy: 1,
    });
    assert.equal(service.listEffectiveHooksForContext(beta)[0].id, hookId);
    service.replaceHookBindings({ hookId, scope: 'users', userIds: [], boundBy: 1 });
    assert.deepEqual(service.listAvailableHooksForContext(alpha), []);
    assert.equal(service.listEffectiveHooksForContext(beta)[0].version, 1);
    service.setWorkspaceUserHookChatVisibility({ ...beta, hookId, showInChat: false });
    service.setWorkspaceUserHookEnabled({ ...beta, hookId, enabled: false });
    assert.deepEqual(service.listEffectiveHooksForContext(beta), []);
    service.setWorkspaceUserHookEnabled({ ...beta, hookId, enabled: true });
    assert.equal(service.listEffectiveHooksForContext(beta)[0].showInChat, false);
  } finally {
    database.close();
  }
});

test('workspace Hook assignments pin published versions and isolate member preferences by project', () => {
  const { database, service } = createFixture();
  try {
    database.prepare('INSERT INTO tenants (id, code, name) VALUES (10, ?, ?)')
      .run('tenant-10', 'Tenant 10');
    const insertWorkspace = database.prepare(`
      INSERT INTO workspaces (id, tenant_id, owner_user_id, slug, display_name, path)
      VALUES (?, 10, 2, ?, ?, ?)
    `);
    insertWorkspace.run(100, 'first', 'First', '/tmp/hook-workspace-first');
    insertWorkspace.run(101, 'second', 'Second', '/tmp/hook-workspace-second');

    const created = service.createHook({
      input: publishableHook({ name: '模板 Hook v1' }),
      userId: 1,
    });
    const firstPublished = service.publishHook({ hookId: created.id, userId: 1 });
    assert.equal(firstPublished.version, 1);
    assert.equal(service.getPublishedHookVersion({ hookId: created.id, version: 1 }).name, '模板 Hook v1');

    const assignment = service.assignWorkspaceHook({
      workspaceId: 100,
      hookId: created.id,
      hookVersion: 1,
      source: 'agent_template',
      sourceTemplateId: 88,
      defaultEnabled: true,
      defaultShowInChat: false,
      sortOrder: 2,
      installStatus: 'ready',
      createdBy: 1,
    });
    assert.deepEqual({
      hookVersion: assignment.hookVersion,
      source: assignment.source,
      sourceTemplateId: assignment.sourceTemplateId,
      defaultEnabled: assignment.defaultEnabled,
    }, {
      hookVersion: 1,
      source: 'agent_template',
      sourceTemplateId: 88,
      defaultEnabled: true,
    });
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    }).map((hook) => ({ name: hook.name, version: hook.version, showInChat: hook.showInChat })), [
      { name: '模板 Hook v1', version: 1, showInChat: false },
    ]);
    assert.equal(service.getWorkspaceUserHookChatVisibility({
      workspaceId: 100,
      userId: 2,
      hookId: created.id,
    }), false);
    assert.equal(service.getUserHookChatVisibility({
      workspaceId: 100,
      tenantId: 10,
      userId: 2,
      hookId: created.id,
    }), false);
    service.setWorkspaceUserHookChatVisibility({
      workspaceId: 100,
      tenantId: 10,
      userId: 2,
      hookId: created.id,
      showInChat: true,
    });
    assert.equal(service.getWorkspaceUserHookChatVisibility({
      workspaceId: 100,
      userId: 2,
      hookId: created.id,
    }), true);
    assert.equal(service.getUserHookChatVisibility({
      workspaceId: 100,
      tenantId: 10,
      userId: 2,
      hookId: created.id,
    }), true);
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 101,
    }), []);

    service.setWorkspaceUserHookEnabled({
      workspaceId: 100,
      tenantId: 10,
      userId: 2,
      hookId: created.id,
      enabled: false,
    });
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    }), []);

    const draftUpdate = service.updateHook({
      hookId: created.id,
      userId: 1,
      input: publishableHook({ name: '模板 Hook v2' }),
    });
    assert.equal(draftUpdate.status, 'draft');
    service.assignWorkspaceHook({
      workspaceId: 101,
      hookId: created.id,
      hookVersion: 1,
      source: 'agent_template',
      sourceTemplateId: 88,
      defaultEnabled: true,
      createdBy: 1,
    });
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 101,
    }).map((hook) => ({ name: hook.name, version: hook.version })), [
      { name: '模板 Hook v1', version: 1 },
    ]);
    service.removeWorkspaceHookAssignment({ workspaceId: 101, hookId: created.id });
    service.publishHook({ hookId: created.id, userId: 1 });
    assert.equal(service.getPublishedHookVersion({ hookId: created.id, version: 1 }).name, '模板 Hook v1');
    assert.equal(service.getPublishedHookVersion({ hookId: created.id, version: 2 }).name, '模板 Hook v2');
    service.setWorkspaceUserHookEnabled({
      workspaceId: 100,
      tenantId: 10,
      userId: 2,
      hookId: created.id,
      enabled: true,
    });
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    }).map((hook) => ({ name: hook.name, version: hook.version })), [
      { name: '模板 Hook v1', version: 1 },
    ]);

    database.prepare("UPDATE hooks SET status = 'disabled' WHERE id = ?").run(created.id);
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    }).map((hook) => ({ name: hook.name, version: hook.version })), [
      { name: '模板 Hook v1', version: 1 },
    ]);
    assert.throws(
      () => service.assignWorkspaceHook({
        workspaceId: 101,
        hookId: created.id,
        hookVersion: 1,
        source: 'agent_template',
        sourceTemplateId: 88,
        createdBy: 1,
      }),
      (error) => error.statusCode === 409 && /not available for new workspace assignments/.test(error.message),
    );
    database.prepare("UPDATE hooks SET status = 'published' WHERE id = ?").run(created.id);

    database.prepare(`
      UPDATE hook_published_versions
      SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = 'security incident'
      WHERE hook_id = ? AND version = 1
    `).run(created.id);
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    }), []);
    database.prepare(`
      UPDATE hook_published_versions
      SET revoked_at = NULL, revoke_reason = NULL
      WHERE hook_id = ? AND version = 1
    `).run(created.id);

    service.markWorkspaceHookAssignmentFailed({
      workspaceId: 100,
      hookId: created.id,
      error: 'resource unavailable',
    });
    const unavailable = service.listAvailableHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    })[0];
    assert.equal(unavailable.enabled, false);
    assert.equal(unavailable.unavailableReason, 'resources_unavailable');
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    }), []);
    assert.throws(
      () => service.deleteHook(created.id),
      (error) => error.statusCode === 409 && /installed in 1 workspace/.test(error.message),
    );
    assert.equal(service.removeWorkspaceHookAssignment({
      workspaceId: 100,
      hookId: created.id,
    }), true);
    assert.equal(service.deleteHook(created.id), true);
  } finally {
    database.close();
  }
});

test('Hooks referenced by draft or published Agent templates cannot be deleted', () => {
  const { database, service } = createFixture();
  try {
    database.prepare('INSERT INTO tenants (id, code, name) VALUES (10, ?, ?)')
      .run('tenant-10', 'Tenant 10');
    const created = service.createHook({
      input: publishableHook({ name: '模板引用 Hook' }),
      userId: 1,
    });
    const insertTemplate = database.prepare(`
      INSERT INTO agent_templates (
        name, category, tenant_ids_json, hook_refs_json, status,
        created_by_user_id, updated_by_user_id
      ) VALUES (?, '通用', '[10]', ?, ?, 1, 1)
    `);
    const refs = JSON.stringify([{ hookId: created.id, version: 1 }]);
    const draftTemplateId = Number(insertTemplate.run('草稿模板', refs, 'draft').lastInsertRowid);
    const publishedTemplateId = Number(insertTemplate.run('已发布模板', refs, 'published').lastInsertRowid);

    assert.throws(
      () => service.deleteHook(created.id),
      (error) => error.statusCode === 409
        && /仍被 2 个草稿或已发布 Agent 模板引用/.test(error.message)
        && error.message.includes('草稿模板')
        && error.message.includes('已发布模板'),
    );

    database.prepare(`
      UPDATE agent_templates SET status = 'disabled' WHERE id IN (?, ?)
    `).run(draftTemplateId, publishedTemplateId);
    assert.equal(service.deleteHook(created.id), true);
  } finally {
    database.close();
  }
});

test('workspace Hook resolution falls back to legacy user bindings without changing SQL Check ownership', () => {
  const { database, service } = createFixture();
  try {
    database.prepare('INSERT INTO tenants (id, code, name) VALUES (10, ?, ?)')
      .run('tenant-10', 'Tenant 10');
    database.prepare(`
      INSERT INTO workspaces (id, tenant_id, owner_user_id, slug, display_name, path)
      VALUES (100, 10, 2, 'first', 'First', '/tmp/hook-workspace-first')
    `).run();

    const adminHook = service.createHook({ input: publishableHook(), userId: 1 });
    service.publishHook({ hookId: adminHook.id, userId: 1 });
    service.replaceHookBindings({ hookId: adminHook.id, scope: 'all_users', boundBy: 1 });
    service.setUserHookEnabled({ userId: 2, hookId: adminHook.id, enabled: true });

    const sqlHook = service.createHook({
      input: publishableHook({ name: 'SQL Check 强制校验' }),
      userId: 1,
    });
    service.publishHook({ hookId: sqlHook.id, userId: 1 });
    service.setSqlCheckEnforcement({ userId: 2, enabled: true });

    assert.deepEqual(new Set(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    }).map((hook) => hook.id)), new Set([adminHook.id, sqlHook.id]));

    service.setWorkspaceUserHookEnabled({
      workspaceId: 100,
      tenantId: 10,
      userId: 2,
      hookId: adminHook.id,
      enabled: false,
    });
    assert.equal(service.getWorkspaceHookAssignment({
      workspaceId: 100,
      hookId: adminHook.id,
    }), null);
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    }).map((hook) => hook.id), [sqlHook.id]);
    database.prepare(`
      DELETE FROM user_workspace_hook_preferences
      WHERE workspace_id = 100 AND user_id = 2 AND hook_id = ?
    `).run(adminHook.id);

    service.assignWorkspaceHook({
      workspaceId: 100,
      hookId: adminHook.id,
      hookVersion: 1,
      defaultEnabled: false,
      createdBy: 2,
    });
    assert.deepEqual(service.listEffectiveHooksForContext({
      userId: 2,
      tenantId: 10,
      workspaceId: 100,
    }).map((hook) => hook.id), [sqlHook.id]);
    assert.equal(service.getSqlCheckEnforcement({ userId: 2 }).enabled, true);
  } finally {
    database.close();
  }
});

test('published Hook resource validation rejects changed Skill and MCP versions', () => {
  const { database, service } = createFixture();
  try {
    const hook = {
      resourceRefs: {
        skills: [{
          skillId: 'builtin:notifier',
          skillName: 'notifier',
          version: 3,
          contentHash: 'skill-hash-v1',
        }],
        mcpServers: [{ id: 'hook-mcp-1', contentHash: 'hash-v1' }],
        mcpTools: [{ mcpServerId: 'hook-mcp-1', toolName: 'mcp__notify__send' }],
      },
    };
    assert.equal(service.validatePublishedHookMaterialization({
      hook,
      resources: {
        skills: [{ skillId: 'builtin:notifier', version: 3, contentHash: 'skill-hash-v1' }],
        mcpServers: [{ id: 'hook-mcp-1', contentHash: 'hash-v1' }],
        mcpTools: [{ mcpServerId: 'hook-mcp-1', toolName: 'mcp__notify__send' }],
      },
    }), true);
    assert.throws(
      () => service.validatePublishedHookMaterialization({
        hook,
        resources: {
          skills: [{ skillId: 'builtin:notifier', version: 4, contentHash: 'skill-hash-v1' }],
          mcpServers: [{ id: 'hook-mcp-1', contentHash: 'hash-v1' }],
          mcpTools: [{ mcpServerId: 'hook-mcp-1', toolName: 'mcp__notify__send' }],
        },
      }),
      (error) => error.statusCode === 409 && /Skill .* version has changed/.test(error.message),
    );
    assert.throws(
      () => service.validatePublishedHookMaterialization({
        hook,
        resources: {
          skills: [{ skillId: 'builtin:notifier', version: 3, contentHash: 'skill-hash-v2' }],
          mcpServers: [{ id: 'hook-mcp-1', contentHash: 'hash-v1' }],
          mcpTools: [{ mcpServerId: 'hook-mcp-1', toolName: 'mcp__notify__send' }],
        },
      }),
      (error) => error.statusCode === 409 && /Skill .* content has changed/.test(error.message),
    );
    assert.throws(
      () => service.validatePublishedHookMaterialization({
        hook,
        resources: {
          skills: [{ skillId: 'builtin:notifier', version: 3, contentHash: 'skill-hash-v1' }],
          mcpServers: [{ id: 'hook-mcp-1', contentHash: 'hash-v2' }],
          mcpTools: [{ mcpServerId: 'hook-mcp-1', toolName: 'mcp__notify__send' }],
        },
      }),
      (error) => error.statusCode === 409 && /MCP server .* configuration has changed/.test(error.message),
    );
    assert.throws(
      () => service.validatePublishedHookMaterialization({
        hook,
        resources: {
          skills: [{ skillId: 'builtin:notifier', version: 3, contentHash: 'skill-hash-v1' }],
          mcpServers: [{ id: 'hook-mcp-1', contentHash: 'hash-v1' }],
          mcpTools: [],
        },
      }),
      (error) => error.statusCode === 409 && /MCP tool .* is unavailable/.test(error.message),
    );
  } finally {
    database.close();
  }
});

test('mcp_loop_run repeats the Matcher MCP with original inputs and a Python termination script', () => {
  const statusTool = {
    name: 'mcp__loopdemo__get_task_status',
    mcpServerId: 'loop-demo-server',
    serverName: 'loopdemo',
    toolName: 'get_task_status',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
  };
  const { database, service } = createFixture({
    hookMcpServers: [{ id: 'loop-demo-server', name: 'loopdemo' }],
    hookMcpTools: [statusTool],
  });
  try {
    const input = publishableHook({
      eventName: 'PostToolUse',
      matcher: { value: statusTool.name },
      extensionLogic: null,
      postActions: [{
        id: 'wait-for-task',
        type: 'mcp_loop_run',
        position: 0,
        config: {
          mcpServerId: statusTool.mcpServerId,
          toolName: statusTool.name,
          inputs: {
            task_id: { source: 'reference', path: 'event.tool_input.task_id' },
          },
          terminationScript: MCP_LOOP_TERMINATION_SCRIPT,
        },
      }],
      claudeResponse: { bindings: {} },
    });
    const created = service.createHook({ input, userId: 1 });
    assert.equal(created.postActions[0].config.pollIntervalMs, 10_000);
    assert.equal(created.postActions[0].config.perCallTimeoutMs, 15_000);
    assert.equal(created.postActions[0].config.maxWaitMs, 2_700_000);
    assert.equal(created.postActions[0].config.terminationScript, MCP_LOOP_TERMINATION_SCRIPT);
    assert.equal(Object.hasOwn(created.postActions[0].config, 'toolName'), false);
    assert.equal(Object.hasOwn(created.postActions[0].config, 'mcpServerId'), false);
    assert.equal(Object.hasOwn(created.postActions[0].config, 'inputs'), false);
    assert.equal(service.publishHook({ hookId: created.id, userId: 1 }).status, 'published');

    const unmatched = service.createHook({
      userId: 1,
      input: { ...input, name: 'Unmatched loop', matcher: { value: '^mcp__loopdemo__.*$' } },
    });
    assert.throws(
      () => service.publishHook({ hookId: unmatched.id, userId: 1 }),
      /requires a Matcher that fully identifies an available MCP tool/,
    );

    assert.throws(() => service.createHook({
      userId: 1,
      input: { ...input, eventName: 'Stop' },
    }), /type is not supported/);
    assert.throws(() => service.createHook({
      userId: 1,
      input: {
        ...input,
        postActions: [
          ...input.postActions,
          { id: 'after-loop', type: 'write_record', position: 1, config: { recordType: 'late', fields: {} } },
        ],
      },
    }), /must be the final post action/);
    assert.throws(() => service.createHook({
      userId: 1,
      input: {
        ...input,
        postActions: [
          ...input.postActions,
          { ...input.postActions[0], id: 'second-loop', position: 1 },
        ],
      },
    }), /at most one mcp_loop_run/);
  } finally {
    database.close();
  }
});

test('legacy mcp_loop_run equality conditions are converted to an executable Python termination script', async () => {
  const statusTool = {
    name: 'mcp__loopdemo__get_task_status',
    mcpServerId: 'loop-demo-server',
    serverName: 'loopdemo',
    toolName: 'get_task_status',
    inputSchema: { type: 'object', properties: {} },
  };
  const { database, service } = createFixture({
    hookMcpServers: [{ id: 'loop-demo-server', name: 'loopdemo' }],
    hookMcpTools: [statusTool],
  });
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-loop-termination-'));
  try {
    const created = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'PostToolUse',
        matcher: { value: statusTool.name },
        extensionLogic: null,
        postActions: [{
          id: 'legacy-loop',
          type: 'mcp_loop_run',
          position: 0,
          config: {
            successWhen: { field: 'data.state', equals: 3 },
            failureWhen: { field: 'data.state', equals: -1 },
          },
        }],
      }),
    });
    const script = created.postActions[0].config.terminationScript;
    assert.match(script, /async def run\(event, ccui\)/);
    assert.match(script, /\["data","state"\]/);
    assert.match(script, /"status": "success"/);
    assert.match(script, /"status": "failed"/);
    assert.doesNotMatch(script, /import /);
    assert.equal(Object.hasOwn(created.postActions[0].config, 'successWhen'), false);
    assert.deepEqual(await executeHookScript({
      hookId: created.id,
      language: 'python',
      code: script,
      event: { result: { data: { state: 3 } } },
      env: {},
      workspaceRoot,
    }), { output: { status: 'success' } });
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
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
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pwd' }, agent_id: 'child-1', agent_type: 'worker' }),
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'blocked',
        },
      }),
    );
    database.prepare(`
      INSERT INTO mcp_loop_attempts (
        hook_execution_id, action_id, job_id, attempt_count,
        script_status, termination_outcome, failure_stage,
        script_input_json, script_output_json, error_message,
        started_at_ms, completed_at_ms, duration_ms
      ) VALUES (?, 'loop-action', NULL, 0,
        'completed', 'running', NULL, ?, ?, NULL, 1005, 1010, 5)
    `).run(
      'execution-1',
      JSON.stringify({ result: { status: 'Running' }, attempt_count: 0 }),
      JSON.stringify({ output: { status: 'running' } }),
    );

    const [execution] = service.listAllExecutions({ sessionId: 'session-1' });
    assert.equal(execution.hookName, hook.name);
    assert.equal(execution.username, 'admin');
    assert.equal(execution.toolName, 'Bash');
    assert.equal(execution.agentId, 'child-1');
    assert.equal(execution.agentType, 'worker');
    assert.equal(execution.startedAtMs, 1000);
    assert.equal(execution.completedAtMs, 1025);
    assert.equal(execution.diagnostics.outcome, 'denied');
    assert.equal(execution.diagnostics.permissionDecision, 'deny');
    assert.equal(execution.input, null);
    const detail = service.getExecution('execution-1');
    assert.equal(detail.id, 'execution-1');
    assert.equal(detail.input.tool_name, 'Bash');
    assert.deepEqual(detail.mcpLoopAttempts, [{
      id: detail.mcpLoopAttempts[0].id,
      hookExecutionId: 'execution-1',
      actionId: 'loop-action',
      jobId: null,
      jobStatus: null,
      attemptCount: 0,
      scriptStatus: 'completed',
      terminationOutcome: 'running',
      failureStage: null,
      scriptInput: { result: { status: 'Running' }, attempt_count: 0 },
      scriptOutput: { output: { status: 'running' } },
      errorMessage: null,
      startedAtMs: 1005,
      completedAtMs: 1010,
      durationMs: 5,
      createdAt: detail.mcpLoopAttempts[0].createdAt,
    }]);
  } finally {
    database.close();
  }
});

test('user Hook execution history is scoped to the authenticated workspace and includes owned data records', () => {
  const { database, service } = createFixture();
  try {
    const hook = service.createHook({ input: publishableHook(), userId: 1 });
    const otherHook = service.createHook({ input: publishableHook({ name: 'Other Hook' }), userId: 1 });
    const insertExecution = database.prepare(`
      INSERT INTO hook_executions (
        id, hook_id, hook_version, user_id, tenant_id, workspace_id,
        session_id, event_name, status, input_json, actions_json, response_json,
        duration_ms, started_at_ms, completed_at_ms
      ) VALUES (?, ?, 1, ?, ?, ?, ?, 'Stop', 'succeeded', '{}', '{}', '{}', 12, ?, ?)
    `);
    insertExecution.run('mine', hook.id, 2, 7, 10, 'session-mine', 1000, 1012);
    database.prepare('UPDATE hook_executions SET input_json = ? WHERE id = ?').run(
      JSON.stringify({ agent_id: 'child-2', agent_type: 'reviewer', tool_input: { private: 'not-in-summary' } }), 'mine',
    );
    insertExecution.run('other-user', hook.id, 1, 7, 10, 'session-other-user', 2000, 2012);
    insertExecution.run('other-workspace', hook.id, 2, 7, 11, 'session-other-workspace', 3000, 3012);
    insertExecution.run('legacy-source', otherHook.id, 2, 7, 10, 'session-legacy', 4000, 4012);
    database.prepare(`
      INSERT INTO hook_data_records (
        id, execution_id, hook_id, user_id, tenant_id, workspace_id,
        session_id, record_type, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'record-mine',
      'mine',
      hook.id,
      2,
      7,
      10,
      'session-mine',
      'sql_metrics',
      JSON.stringify({ sqlLineCount: 2 }),
    );
    database.prepare(`
      INSERT INTO hook_data_records (
        id, execution_id, hook_id, user_id, tenant_id, workspace_id,
        session_id, record_type, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'record-other-hook',
      'mine',
      otherHook.id,
      2,
      7,
      10,
      'session-mine',
      'legacy_migrated_record',
      JSON.stringify({ shouldNotLeak: true }),
    );
    database.prepare(`
      INSERT INTO hook_data_records (
        id, execution_id, hook_id, user_id, tenant_id, workspace_id,
        session_id, record_type, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'record-legacy-owner',
      'legacy-source',
      hook.id,
      2,
      7,
      10,
      'session-legacy',
      'legacy_owned_record',
      JSON.stringify({ sqlLineCount: 3 }),
    );

    const page = service.listUserExecutionPage({
      hookId: hook.id,
      userId: 2,
      tenantId: 7,
      workspaceId: 10,
      limit: 20,
    });

    assert.equal(page.total, 1);
    assert.equal(page.executionTotal, 1);
    assert.deepEqual(page.executions.map((execution) => execution.id), ['mine']);
    assert.deepEqual(page.executions[0].records.map(({ createdAt, ...record }) => record), [{
      id: 'record-mine',
      type: 'sql_metrics',
      data: { sqlLineCount: 2 },
    }]);
    assert.ok(page.executions[0].records[0].createdAt);
    assert.equal(page.executions[0].input, null);
    assert.equal(page.executions[0].agentId, 'child-2');
    assert.equal(page.executions[0].agentType, 'reviewer');
    assert.deepEqual(page.executions[0].actions, {});
    assert.deepEqual(page.standaloneRecords.map(({ createdAt, ...record }) => record), [{
      id: 'record-legacy-owner',
      type: 'legacy_owned_record',
      data: { sqlLineCount: 3 },
      sessionId: 'session-legacy',
    }]);
    assert.ok(page.standaloneRecords[0].createdAt);
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
    assert.deepEqual(service.listAvailableHooksForUser(2).map((hook) => ({
      id: hook.id,
      bindingController: hook.bindingController,
      enabled: hook.enabled,
    })), [{
      id: created.id,
      bindingController: 'sql_check',
      enabled: false,
    }]);

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
    const enabled = service.setSqlCheckEnforcement({ userId: 2, enabled: true });
    assert.equal(enabled.enabled, true);
    assert.equal(service.listAvailableHooksForUser(2)[0].enabled, true);
    service.setUserHookChatVisibility({ userId: 2, hookId: created.id, showInChat: false });
    assert.equal(service.listAvailableHooksForUser(2)[0].showInChat, false);
    assert.equal(service.getHook(created.id).boundUserCount, 1);
    assert.deepEqual(service.listActiveHooksForUser(2).map((hook) => ({
      id: hook.id,
      showInChat: hook.showInChat,
    })), [{ id: created.id, showInChat: false }]);

    const disabled = service.setSqlCheckEnforcement({ userId: 2, enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(service.listAvailableHooksForUser(2)[0].enabled, false);
    assert.equal(service.getHook(created.id).boundUserCount, 0);
    assert.deepEqual(service.listActiveHooksForUser(2), []);
    assert.equal(service.deleteHook(created.id), true);
    assert.equal(service.getHook(created.id), null);
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
  const { database, service } = createFixture({
    hookMcpServers: [{ id: 'hook-mcp-notify', name: 'notify' }],
    hookMcpTools: [{
      name: 'mcp__notify__send_sms',
      mcpServerId: 'hook-mcp-notify',
      serverName: 'notify',
      toolName: 'send_sms',
      inputSchema: {
        type: 'object',
        required: ['user_id', 'content'],
        properties: {
          user_id: { type: 'number' },
          content: { type: 'string' },
        },
      },
    }],
  });
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
      validatedSkills: [{
        skillId: 'builtin:hook-notification',
        name: 'hook-notification',
        version: 1,
        contentHash: 'notification-skill-hash-v1',
      }],
    });
    assert.equal(published.status, 'published');
    assert.deepEqual(
      service.getPublishedHookVersion({ hookId: created.id, version: 1 }).resourceRefs.skills,
      [{
        skillId: 'builtin:hook-notification',
        skillName: 'hook-notification',
        version: 1,
        contentHash: 'notification-skill-hash-v1',
      }],
    );
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
            mcpServerIds: ['legacy-hook-mcp'],
          },
        }],
      }),
    });
    assert.equal(stopSkill.postActions[0].type, 'invoke_skill');
    assert.equal(Object.hasOwn(stopSkill.postActions[0].config, 'mcpServerIds'), false);

    const agentMessage = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'Stop',
        extensionLogic: null,
        postActions: [{
          id: 'follow-up',
          type: 'send_agent_message',
          position: 0,
          config: { messageTemplate: '继续处理会话 {{ccui.env.sessionId}}' },
        }],
      }),
    });
    assert.equal(agentMessage.postActions[0].config.messageTemplate, '继续处理会话 {{ccui.env.sessionId}}');
    assert.equal(service.publishHook({ hookId: agentMessage.id, userId: 1 }).status, 'published');

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

    assert.throws(() => service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'SessionEnd',
        postActions: [{
          id: 'follow-up',
          type: 'send_agent_message',
          position: 0,
          config: { messageTemplate: '继续处理' },
        }],
      }),
    }), /only supported for Stop and StopFailure/);

    const emptyAgentMessage = service.createHook({
      userId: 1,
      input: publishableHook({
        eventName: 'StopFailure',
        extensionLogic: null,
        postActions: [{
          id: 'empty-follow-up',
          type: 'send_agent_message',
          position: 0,
          config: { messageTemplate: '' },
        }],
      }),
    });
    assert.throws(
      () => service.publishHook({ hookId: emptyAgentMessage.id, userId: 1 }),
      /must set an Agent message/,
    );

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
      addedShowInChat: true,
      addedUserHookPreferences: true,
      removedGate: true,
      removedAdvancedScript: true,
    });
    assert.deepEqual(
      database
        .prepare('PRAGMA table_info(hooks)')
        .all()
        .map((column) => column.name),
      ['id', 'include_subagents', 'user_variables_json', 'extension_logic_json', 'post_actions_json', 'claude_response_json', 'show_in_chat', 'default_enabled', 'default_show_in_chat'],
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'hook_actions'")
        .get().count,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'user_hook_preferences'")
        .get().count,
      1,
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

test('configuration migration converts the legacy global chat flag into per-user preferences', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE hooks (
        id TEXT PRIMARY KEY,
        extension_logic_json TEXT NOT NULL DEFAULT 'null',
        post_actions_json TEXT NOT NULL DEFAULT '[]',
        claude_response_json TEXT NOT NULL DEFAULT '{"bindings":{}}',
        show_in_chat INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE user_hook_bindings (
        user_id INTEGER NOT NULL,
        hook_id TEXT NOT NULL,
        PRIMARY KEY (user_id, hook_id)
      );
      INSERT INTO users (id) VALUES (1), (2);
      INSERT INTO hooks (id, show_in_chat) VALUES ('legacy-hidden', 0);
      INSERT INTO user_hook_bindings (user_id, hook_id) VALUES (1, 'legacy-hidden');
    `);

    migrateHookConfigurationModel(database);
    assert.equal(
      database.prepare("SELECT show_in_chat FROM hooks WHERE id = 'legacy-hidden'").get().show_in_chat,
      1,
    );
    assert.deepEqual(
      database.prepare(`
        SELECT user_id, hook_id, show_in_chat
        FROM user_hook_preferences
      `).all(),
      [{ user_id: 1, hook_id: 'legacy-hidden', show_in_chat: 0 }],
    );

    database.prepare(`
      UPDATE user_hook_preferences SET show_in_chat = 1
      WHERE user_id = 1 AND hook_id = 'legacy-hidden'
    `).run();
    database.prepare("UPDATE hooks SET show_in_chat = 0 WHERE id = 'legacy-hidden'").run();
    migrateHookConfigurationModel(database);
    assert.equal(
      database.prepare(`
        SELECT show_in_chat FROM user_hook_preferences
        WHERE user_id = 1 AND hook_id = 'legacy-hidden'
      `).get().show_in_chat,
      1,
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

const personalVariables = [
  { name: 'token', label: '个人 Token', description: '填写服务访问令牌', required: true, secret: true },
  { name: 'project', label: '项目标识', description: '', required: false, secret: false },
];

test('personal variables validate definitions and references and survive immutable publication snapshots', () => {
  const { database, service, hookId, alpha } = createTenantScopedWorkspaceHookFixture();
  try {
    const input = publishableHook({ userVariables: personalVariables, claudeResponse: {
      bindings: { systemMessage: { source: 'template', template: '{{ccui.env.userVariables.project}}' } },
    } });
    for (const userVariables of [
      [...personalVariables, personalVariables[0]],
      [{ name: 'bad.name' }], [{ name: '__proto__' }], [{ name: 'token', required: 'true' }],
    ]) assert.throws(() => service.updateHook({ hookId, userId: 1, input: { ...input, userVariables } }), { statusCode: 400 });
    assert.throws(() => service.updateHook({ hookId, userId: 1, input: { ...input, userVariables: [] } }), /Reference/);
    service.updateHook({ hookId, userId: 1, input });
    const published = service.publishHook({ hookId, userId: 1 });
    assert.deepEqual(published.userVariables, personalVariables);
    service.assignWorkspaceHook({ workspaceId: alpha.workspaceId, hookId, hookVersion: published.version, installStatus: 'ready' });
    service.updateHook({ hookId, userId: 1, input: publishableHook({ userVariables: [{ name: 'new_field' }] }) });
    service.publishHook({ hookId, userId: 1 });
    assert.deepEqual(service.listAvailableHooksForContext(alpha)[0].userVariables, personalVariables);
    assert.deepEqual(service.getPublishedHookVersion({ hookId, version: 1 }).userVariables, []);
  } finally { database.close(); }
});

test('personal variable values are encrypted, scoped, validated, updated, and never returned by settings APIs', () => {
  const { database, service, hookId, alpha, alphaSecond, beta } = createTenantScopedWorkspaceHookFixture();
  try {
    service.updateHook({ hookId, userId: 1, input: publishableHook({ userVariables: personalVariables }) });
    const hook = service.publishHook({ hookId, userId: 1 });
    const before = service.listAvailableHooksForContext(alpha)[0];
    assert.deepEqual(before.missingRequiredUserVariables, ['token']);
    assert.equal(before.enabled, false);
    for (const userVariables of [undefined, {}, { token: '   ' }, { token: 123 }, { token: 'a\0b' }, { token: 'ok', unknown: 'value' }]) {
      assert.throws(() => service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true, userVariables }), { statusCode: 400 });
    }
    assert.equal(service.getWorkspaceHookAssignment({ workspaceId: alpha.workspaceId, hookId }), null);
    assert.throws(() => service.setUserHookEnabled({ userId: 2, hookId, enabled: true }), { statusCode: 409 });
    const result = service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true, userVariables: { token: 'private-alice', project: 'project-a' } });
    assert.equal(result.hook.enabled, true);
    assert.deepEqual(result.hook.configuredUserVariables, ['token', 'project']);
    assert.doesNotMatch(JSON.stringify(result), /private-alice|project-a/);
    const stored = database.prepare('SELECT values_encrypted FROM user_workspace_hook_variables').get();
    assert.match(stored.values_encrypted, /^secret:/);
    assert.doesNotMatch(stored.values_encrypted, /private-alice|project-a/);
    assert.deepEqual(service.getWorkspaceHookUserVariables({ ...alpha, hook }), { token: 'private-alice', project: 'project-a' });
    for (const context of [alphaSecond, beta, { ...alpha, userId: 1 }]) {
      assert.deepEqual(service.getWorkspaceHookUserVariables({ ...context, hook }), {});
    }
    assert.deepEqual(service.getWorkspaceHookUserVariables({ ...alpha, hook: { ...hook, id: 'another-hook' } }), {});
    assert.throws(() => service.setWorkspaceUserHookEnabled({ ...beta, hookId, enabled: true, userVariables: { token: 'no' } }), { statusCode: 403 });
    assert.throws(() => service.setWorkspaceUserHookEnabled({ ...alpha, tenantId: 20, hookId, enabled: true, userVariables: { token: 'no' } }), { statusCode: 403 });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: false });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true, userVariables: { project: '', token: 'new-token' } });
    assert.deepEqual(service.getWorkspaceHookUserVariables({ ...alpha, hook }), { token: 'new-token' });
    assert.throws(() => service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true, userVariables: { token: '' } }), { statusCode: 400 });
    assert.deepEqual(service.getWorkspaceHookUserVariables({ ...alpha, hook }), { token: 'new-token' });
    service.removeWorkspaceHookAssignment({ workspaceId: alpha.workspaceId, hookId });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_workspace_hook_variables').get().count, 0);
  } finally { database.close(); }
});

test('mandatory template Hooks wait for each user to configure required variables', () => {
  const { database, service, hookId, alpha } = createTenantScopedWorkspaceHookFixture();
  try {
    service.updateHook({ hookId, userId: 1, input: publishableHook({ userVariables: personalVariables }) });
    const hook = service.publishHook({ hookId, userId: 1 });
    service.assignWorkspaceHook({ workspaceId: alpha.workspaceId, hookId, hookVersion: hook.version,
      source: 'agent_template', sourceTemplateId: 88, defaultEnabled: true, allowUserDisable: false, installStatus: 'ready' });
    assert.deepEqual(service.listEffectiveHooksForContext(alpha), []);
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true, userVariables: { token: 'member-token' } });
    assert.equal(service.listEffectiveHooksForContext(alpha).length, 1);
    assert.deepEqual(service.listEffectiveHooksForContext({ ...alpha, userId: 1 }), []);
    assert.throws(() => service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: false }), { statusCode: 409 });
  } finally { database.close(); }
});

test('Hook environment uses enabled pinned definitions and isolates users, workspaces, tenants and unavailable Hooks', () => {
  const { database, service, hookId, alpha, alphaSecond, beta } = createTenantScopedWorkspaceHookFixture();
  try {
    service.updateHook({ hookId, userId: 1, input: publishableHook({ userVariables: personalVariables }) });
    service.publishHook({ hookId, userId: 1 });
    assert.deepEqual(service.resolveWorkspaceHookEnvironment(alpha), { env: {}, secretValues: [] });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true, userVariables: { token: 'alpha-private' } });
    service.setWorkspaceUserHookEnabled({ ...alphaSecond, hookId, enabled: true, userVariables: { token: 'second-private' } });
    service.updateHook({ hookId, userId: 1, input: publishableHook({ userVariables: [{ name: 'new_field' }] }) });
    service.publishHook({ hookId, userId: 1 });
    assert.deepEqual(service.resolveWorkspaceHookEnvironment(alpha), { env: { token: 'alpha-private' }, secretValues: ['alpha-private'] });
    assert.deepEqual(service.resolveWorkspaceHookEnvironment(alphaSecond).env, { token: 'second-private' });
    for (const context of [beta, { ...alpha, userId: 1 }]) {
      assert.deepEqual(service.resolveWorkspaceHookEnvironment(context), { env: {}, secretValues: [] });
    }
    assert.throws(() => service.resolveWorkspaceHookEnvironment({ ...alpha, tenantId: beta.tenantId }), { statusCode: 403 });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true, userVariables: { token: 'changed', project: '普通 值' } });
    assert.deepEqual(service.resolveWorkspaceHookEnvironment(alpha), { env: { token: 'changed', project: '普通 值' }, secretValues: ['changed'] });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: false });
    assert.deepEqual(service.resolveWorkspaceHookEnvironment(alpha).env, {});
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true });
    service.markWorkspaceHookAssignmentFailed({ workspaceId: alpha.workspaceId, hookId, error: 'missing resource' });
    assert.deepEqual(service.resolveWorkspaceHookEnvironment(alpha).env, {});
  } finally { database.close(); }
});

test('Hook environment shares identical values but refuses ambiguous names without exposing values', () => {
  const { database, service, hookId, alpha } = createTenantScopedWorkspaceHookFixture();
  try {
    service.updateHook({ hookId, userId: 1, input: publishableHook({ userVariables: personalVariables }) });
    service.publishHook({ hookId, userId: 1 });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId, enabled: true, userVariables: { token: 'same-private' } });
    const second = service.createHook({ input: publishableHook({ name: 'Second Hook', userVariables: personalVariables }), userId: 1 });
    service.publishHook({ hookId: second.id, userId: 1 });
    service.replaceHookBindings({ hookId: second.id, scope: 'tenants', tenantIds: [10], boundBy: 1 });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId: second.id, enabled: true, userVariables: { token: 'same-private' } });
    assert.deepEqual(service.resolveWorkspaceHookEnvironment(alpha), { env: { token: 'same-private' }, secretValues: ['same-private'] });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId: second.id, enabled: true, userVariables: { token: 'different-private' } });
    assert.throws(() => service.resolveWorkspaceHookEnvironment(alpha), (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /token.*冲突/);
      assert.doesNotMatch(error.message, /same-private|different-private/);
      return true;
    });
    service.setWorkspaceUserHookEnabled({ ...alpha, hookId: second.id, enabled: false });
    assert.deepEqual(service.resolveWorkspaceHookEnvironment(alpha).env, { token: 'same-private' });
  } finally { database.close(); }
});

test('execution pagination keeps identical tool ids in different agents separate', () => {
  const { database, service } = createFixture();
  try {
    const hook = service.createHook({ input: publishableHook({ eventName: 'PreToolUse', includeSubagents: true }), userId: 1 });
    const insertExecution = database.prepare(`
      INSERT INTO hook_executions (
        id, hook_id, hook_version, user_id, session_id, event_name, tool_use_id,
        status, input_json, started_at_ms
      ) VALUES (?, ?, 1, 1, 'shared-session', 'PreToolUse', 'shared-tool', 'succeeded', ?, ?)
    `);
    insertExecution.run('main-callback', hook.id, JSON.stringify({ tool_name: 'Bash' }), 1000);
    insertExecution.run('child-one-callback', hook.id, JSON.stringify({ tool_name: 'Bash', agent_id: 'child-one' }), 2000);
    insertExecution.run('child-two-callback', hook.id, JSON.stringify({ tool_name: 'Bash', agent_id: 'child-two' }), 3000);
    insertExecution.run('child-two-second-hook', hook.id, JSON.stringify({ tool_name: 'Bash', agent_id: 'child-two' }), 3010);

    const newest = service.listExecutionPage(hook.id, { limit: 1, offset: 0 });
    assert.equal(newest.total, 3);
    assert.equal(newest.executionTotal, 4);
    assert.deepEqual(newest.executions.map((item) => item.id), ['child-two-second-hook', 'child-two-callback']);
    assert.equal(newest.executions.every((item) => item.agentId === 'child-two'), true);
    const middle = service.listExecutionPage(hook.id, { limit: 1, offset: 1 });
    assert.deepEqual(middle.executions.map((item) => item.id), ['child-one-callback']);
    const oldest = service.listExecutionPage(hook.id, { limit: 1, offset: 2 });
    assert.deepEqual(oldest.executions.map((item) => item.id), ['main-callback']);
    assert.equal(oldest.executions[0].agentId, null);
  } finally { database.close(); }
});
