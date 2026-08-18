import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUESTED_HOOK_EXAMPLES,
  createRequestedHookExamples,
} from './hook-examples.js';

function createHarness(initialHooks = []) {
  const hooks = initialHooks.map((hook) => ({ ...hook }));
  let visibleEvents = ['Stop'];
  return {
    hooks,
    hookConfigs: {
      listHooks: () => hooks.map((hook) => ({ ...hook })),
      createHook: ({ input, userId }) => {
        const hook = {
          ...JSON.parse(JSON.stringify(input)),
          id: `example-${hooks.length + 1}`,
          status: 'draft',
          createdBy: userId,
        };
        hooks.push(hook);
        return { ...hook };
      },
      getSettings: () => ({ visibleEvents: [...visibleEvents] }),
      updateSettings: (input) => {
        visibleEvents = [...input.visibleEvents];
        return { visibleEvents: [...visibleEvents] };
      },
    },
  };
}

test('requested Hook examples are ready-to-edit drafts with MCP and Skill selections blank', () => {
  const harness = createHarness();
  const result = createRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9 });

  assert.equal(result.createdCount, 3);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(result.visibleEvents, ['Stop', 'StopFailure']);
  assert.equal(result.hooks.every((hook) => hook.status === 'draft'), true);

  const sqlExample = result.hooks.find((hook) => hook.name.includes('SQL'));
  const notificationExample = result.hooks.find((hook) => hook.name.includes('正常结束'));
  const recoveryExample = result.hooks.find((hook) => hook.name.includes('HTTP 200'));

  assert.equal(sqlExample.postActions[0].type, 'call_mcp_tool');
  assert.equal(sqlExample.postActions[0].config.toolName, '');
  assert.deepEqual(sqlExample.postActions[0].config.inputs, {});
  assert.equal(sqlExample.postActions[1].type, 'write_record');
  assert.equal(notificationExample.postActions[0].config.skillId, '');
  assert.equal(notificationExample.postActions[0].config.skillName, '');
  assert.equal(recoveryExample.postActions[0].config.skillId, '');
  assert.equal(recoveryExample.postActions[0].config.skillName, '');
});

test('creating Hook examples is idempotent and never overwrites an existing example', () => {
  const existing = {
    ...JSON.parse(JSON.stringify(REQUESTED_HOOK_EXAMPLES[0])),
    id: 'existing-sql-example',
    status: 'draft',
    description: '管理员已经修改的说明',
  };
  const harness = createHarness([existing]);

  const first = createRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9 });
  const second = createRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9 });

  assert.equal(first.createdCount, 2);
  assert.equal(first.skippedCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.skippedCount, 3);
  assert.equal(harness.hooks.length, 3);
  assert.equal(harness.hooks[0].description, '管理员已经修改的说明');
});
