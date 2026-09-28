import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { HOOK_CONFIG_SCHEMA_SQL } from '../database/hook-config-schema.js';

import { normalizeHookInput } from './hook-configs.js';
import { createHookRuntimeSession } from './hook-runtime.js';
import { subagentHookTimeoutSeconds } from './hook-subagent-mcp-loop.js';

function reviewHook(maxReviews = 3, configOverrides = {}) {
  return {
    id: 'hook-1', name: '完成度复核', version: 1, eventName: 'Stop',
    includeSubagents: false, matcher: {}, extensionLogic: null,
    postActions: [{ id: 'review', type: 'review_completion', position: 0,
      config: { maxReviews, model: '', ...configOverrides } }],
    claudeResponse: { bindings: {} },
  };
}

function databaseFixture() {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)');
  database.exec(HOOK_CONFIG_SCHEMA_SQL);
  database.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('alice');
  database.prepare(`INSERT INTO hooks
    (id, name, event_name, created_by, updated_by, status, activation_scope)
    VALUES ('hook-1', '完成度复核', 'Stop', 1, 1, 'published', 'all_users')`).run();
  return database;
}

test('completion review can only be the final main-agent Stop action', () => {
  const hook = reviewHook();
  const normalized = normalizeHookInput(hook);
  assert.equal(normalized.postActions[0].config.maxReviews, 3);
  assert.equal(normalized.postActions[0].config.criteria, '');
  assert.deepEqual(normalized.postActions[0].config.artifactPaths, []);
  assert.equal(subagentHookTimeoutSeconds(normalized), 120);
  assert.throws(() => normalizeHookInput({ ...hook, eventName: 'PostToolUse' }), /only supported for Stop/);
  assert.throws(() => normalizeHookInput({ ...hook, includeSubagents: true }), /only supports the main agent/);
  assert.throws(() => normalizeHookInput({ ...hook, postActions: [
    hook.postActions[0], { ...hook.postActions[0], id: 'another' },
  ] }), /at most one/);
  assert.throws(() => normalizeHookInput({ ...hook, postActions: [
    hook.postActions[0], { id: 'message', type: 'send_agent_message', config: { messageTemplate: 'x' } },
  ] }), /must be the final/);
  assert.throws(() => normalizeHookInput({ ...hook, postActions: [{
    ...hook.postActions[0], config: { maxReviews: 11 },
  }] }), /maxReviews/);
  assert.throws(() => normalizeHookInput({ ...hook, claudeResponse: { bindings: {
    decision: { source: 'literal', value: 'approve' },
  } } }), /controls Claude response field decision/);
});

test('model review accepts bounded custom criteria and workspace artifact hints', () => {
  const hook = reviewHook(3, {
    criteria: ' 报告需要摘要、数据表和结论；数据项必须含 id 与 value。 ',
    artifactPaths: [' reports/**/*.md ', 'output/data.json', 'reports/**/*.md'],
  });
  const normalized = normalizeHookInput(hook);
  assert.equal(normalized.postActions[0].config.criteria,
    '报告需要摘要、数据表和结论；数据项必须含 id 与 value。');
  assert.deepEqual(normalized.postActions[0].config.artifactPaths,
    ['reports/**/*.md', 'output/data.json']);
  assert.throws(() => normalizeHookInput(reviewHook(3, { criteria: 'x'.repeat(8_001) })), /criteria/);
  assert.throws(() => normalizeHookInput(reviewHook(3, { artifactPaths: 'reports/' })), /artifactPaths/);
  assert.throws(() => normalizeHookInput(reviewHook(3, { artifactPaths: Array(21).fill('a') })), /artifactPaths/);
  for (const invalid of ['/tmp/report.md', '../secret.json', 'reports/../secret.json',
    'C:\\report.json', 'https://example.com/report', '~/report.md']) {
    assert.throws(() => normalizeHookInput(reviewHook(3, { artifactPaths: [invalid] })), /workspace-relative/);
  }
});

