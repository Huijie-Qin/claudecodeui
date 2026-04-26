import assert from 'node:assert/strict';
import test from 'node:test';

import { getWorkspaceDisabledTabs, resolveAllowedWorkspaceTab } from './mainContentAccess';

test('getWorkspaceDisabledTabs disables write and execution tabs for view-only workspaces', () => {
  assert.deepEqual(Array.from(getWorkspaceDisabledTabs('view')).sort(), ['chat', 'git', 'shell']);
  assert.equal(getWorkspaceDisabledTabs('edit').size, 0);
  assert.equal(getWorkspaceDisabledTabs('owner').size, 0);
});

test('resolveAllowedWorkspaceTab falls back to files when active tab is disabled', () => {
  const disabledTabs = getWorkspaceDisabledTabs('view');

  assert.equal(resolveAllowedWorkspaceTab('chat', disabledTabs), 'files');
  assert.equal(resolveAllowedWorkspaceTab('files', disabledTabs), 'files');
  assert.equal(resolveAllowedWorkspaceTab('plugin:preview', disabledTabs), 'plugin:preview');
});
