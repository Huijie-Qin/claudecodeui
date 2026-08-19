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
  const result = createRequestedHookExamples({
    hookConfigs: harness.hookConfigs,
    userId: 9,
    exampleIds: REQUESTED_HOOK_EXAMPLES.map((example) => example.id),
  });

  assert.equal(result.createdCount, 4);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(result.visibleEvents, ['Stop', 'StopFailure']);
  assert.equal(result.hooks.every((hook) => hook.status === 'draft'), true);

  const sqlCheckExample = result.hooks.find((hook) => hook.name.includes('SQL Check'));
  const sqlRecordExample = result.hooks.find((hook) => hook.name.includes('SQL 行数'));
  const notificationExample = result.hooks.find((hook) => hook.name.includes('正常结束'));
  const recoveryExample = result.hooks.find((hook) => hook.name.includes('HTTP 200'));

  assert.deepEqual(sqlCheckExample.extensionLogic.outputs.map((output) => output.name), ['detected']);
  assert.equal(sqlCheckExample.postActions.length, 1);
  assert.equal(sqlCheckExample.postActions[0].type, 'call_mcp_tool');
  assert.equal(sqlCheckExample.postActions[0].config.toolName, '');
  assert.deepEqual(sqlCheckExample.postActions[0].config.inputs, {});
  assert.equal(sqlRecordExample.postActions.length, 1);
  assert.equal(sqlRecordExample.postActions[0].type, 'write_record');
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

  const exampleIds = REQUESTED_HOOK_EXAMPLES.map((example) => example.id);
  const first = createRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9, exampleIds });
  const second = createRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9, exampleIds });

  assert.equal(first.createdCount, 3);
  assert.equal(first.skippedCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.skippedCount, 4);
  assert.equal(harness.hooks.length, 4);
  assert.equal(harness.hooks[0].description, '管理员已经修改的说明');
});

test('only explicitly selected Hook examples are created', () => {
  const harness = createHarness();
  const selected = REQUESTED_HOOK_EXAMPLES[1];

  const result = createRequestedHookExamples({
    hookConfigs: harness.hookConfigs,
    userId: 9,
    exampleIds: [selected.id],
  });

  assert.equal(result.createdCount, 1);
  assert.equal(result.hooks[0].name, selected.name);
  assert.deepEqual(result.visibleEvents, ['Stop']);
  assert.equal(harness.hooks.length, 1);
});

test('creating Hook examples requires an explicit selection', () => {
  const harness = createHarness();

  assert.throws(
    () => createRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9, exampleIds: [] }),
    /Select at least one Hook example/,
  );
  assert.equal(harness.hooks.length, 0);
});