test('program validation path accepts declared object script output or an earlier MCP action', () => {
  const scriptHook = {
    ...reviewHook(3, { validationResultPath: 'script.output.validation' }),
    extensionLogic: {
      language: 'javascript', code: 'export async function run() { return { output: {} }; }',
      outputs: [{ name: 'validation', type: 'object' }, { name: 'summary', type: 'string' }],
    },
  };
  assert.equal(normalizeHookInput(scriptHook).postActions[0].config.validationResultPath,
    'script.output.validation');

  const checkAction = { id: 'check', type: 'call_mcp_tool', position: 0,
    config: { toolName: 'mcp__report__validate', inputs: {} } };
  const mcpHook = { ...reviewHook(3, { validationResultPath: 'actions.check.output' }),
    postActions: [checkAction, {
      ...reviewHook(3, { validationResultPath: 'actions.check.output' }).postActions[0], position: 1,
    }] };
  assert.equal(normalizeHookInput(mcpHook).postActions[1].config.validationResultPath,
    'actions.check.output');

  for (const invalidPath of [
    'script.output.summary', 'script.output.missing', 'script.output.validation.passed',
    'actions.missing.output', 'actions.check.output.passed', 'event.last_assistant_message',
  ]) {
    const hook = invalidPath.startsWith('actions.') ? mcpHook : scriptHook;
    assert.throws(() => normalizeHookInput({ ...hook,
      postActions: hook.postActions.map((action) => action.type === 'review_completion'
        ? { ...action, config: { ...action.config, validationResultPath: invalidPath } } : action),
    }), /validationResultPath/);
  }
  assert.throws(() => normalizeHookInput({ ...mcpHook, postActions: [
    { ...mcpHook.postActions[0], type: 'write_record', config: { recordType: 'check', fields: {} } },
    mcpHook.postActions[1],
  ] }), /validationResultPath/);
});

test('legacy review counts remain readable, while new publication is limited to five', () => {
  for (const maxReviews of [6, 10]) {
    const legacy = normalizeHookInput(reviewHook(maxReviews));
    assert.equal(legacy.postActions[0].config.maxReviews, maxReviews);
    assert.throws(() => normalizeHookInput(reviewHook(maxReviews), { strict: true }), /maxReviews/);
  }
  assert.equal(normalizeHookInput(reviewHook(5), { strict: true }).postActions[0].config.maxReviews, 5);
});

test('an incomplete verdict blocks the same main loop and a later pass approves it', async () => {
  const database = databaseFixture();
  const hook = reviewHook();
  const calls = [];
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database, userId: 1,
      reviewCompletion: async (request) => {
        calls.push(request);
        return calls.length === 1
          ? { complete: false, reason: '缺少测试证据', nextStep: '运行相关测试。' }
          : { complete: true, reason: '测试已通过', nextStep: '' };
      },
    });
    const event = { hook_event_name: 'Stop', session_id: 'main', last_assistant_message: '完成' };
    assert.deepEqual(await runtime.executeHook(hook, event), {
      decision: 'block', reason: '缺少测试证据\n运行相关测试。',
    });
    assert.deepEqual(await runtime.executeHook(hook, { ...event, stop_hook_active: true }), {
      decision: 'approve', reason: '测试已通过',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].event, event);
    assert.deepEqual(JSON.parse(database.prepare('SELECT actions_json FROM hook_executions ORDER BY rowid LIMIT 1').get().actions_json)
      .review.output.reviewNumber, 1);
    assert.deepEqual(await runtime.executeHook(hook, { ...event, agent_id: 'child' }), {});
    assert.equal(calls.length, 2);
  } finally { database.close(); }
});

