import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMainContentTabs } from './mainContentTabs';

test('buildMainContentTabs never exposes the address-only Agent Graph entry', () => {
  const tabs = buildMainContentTabs().map((tab) => tab.id);

  assert.deepEqual(tabs, ['chat', 'files', 'codehub', 'mcp-tools', 'sql-check']);
  assert.equal(tabs.includes('agent-graph'), false);
});
