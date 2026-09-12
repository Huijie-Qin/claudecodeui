import assert from 'node:assert/strict';
import test from 'node:test';

import { subagentHookTimeoutSeconds } from './hook-subagent-mcp-loop.js';

test('child loop budgets extend SDK callback deadlines without overflowing JavaScript timers', () => {
  const hook = { eventName: 'PostToolUse', includeSubagents: true,
    postActions: [{ type: 'mcp_loop_run', config: { maxWaitMs: 2_700_000 } }],
  };
  assert.equal(subagentHookTimeoutSeconds(hook), 2760);
  assert.equal(subagentHookTimeoutSeconds({ ...hook, includeSubagents: false }), 60);
  assert.ok(subagentHookTimeoutSeconds({ ...hook, postActions: Array(10).fill({
    type: 'mcp_loop_run', config: { maxWaitMs: 604_800_000 },
  }) }) * 1000 <= 2_147_483_000);
});