test('runtime passes acceptance criteria and artifact hints to the independent reviewer', async () => {
  const database = databaseFixture();
  const hook = reviewHook(2, {
    criteria: '报告必须有摘要和结论，数据结构必须有 id 字段。',
    artifactPaths: ['reports/**/*.md', 'data/output.json'],
  });
  const calls = [];
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database, userId: 1,
      reviewCompletion: async (request) => {
        calls.push(request);
        return { complete: false, reason: '报告缺少结论', nextStep: '补充结论章节。' };
      },
    });
    const result = await runtime.executeHook(hook, {
      hook_event_name: 'Stop', session_id: 'main', last_assistant_message: '报告已生成',
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /报告缺少结论/);
    assert.equal(calls[0].criteria, hook.postActions[0].config.criteria);
    assert.deepEqual(calls[0].artifactPaths, hook.postActions[0].config.artifactPaths);
  } finally { database.close(); }
});

test('program validation failure blocks an approving reviewer and is retried with fresh script output', async () => {
  const database = databaseFixture();
  const hook = reviewHook(3, { validationResultPath: 'script.output.validation' });
  hook.extensionLogic = {
    language: 'javascript', code: 'export async function run() { return { output: {} }; }',
    outputs: [{ name: 'validation', type: 'object' }],
  };
  let scriptRuns = 0;
  const reviewerInputs = [];
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database, userId: 1,
      scriptExecutor: async () => ({ output: { validation: ++scriptRuns === 1
        ? { passed: false, issues: ['data.json 缺少 id 字段'], evidence: ['output/data.json'] }
        : { passed: true, issues: [], evidence: ['output/data.json'] } } }),
      reviewCompletion: async (request) => {
        reviewerInputs.push(request);
        return { complete: true, reason: '报告文字符合要求', nextStep: '' };
      },
    });
    const event = { hook_event_name: 'Stop', session_id: 'main', last_assistant_message: '完成' };
    const first = await runtime.executeHook(hook, event);
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /data\.json 缺少 id 字段/);
    assert.equal(first.continue, undefined);
    assert.deepEqual(reviewerInputs[0].validationResult,
      { passed: false, issues: ['data.json 缺少 id 字段'], evidence: ['output/data.json'] });
    const firstAudit = JSON.parse(database.prepare(
      'SELECT actions_json FROM hook_executions ORDER BY rowid LIMIT 1').get().actions_json);
    assert.deepEqual(firstAudit.review.output.validationResult, reviewerInputs[0].validationResult);
    assert.equal(firstAudit.review.output.complete, false);

    const second = await runtime.executeHook(hook, { ...event, stop_hook_active: true });
    assert.equal(second.decision, 'approve');
    assert.equal(scriptRuns, 2);
    assert.deepEqual(reviewerInputs[1].validationResult,
      { passed: true, issues: [], evidence: ['output/data.json'] });
  } finally { database.close(); }
});

test('review can consume an earlier MCP validation result without adding a new action type', async () => {
  const database = databaseFixture();
  const hook = reviewHook(2, { validationResultPath: 'actions.check.output' });
  hook.postActions.unshift({ id: 'check', type: 'call_mcp_tool', position: 0,
    config: { toolName: 'mcp__report__validate', inputs: {} } });
  const seen = [];
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database, userId: 1,
      mcpCaller: async ({ qualifiedToolName }) => {
        assert.equal(qualifiedToolName, 'mcp__report__validate');
        return { passed: true, issues: [], evidence: { checked: 'output/report.html' } };
      },
      reviewCompletion: async (request) => {
        seen.push(request.validationResult);
        return { complete: true, reason: '报告符合要求', nextStep: '' };
      },
    });
    const response = await runtime.executeHook(hook, {
      hook_event_name: 'Stop', session_id: 'main', last_assistant_message: '已交付',
    });
    assert.equal(response.decision, 'approve');
    assert.deepEqual(seen, [{ passed: true, issues: [], evidence: { checked: 'output/report.html' } }]);
    const actions = JSON.parse(database.prepare('SELECT actions_json FROM hook_executions').get().actions_json);
    assert.deepEqual(actions.review.output.validationResult, seen[0]);
  } finally { database.close(); }
});

