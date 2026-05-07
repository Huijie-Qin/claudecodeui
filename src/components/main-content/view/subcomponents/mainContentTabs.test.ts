import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMainContentTabs } from './mainContentTabs';

test('buildMainContentTabs places skills and tools beside files before source control', () => {
  const tabs = buildMainContentTabs(false).map((tab) => tab.id);

  assert.deepEqual(tabs, ['chat', 'shell', 'files', 'skills', 'tools', 'git']);
});

test('buildMainContentTabs keeps tasks after source control when taskmaster is available', () => {
  const tabs = buildMainContentTabs(true).map((tab) => tab.id);

  assert.deepEqual(tabs, ['chat', 'shell', 'files', 'skills', 'tools', 'git', 'tasks']);
});
