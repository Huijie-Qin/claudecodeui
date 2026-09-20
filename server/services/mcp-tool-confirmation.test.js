import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMcpToolConfirmation } from './mcp-tool-confirmation.js';

test('MCP confirmation requires an explicit boolean approval and denies cancellation or timeout', () => {
  const input = { account: 'demo', amount: 7 };
  for (const decision of [undefined, null, {}, { allow: false }, { allow: 'true' },
    { allow: 1 }, { allow: true, cancelled: true }, { rememberEntry: 'mcp__demo__echo' }]) {
    assert.equal(resolveMcpToolConfirmation(decision, input).behavior, 'deny');
  }
  assert.deepEqual(resolveMcpToolConfirmation({ allow: false, message: '取消调用' }, input),
    { behavior: 'deny', message: '取消调用' });
});

test('approval applies only to the displayed arguments and cannot save a rule or substitute input', () => {
  const input = { nested: { text: '用户已核对的参数' }, count: 0, enabled: false };
  const response = resolveMcpToolConfirmation({ allow: true,
    rememberEntry: 'mcp__demo__echo', updatedInput: { replacement: true } }, input);
  assert.deepEqual(response, { behavior: 'allow', updatedInput: input });
  assert.equal(response.updatedInput, input);
  assert.equal(Object.hasOwn(response, 'updatedPermissions'), false);
  assert.equal(resolveMcpToolConfirmation(null, input).behavior, 'deny', 'Approval is not remembered for another call');
});
