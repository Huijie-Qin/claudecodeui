import assert from 'node:assert/strict';
import test from 'node:test';

import { getWorkspaceDisabledTabs, resolveAllowedWorkspaceTab } from './mainContentAccess';

test('getWorkspaceDisabledTabs disables chat for view-only workspaces while keeping inspection tabs available', () => {
  assert.deepEqual(Array.from(getWorkspaceDisabledTabs('view')).sort(), ['chat']);
  assert.equal(getWorkspaceDisabledTabs('edit').size, 0);
  assert.equal(getWorkspaceDisabledTabs('owner').size, 0);
});

test('resolveAllowedWorkspaceTab falls back to files when active tab is disabled', () => {
  const disabledTabs = getWorkspaceDisabledTabs('view');

  assert.equal(resolveAllowedWorkspaceTab('chat', disabledTabs), 'files');
  assert.equal(resolveAllowedWorkspaceTab('files', disabledTabs), 'files');
  assert.equal(resolveAllowedWorkspaceTab('mcp-tools', disabledTabs), 'mcp-tools');
  assert.equal(resolveAllowedWorkspaceTab('sql-check', disabledTabs), 'sql-check');
});

test('resolveAllowedWorkspaceTab normalizes removed workspace tabs to chat', () => {
  const editableTabs = getWorkspaceDisabledTabs('edit');
  const viewOnlyTabs = getWorkspaceDisabledTabs('view');

  for (const oldTab of ['skills', 'tools', 'shell', 'git', 'tasks', 'preview', 'plugin:preview']) {
    assert.equal(resolveAllowedWorkspaceTab(oldTab, editableTabs), 'chat');
    assert.equal(resolveAllowedWorkspaceTab(oldTab, viewOnlyTabs), 'files');
  }
});

test('view-only workspaces can inspect MCP Tools inventory', () => {
  const disabledTabs = getWorkspaceDisabledTabs('view');

  assert.equal(disabledTabs.has('mcp-tools'), false);
  assert.equal(resolveAllowedWorkspaceTab('mcp-tools', disabledTabs), 'mcp-tools');
});

test('view-only workspaces can inspect SQL Check configuration', () => {
  const disabledTabs = getWorkspaceDisabledTabs('view');

  assert.equal(disabledTabs.has('sql-check'), false);
  assert.equal(resolveAllowedWorkspaceTab('sql-check', disabledTabs), 'sql-check');
});
