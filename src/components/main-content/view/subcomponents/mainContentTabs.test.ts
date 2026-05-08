import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMainContentTabs } from './mainContentTabs';

test('buildMainContentTabs only exposes Chat, Files, and MCP Tools', () => {
  const tabs = buildMainContentTabs().map((tab) => tab.id);

  assert.deepEqual(tabs, ['chat', 'files', 'mcp-tools']);
});
