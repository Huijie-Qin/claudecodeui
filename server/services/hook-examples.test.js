import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUESTED_HOOK_EXAMPLES,
  createRequestedHookExamples,
} from './hook-examples.js';
import { executeHookScript } from './hook-script-executor.js';

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

  assert.deepEqual(sqlCheckExample.extensionLogic.outputs.map((output) => output.name), ['detected', 'sql']);
  assert.equal(sqlCheckExample.extensionLogic.outputs.every((output) => (
    Object.keys(output).sort().join(',') === 'name,type'
  )), true);
  assert.equal(sqlCheckExample.postActions.length, 1);
  assert.equal(sqlCheckExample.postActions[0].type, 'call_mcp_tool');
  assert.equal(sqlCheckExample.postActions[0].config.toolName, 'mcp__sql-syntax-checker__check_sql_syntax');
  assert.deepEqual(sqlCheckExample.postActions[0].config.inputs.sql, {
    source: 'reference',
    path: 'script.output.sql',
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

async function runSqlExample(example, message) {
  return executeHookScript({
    hookId: example.id,
    language: example.extensionLogic.language,
    code: example.extensionLogic.code,
    event: {
      hook_event_name: 'Stop',
      session_id: 'sql-return-matrix',
      last_assistant_message: message,
    },
    env: { sessionId: 'sql-return-matrix' },
    workspaceRoot: process.cwd(),
  });
}

test('SQL Hook presets detect common Agent SQL return formats and extract clean SQL', async () => {
  const sqlCheckExample = REQUESTED_HOOK_EXAMPLES.find((hook) => hook.id === 'sql-check-enforcement');
  const sqlRecordExample = REQUESTED_HOOK_EXAMPLES.find((hook) => hook.id === 'sql-line-record');
  const cases = [
    {
      name: 'sql fence',
      message: '```sql\nSELECT 1 AS fenced_case;\n```',
      expectedSql: 'SELECT 1 AS fenced_case;',
    },
    {
      name: 'dialect fence',
      message: '```postgresql\nSELECT 2 AS dialect_case;\n```',
      expectedSql: 'SELECT 2 AS dialect_case;',
    },
    {
      name: 'unlabelled fence',
      message: '```\nSELECT 3 AS unlabelled_case;\n```',
      expectedSql: 'SELECT 3 AS unlabelled_case;',
    },
    {
      name: 'inline code',
      message: 'Use `SELECT 4 AS inline_case;`',
      expectedSql: 'SELECT 4 AS inline_case;',
    },
    {
      name: 'markdown list',
      message: '- SELECT 5 AS list_case;',
      expectedSql: 'SELECT 5 AS list_case;',
    },
    {
      name: 'labelled text',
      message: 'SQL: SELECT 6 AS labelled_case;',
      expectedSql: 'SELECT 6 AS labelled_case;',
    },
    {
      name: 'JSON field',
      message: JSON.stringify({ sql: 'SELECT 7 AS json_case;' }),
      expectedSql: 'SELECT 7 AS json_case;',
    },
    {
      name: 'JSON fence field',
      message: '```json\n{"query":"SELECT 71 AS json_fence_case;"}\n```',
      expectedSql: 'SELECT 71 AS json_fence_case;',
    },
    {
      name: 'XML element',
      message: '<sql>SELECT 8 AS xml_case;</sql>',
      expectedSql: 'SELECT 8 AS xml_case;',
    },
    {
      name: 'extended SQL keyword',
      message: 'EXPLAIN SELECT * FROM orders;',
      expectedSql: 'EXPLAIN SELECT * FROM orders;',
      expectedType: 'EXPLAIN',
    },
    {
      name: 'prose before multiline SQL',
      message: '查询结果如下：\nSELECT user_id, COUNT(*)\nFROM orders\nGROUP BY user_id;',
      expectedSql: 'SELECT user_id, COUNT(*)\nFROM orders\nGROUP BY user_id;',
      expectedLines: 3,
    },
  ];

  for (const testCase of cases) {
    const [checkResult, recordResult] = await Promise.all([
      runSqlExample(sqlCheckExample, testCase.message),
      runSqlExample(sqlRecordExample, testCase.message),
    ]);
    assert.equal(checkResult.output.detected, true, testCase.name);
    assert.equal(checkResult.output.sql, testCase.expectedSql, testCase.name);
    assert.equal(recordResult.output.detected, true, testCase.name);
    assert.equal(recordResult.output.sqlBlockCount, 1, testCase.name);
    assert.equal(recordResult.output.sqlLineCount, testCase.expectedLines || 1, testCase.name);
    assert.deepEqual(recordResult.output.statementTypes, [testCase.expectedType || 'SELECT'], testCase.name);
  }
});

test('SQL Hook presets ignore prose and non-SQL code', async () => {
  const sqlRecordExample = REQUESTED_HOOK_EXAMPLES.find((hook) => hook.id === 'sql-line-record');
  for (const message of [
    'The SELECT keyword starts a query.',
    '```javascript\nconst statement = "SELECT 1";\n```',
    JSON.stringify({ message: 'SELECT is available' }),
  ]) {
    const result = await runSqlExample(sqlRecordExample, message);
    assert.equal(result.output.detected, false, message);
  }
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
