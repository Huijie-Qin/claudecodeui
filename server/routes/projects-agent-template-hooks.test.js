import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAgentTemplateHooksToWorkspace } from './projects.js';

const hookRef = Object.freeze({
  id: 'hook-1',
  name: '任务记录',
  version: 3,
  defaultEnabled: true,
  showInChat: false,
  allowUserDisable: true,
  order: 10,
});

test('template Hook installation pins the version, materializes resources, and becomes ready', async () => {
  const calls = [];
  const hook = { id: hookRef.id, version: hookRef.version, postActions: [] };
  const result = await applyAgentTemplateHooksToWorkspace({
    hooks: [hookRef],
    templateId: 8,
    workspace: { id: 12, path: '/tmp/template-hook-workspace' },
    user: { id: 4 },
    hookConfigs: {
      getPublishedHookVersion: (input) => { calls.push(['get', input]); return hook; },
      assignWorkspaceHook: (input) => calls.push(['assign', input]),
      validatePublishedHookMaterialization: (input) => calls.push(['validate', input]),
      markWorkspaceHookAssignmentReady: (input) => calls.push(['ready', input]),
      markWorkspaceHookAssignmentFailed: (input) => calls.push(['failed', input]),
    },
    hookResources: {
      materializeHook: async (input) => {
        calls.push(['materialize', input]);
        return { skills: [], mcpServers: [] };
      },
    },
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.snapshots[0].installStatus, 'ready');
  assert.deepEqual(calls.map(([name]) => name), ['get', 'assign', 'materialize', 'validate', 'ready']);
  assert.deepEqual(calls[1][1], {
    workspaceId: 12,
    hookId: 'hook-1',
    hookVersion: 3,
    source: 'agent_template',
    sourceTemplateId: 8,
    defaultEnabled: true,
    defaultShowInChat: false,
    allowUserDisable: true,
    sortOrder: 10,
    installStatus: 'pending',
    createdBy: 4,
  });
});

test('template Hook resource failure is recorded without failing project creation', async () => {
  const calls = [];
  const result = await applyAgentTemplateHooksToWorkspace({
    hooks: [hookRef],
    templateId: 8,
    workspace: { id: 12, path: '/tmp/template-hook-workspace' },
    user: { id: 4 },
    hookConfigs: {
      getPublishedHookVersion: () => ({ id: hookRef.id, version: hookRef.version }),
      assignWorkspaceHook: () => calls.push('assign'),
      markWorkspaceHookAssignmentReady: () => calls.push('ready'),
      markWorkspaceHookAssignmentFailed: (input) => calls.push(['failed', input]),
    },
    hookResources: {
      materializeHook: async () => { throw new Error('Hook MCP is unavailable'); },
    },
  });

  assert.equal(result.snapshots[0].installStatus, 'failed');
  assert.equal(result.snapshots[0].failureCode, 'resource_install_failed');
  assert.deepEqual(result.warnings, [{
    type: 'hook',
    id: 'hook-1',
    name: '任务记录',
    unavailableReason: 'Hook MCP is unavailable',
  }]);
  assert.deepEqual(calls, [
    'assign',
    ['failed', { workspaceId: 12, hookId: 'hook-1', error: 'Hook MCP is unavailable' }],
  ]);
});

test('missing template Hook versions degrade without creating a broken assignment', async () => {
  let assigned = false;
  const result = await applyAgentTemplateHooksToWorkspace({
    hooks: [hookRef],
    templateId: 8,
    workspace: { id: 12, path: '/tmp/template-hook-workspace' },
    user: { id: 4 },
    hookConfigs: {
      getPublishedHookVersion: () => null,
      assignWorkspaceHook: () => { assigned = true; },
      markWorkspaceHookAssignmentReady: () => {},
      markWorkspaceHookAssignmentFailed: () => {},
    },
    hookResources: { materializeHook: async () => {} },
  });

  assert.equal(assigned, false);
  assert.equal(result.snapshots[0].installStatus, 'failed');
  assert.match(result.warnings[0].unavailableReason, /version 3 is unavailable/);
});
