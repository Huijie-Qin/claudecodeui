import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMainContentTabs } from './mainContentTabs';

test('buildMainContentTabs hides Agent Graph by default', () => {
  const tabs = buildMainContentTabs().map((tab) => tab.id);

  assert.deepEqual(tabs, ['chat', 'files', 'codehub', 'mcp-tools', 'sql-check']);
});

test('buildMainContentTabs exposes Agent Graph only when its experiment is enabled', () => {
  const tabs = buildMainContentTabs(true).map((tab) => tab.id);

  assert.deepEqual(tabs, ['chat', 'files', 'codehub', 'mcp-tools', 'sql-check', 'agent-graph']);
});
