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
} from '../database/hook-config-schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import { createHookConfigService } from './hook-configs.js';
import { createHookRuntimeSession } from './hook-runtime.js';

function confirmationHook(outputType) {
  return {
    name: 'MCP 参数确认再发布回归',
    description: '修正已发布的参数输出类型',
    eventName: 'PreToolUse',
    matcher: { mode: 'regex', value: '^mcp__.*' },
    userVariables: [{ name: 'label', required: true, secret: false }],
    extensionLogic: {
      language: 'python',
      code: 'async def run(event, ccui):\n    return {"output": {"toolInput": event.get("tool_input", {}), "permissionDecision": "ask"}}',
      outputs: [
        { name: 'toolInput', type: outputType },
        { name: 'permissionDecision', type: 'string' },
      ],
    },
    postActions: [],
    claudeResponse: {
      bindings: {
        'hookSpecificOutput.permissionDecision': { source: 'reference', path: 'script.output.permissionDecision' },
      },
    },
  };
}

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
  database.prepare("INSERT INTO users (id, username) VALUES (1, 'admin'), (2, 'member')").run();
  database.prepare("INSERT INTO tenants (id, code, name) VALUES (10, 'republish', 'Republish')").run();
  database.prepare("INSERT INTO tenant_users (tenant_id, user_id, status) VALUES (10, 2, 'active')").run();
  database.prepare(`
    INSERT INTO workspaces (id, tenant_id, owner_user_id, slug, display_name, path)
    VALUES (100, 10, 2, 'manual', 'Manual', '/tmp/hook-republish-manual'),
      (101, 10, 2, 'template', 'Template', '/tmp/hook-republish-template')
  `).run();
  const values = new Map();
  const service = createHookConfigService({
    database,
    configStore: { get: (key) => values.get(key) || null, set: (key, value) => values.set(key, value) },
  });
  const hook = service.createHook({ userId: 1, input: confirmationHook('boolean') });
  service.publishHook({ hookId: hook.id, userId: 1 });
  service.replaceHookBindings({ hookId: hook.id, scope: 'tenants', tenantIds: [10], boundBy: 1 });
  return {
    database, service, hookId: hook.id,
    manual: { userId: 2, tenantId: 10, workspaceId: 100 },
    template: { userId: 2, tenantId: 10, workspaceId: 101 },
  };
}

function outputType(hook) {
  return hook.extensionLogic.outputs.find((output) => output.name === 'toolInput').type;
}

function assignmentPolicy(assignment) {
  const { hookVersion: _version, updatedAt: _updatedAt, ...policy } = assignment;
  return policy;
}

test('republishing advances a personally enabled manual Hook while drafts and old snapshots stay isolated', async (t) => {
  const { database, service, hookId, manual } = createFixture();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-republish-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const execute = (hook, toolUseId) => {
    const runtime = createHookRuntimeSession({
      hooks: [hook], database, workspaceRoot, ...manual,
      resolveUserVariables: ({ hook: selected }) => service.getWorkspaceHookUserVariables({ ...manual, hook: selected }),
    });
    return runtime.hooks.PreToolUse[0].hooks[0]({
      hook_event_name: 'PreToolUse', session_id: 'republish-regression',
      tool_name: 'mcp__demo__echo', tool_use_id: toolUseId,
      tool_input: { message: 'synthetic argument' },
    });
  };
  try {
    service.setWorkspaceUserHookEnabled({ ...manual, hookId, enabled: true, userVariables: { label: 'member choice' } });
    service.setWorkspaceUserHookChatVisibility({ ...manual, hookId, showInChat: false });
    const before = service.listEffectiveHooksForContext(manual)[0];
    const scope = service.listHookBindings(hookId);
    assert.equal(before.version, 1);
    assert.equal(outputType(before), 'boolean');
    const failed = await execute(before, 'before-publish');
    assert.notEqual(failed.hookSpecificOutput?.permissionDecision, 'ask');
    assert.match(database.prepare('SELECT error_message FROM hook_executions WHERE hook_id = ?').get(hookId).error_message,
      /Script output toolInput must be boolean/);

    service.updateHook({ hookId, userId: 1, input: confirmationHook('object') });
    const duringDraft = service.listEffectiveHooksForContext(manual)[0];
    assert.equal(duringDraft.version, 1);
    assert.equal(outputType(duringDraft), 'boolean');
    assert.equal(service.getHook(hookId).status, 'draft');

    service.publishHook({ hookId, userId: 1 });
    const after = service.listEffectiveHooksForContext(manual)[0];
    assert.equal(after.version, 2, 'the next query must use the newly published manual Hook');
    assert.equal(outputType(after), 'object');
    const passed = await execute(after, 'after-publish');
    assert.equal(passed.hookSpecificOutput.permissionDecision, 'ask');
    const executions = database.prepare('SELECT status, hook_version FROM hook_executions WHERE hook_id = ? ORDER BY rowid').all(hookId);
    assert.deepEqual(executions, [{ status: 'failed', hook_version: 1 }, { status: 'succeeded', hook_version: 2 }]);
    assert.equal(after.workspaceAssignment.hookVersion, 2);
    assert.equal(after.enabled, true);
    assert.equal(after.showInChat, false);
    assert.deepEqual(assignmentPolicy(after.workspaceAssignment), assignmentPolicy(before.workspaceAssignment));
    assert.deepEqual(service.getWorkspaceHookUserVariables({ ...manual, hook: after }), { label: 'member choice' });
    assert.deepEqual(service.listHookBindings(hookId).users, scope.users);
    assert.deepEqual(service.listHookBindings(hookId).tenants, scope.tenants);
    assert.equal(outputType(service.getPublishedHookVersion({ hookId, version: 1 })), 'boolean');
  } finally { database.close(); }
});