test('missing and malformed program validation results fail closed without launching a reviewer', async () => {
  for (const output of [undefined, { passed: 'true', issues: [] }, { passed: true, issues: 'none' }]) {
    const database = databaseFixture();
    const hook = reviewHook(2, { validationResultPath: 'script.output.validation' });
    hook.extensionLogic = {
      language: 'javascript', code: 'export async function run() { return { output: {} }; }',
      outputs: [{ name: 'validation', type: 'object' }],
    };
    let reviewerCalls = 0;
    try {
      const runtime = createHookRuntimeSession({ hooks: [hook], database, userId: 1,
        scriptExecutor: async () => ({ output: output === undefined ? {} : { validation: output } }),
        reviewCompletion: async () => {
          reviewerCalls += 1;
          return { complete: true, reason: '模型认为完成', nextStep: '' };
        },
      });
      const result = await runtime.executeHook(hook, { hook_event_name: 'Stop', session_id: 'main' });
      assert.equal(result.decision, 'block');
      assert.equal(reviewerCalls, 0);
      const audit = database.prepare('SELECT status, actions_json FROM hook_executions').get();
      assert.equal(audit.status, 'failed');
      const review = JSON.parse(audit.actions_json).review.output;
      assert.equal(review.validationResult, null);
      assert.equal(review.failed, true);
      assert.equal(typeof review.validationError, 'string');
    } finally { database.close(); }
  }
});

test('legacy review count is capped at five Stop blocks at runtime', async () => {
  const database = databaseFixture();
  const hook = reviewHook(10);
  let reviewerCalls = 0;
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database, userId: 1,
      reviewCompletion: async () => {
        reviewerCalls += 1;
        return { complete: false, reason: '缺少交付物', nextStep: '继续完成。' };
      },
    });
    const event = { hook_event_name: 'Stop', session_id: 'legacy-main' };
    for (let reviewNumber = 1; reviewNumber < 5; reviewNumber += 1) {
      assert.equal((await runtime.executeHook(hook, { ...event,
        stop_hook_active: reviewNumber > 1 })).decision, 'block');
    }
    const final = await runtime.executeHook(hook, { ...event, stop_hook_active: true });
    assert.equal(final.continue, false);
    assert.match(final.stopReason, /5 次/);
    assert.equal(reviewerCalls, 5);
  } finally { database.close(); }
});

test('review errors block, then fail explicitly at the bounded review limit', async () => {
  const database = databaseFixture();
  const hook = reviewHook(2);
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database, userId: 1,
      reviewCompletion: async () => { throw new Error('reviewer unavailable'); },
    });
    const event = { hook_event_name: 'Stop', session_id: 'main' };
    const first = await runtime.executeHook(hook, event);
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /审查模型调用失败/);
    assert.doesNotMatch(first.reason, /reviewer unavailable/);
    const second = await runtime.executeHook(hook, { ...event, stop_hook_active: true });
    assert.equal(second.continue, false);
    assert.match(second.stopReason, /2 次/);
    assert.deepEqual(database.prepare('SELECT status FROM hook_executions ORDER BY rowid').all()
      .map((row) => row.status), ['failed', 'failed']);
  } finally { database.close(); }
});

test('audit storage failures cannot silently bypass completion review', async () => {
  const hook = reviewHook(2);
  const runtime = createHookRuntimeSession({ hooks: [hook], userId: 1,
    database: { prepare: () => { throw new Error('audit database unavailable'); } },
    reviewCompletion: async () => { throw new Error('review should not start'); },
  });
  const event = { hook_event_name: 'Stop', session_id: 'main' };
  assert.equal((await runtime.executeHook(hook, event)).decision, 'block');
  const last = await runtime.executeHook(hook, { ...event, stop_hook_active: true });
  assert.equal(last.continue, false);
  assert.match(last.stopReason, /无法保存执行记录/);
});
