import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUESTED_HOOK_EXAMPLES,
  createRequestedHookExamples,
  ensureRequestedHookExamples,
} from './hook-examples.js';

function createHarness(initialHooks = []) {
  const hooks = initialHooks.map((hook) => ({ ...hook }));
  let visibleEvents = ['Stop'];
  let examplesInitialized = false;
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
      areRequestedExamplesInitialized: () => examplesInitialized,
      markRequestedExamplesInitialized: () => {
        examplesInitialized = true;
      },
    },
  };
}

test('requested Hook presets create five ready-to-edit drafts with configured resources', () => {
  const harness = createHarness();
  const result = createRequestedHookExamples({
    hookConfigs: harness.hookConfigs,
    userId: 9,
    exampleIds: REQUESTED_HOOK_EXAMPLES.map((example) => example.id),
  });

  assert.equal(result.createdCount, 5);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(result.visibleEvents, ['Stop', 'StopFailure']);
  assert.equal(result.hooks.every((hook) => hook.status === 'draft'), true);

  const sqlCheckExample = result.hooks.find((hook) => hook.name.includes('SQL Check'));
  const sqlRecordExample = result.hooks.find((hook) => hook.name.includes('SQL 行数'));
  const notificationExample = result.hooks.find((hook) => hook.name.includes('正常结束'));
  const failureExample = result.hooks.find((hook) => hook.name === '失败通知');
  const recoveryExample = result.hooks.find((hook) => hook.name.includes('HTTP 200'));

  assert.deepEqual(sqlCheckExample.extensionLogic.outputs.map((output) => output.name), ['detected']);
  assert.equal(sqlCheckExample.extensionLogic.outputs.every((output) => (
    Object.keys(output).sort().join(',') === 'name,type'
  )), true);
  assert.equal(sqlCheckExample.postActions.length, 1);
  assert.equal(sqlCheckExample.postActions[0].type, 'call_mcp_tool');
  assert.equal(sqlCheckExample.postActions[0].config.toolName, 'mcp__sql-syntax-checker__check_sql_syntax');
  assert.deepEqual(sqlCheckExample.postActions[0].config.inputs.sql, {
    source: 'reference',
    path: 'event.last_assistant_message',
  });
  assert.deepEqual(sqlCheckExample.postActions[0].config.inputs.rule_ids, {
    source: 'reference',
    path: 'ccui.env.sqlCheckRuleIds',
  });
  assert.equal(sqlRecordExample.postActions.length, 1);
  assert.equal(sqlRecordExample.extensionLogic.outputs.every((output) => (
    Object.keys(output).sort().join(',') === 'name,type'
  )), true);
  assert.equal(sqlRecordExample.postActions[0].type, 'write_record');
  assert.equal(notificationExample.postActions[0].config.skillId, 'builtin:hook-notification');
  assert.equal(failureExample.postActions[0].config.skillId, 'builtin:hook-notification');
  assert.doesNotMatch(failureExample.postActions[0].config.argumentsTemplate, /error_details|details=/);
  assert.equal(recoveryExample.postActions[0].config.skillId, 'builtin:hook-notification');
  assert.deepEqual(recoveryExample.postActions[0].config.condition, {
    source: 'reference',
    path: 'script.output.shouldRecover',
  });
});

test('built-in Hook presets are initialized automatically and idempotently', () => {
  const harness = createHarness();

  const first = ensureRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9 });
  const second = ensureRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9 });

  assert.equal(first.createdCount, REQUESTED_HOOK_EXAMPLES.length);
  assert.equal(second.createdCount, 0);
  assert.equal(second.skippedCount, REQUESTED_HOOK_EXAMPLES.length);
  assert.equal(harness.hooks.length, REQUESTED_HOOK_EXAMPLES.length);
});

test('automatic initialization does not recreate a built-in preset deleted later', () => {
  const harness = createHarness();
  ensureRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9 });
  const deleted = harness.hooks.pop();

  const afterDelete = ensureRequestedHookExamples({ hookConfigs: harness.hookConfigs, userId: 9 });

  assert.equal(afterDelete.createdCount, 0);
  assert.equal(afterDelete.skippedCount, REQUESTED_HOOK_EXAMPLES.length - 1);
  assert.equal(harness.hooks.some((hook) => hook.name === deleted.name), false);
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

  assert.equal(first.createdCount, 4);
  assert.equal(first.skippedCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.skippedCount, 5);
  assert.equal(harness.hooks.length, 5);
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