test('republishing preserves an Agent template assignment pinned to the earlier published version', () => {
  const { database, service, hookId, manual, template } = createFixture();
  try {
    service.setWorkspaceUserHookEnabled({ ...manual, hookId, enabled: true, userVariables: { label: 'manual' } });
    service.assignWorkspaceHook({
      workspaceId: template.workspaceId, hookId, hookVersion: 1,
      source: 'agent_template', sourceTemplateId: 88,
      defaultEnabled: true, defaultShowInChat: false, allowUserDisable: false,
      sortOrder: 7, createdBy: 1,
    });
    service.setWorkspaceUserHookEnabled({ ...template, hookId, enabled: true, userVariables: { label: 'template' } });
    const pinnedBefore = service.listEffectiveHooksForContext(template)[0];

    service.updateHook({ hookId, userId: 1, input: confirmationHook('object') });
    service.publishHook({ hookId, userId: 1 });

    const pinnedAfter = service.listEffectiveHooksForContext(template)[0];
    assert.equal(pinnedAfter.version, 1);
    assert.equal(outputType(pinnedAfter), 'boolean');
    assert.deepEqual(pinnedAfter.workspaceAssignment, pinnedBefore.workspaceAssignment);
    assert.equal(pinnedAfter.showInChat, false);
    assert.deepEqual(service.getWorkspaceHookUserVariables({ ...template, hook: pinnedAfter }), { label: 'template' });
    assert.equal(service.listEffectiveHooksForContext(manual)[0].version, 2);
  } finally { database.close(); }
});

test('republishing never enables a disabled manual Hook or changes its installation and preference policy', () => {
  const { database, service, hookId, manual } = createFixture();
  try {
    service.assignWorkspaceHook({
      workspaceId: manual.workspaceId, hookId, source: 'manual',
      defaultEnabled: false, defaultShowInChat: false, allowUserDisable: true,
      sortOrder: 23, createdBy: 1,
    });
    service.setWorkspaceUserHookEnabled({ ...manual, hookId, enabled: true, userVariables: { label: 'keep this value' } });
    service.setWorkspaceUserHookChatVisibility({ ...manual, hookId, showInChat: false });
    service.setWorkspaceUserHookEnabled({ ...manual, hookId, enabled: false });
    service.markWorkspaceHookAssignmentFailed({ workspaceId: manual.workspaceId, hookId, error: 'Existing resource installation failure' });
    const before = service.listAvailableHooksForContext(manual)[0];
    const readPreference = () => database.prepare('SELECT * FROM user_workspace_hook_preferences WHERE workspace_id = ? AND hook_id = ?').get(manual.workspaceId, hookId);
    const preference = readPreference();

    service.updateHook({ hookId, userId: 1, input: confirmationHook('object') });
    service.publishHook({ hookId, userId: 1 });

    const after = service.listAvailableHooksForContext(manual)[0];
    assert.equal(after.version, 2);
    assert.equal(outputType(after), 'object');
    assert.equal(after.enabled, false);
    assert.equal(after.showInChat, false);
    assert.equal(after.unavailableReason, 'resources_unavailable');
    assert.deepEqual(assignmentPolicy(after.workspaceAssignment), assignmentPolicy(before.workspaceAssignment));
    assert.deepEqual(readPreference(), preference);
    assert.deepEqual(service.listEffectiveHooksForContext(manual), []);
    assert.deepEqual(service.getWorkspaceHookUserVariables({ ...manual, hook: after }), { label: 'keep this value' });
  } finally { database.close(); }
});
