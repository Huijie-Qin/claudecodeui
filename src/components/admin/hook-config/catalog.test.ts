import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVENT_DEFINITIONS,
  buildFieldChoices,
  buildReferenceChoices,
  buildScriptTemplate,
  createHookCopyDraft,
  getClaudeOutputFields,
  inferNativeMatcherMode,
  shouldShowBusinessData,
} from './catalog';
import type { HookConfig, HookConfigDraft, HookResources } from './types';

const resources: HookResources = {
  events: [],
  builtinTools: [],
  mcpTools: [],
  hookMcpServers: [],
  skills: [],
  environmentVariables: [{ path: 'ccui.env.userId', type: 'number' }],
};

const draft: HookConfigDraft = {
  name: 'SQL 分析',
  description: '',
  eventName: 'PreToolUse',
  matcher: { mode: 'regex', value: '^mcp__database__.*$' },
  extensionLogic: null,
  postActions: [],
  claudeResponse: { bindings: {} },
};

test('JavaScript template exposes event inputs and returns declared internal outputs', () => {
  const inputs = buildFieldChoices(draft, resources);
  const template = buildScriptTemplate({
    eventName: 'PreToolUse',
    eventLabel: '工具执行前',
    eventDescription: '工具执行之前触发',
    inputs: inputs.map((field) => ({
      path: field.path,
      label: field.path,
      type: field.type,
    })),
    outputs: [{ name: 'riskLevel', type: 'string' }],
    language: 'javascript',
  });

  assert.match(template, /export async function run\(event, ccui\)/);
  assert.match(template, /event\.tool_input/);
  assert.match(template, /event\.session_id/);
  assert.match(template, /ccui\.workspace\.writeText/);
  assert.match(template, /output:/);
  assert.match(template, /riskLevel/);
  assert.match(template, /不会自动发送给 Claude/);
  assert.doesNotMatch(template, /hookSpecificOutput/);
  assert.ok(!inputs.some((field) => field.path === 'ccui.env.userId'));
});

test('Python template uses the same event, CCUI, and internal output contract', () => {
  const template = buildScriptTemplate({
    eventName: 'UserPromptSubmit',
    eventLabel: '用户提交问题',
    eventDescription: '问题发送给模型之前触发',
    inputs: [{ path: 'event.prompt', label: '用户问题', type: 'string' }],
    outputs: [{ name: 'summary', type: 'string' }],
    language: 'python',
  });

  assert.match(template, /async def run\(event, ccui\):/);
  assert.match(template, /event\.prompt/);
  assert.match(template, /ccui\.records\.write/);
  assert.match(template, /"output"/);
  assert.match(template, /summary/);
  assert.match(template, /ccui\.workspace\.read_text/);
});

test('reference choices include environment, script, and action outputs', () => {
  const choices = buildReferenceChoices({
    ...draft,
    extensionLogic: {
      language: 'javascript',
      code: 'return { output: { riskLevel: "high" } };',
      outputs: [{ name: 'riskLevel', type: 'string' }],
    },
    postActions: [{ id: 'mcp-1', type: 'call_mcp_tool', position: 0, config: {} }],
  }, resources);
  const paths = choices.map((field) => field.path);
  assert.ok(paths.includes('event.tool_name'));
  assert.ok(paths.includes('ccui.env.userId'));
  assert.ok(paths.includes('script.output.riskLevel'));
  assert.ok(paths.includes('actions.mcp-1.output'));
  assert.equal(choices.find((field) => field.path === 'script.output.riskLevel')?.label, 'riskLevel');
});

test('business data stays accessible for configured writers or historical records', () => {
  assert.equal(shouldShowBusinessData({ postActions: [], hasDataRecords: false }), false);
  assert.equal(shouldShowBusinessData({
    postActions: [{ id: 'mcp-1', type: 'call_mcp_tool', position: 0, config: {} }],
    hasDataRecords: false,
  }), false);
  assert.equal(shouldShowBusinessData({
    postActions: [{ id: 'record-1', type: 'write_record', position: 0, config: {} }],
    hasDataRecords: false,
  }), true);
  assert.equal(shouldShowBusinessData({ postActions: [], hasDataRecords: true }), true);
});

test('copying a Hook creates an independent draft without runtime identity or bindings', () => {
  const hook: HookConfig = {
    ...draft,
    postActions: [{ id: 'record-1', type: 'write_record', position: 0, config: { fields: {} } }],
    id: 'hook-1',
    status: 'published',
    version: 3,
    createdBy: 1,
    updatedBy: 1,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    publishedAt: '2026-01-02',
    activationScope: 'all_users',
    bindingController: 'admin',
    boundUserCount: 2,
    scopedUserCount: 2,
    boundTenantCount: 1,
    hasDataRecords: true,
  };

  const copy = createHookCopyDraft(hook, 'SQL 分析（副本）');
  assert.equal(copy.name, 'SQL 分析（副本）');
  assert.equal('id' in copy, false);
  assert.equal('activationScope' in copy, false);
  assert.deepEqual(copy.postActions, hook.postActions);
  copy.postActions[0].config.fields = { copied: true };
  assert.deepEqual(hook.postActions[0].config.fields, {});
});

test('native matcher mode is inferred from the text sent to Claude Code', () => {
  assert.equal(inferNativeMatcherMode('PreToolUse', ''), 'all');
  assert.equal(inferNativeMatcherMode('PreToolUse', 'mcp__database__execute_sql'), 'exact');
  assert.equal(inferNativeMatcherMode('PreToolUse', '^mcp__database__.*$'), 'regex');
  assert.equal(inferNativeMatcherMode('PreToolUse', 'Read|Write'), 'exact');
  assert.equal(inferNativeMatcherMode('FileChanged', '.envrc|.env'), 'exact');
});

test('Claude output fields are constrained by the selected event', () => {
  const preToolFields = getClaudeOutputFields('PreToolUse').map((field) => field.path);
  const stopFields = getClaudeOutputFields('Stop').map((field) => field.path);
  assert.ok(preToolFields.includes('hookSpecificOutput.updatedInput'));
  assert.ok(!stopFields.includes('hookSpecificOutput.updatedInput'));
  assert.ok(stopFields.includes('continue'));
  assert.ok(stopFields.includes('decision'));
  assert.deepEqual(getClaudeOutputFields('StopFailure'), []);
});

test('each SDK event template exposes every callback field once', () => {
  for (const event of EVENT_DEFINITIONS) {
    const keys = event.fields.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, `${event.name} contains duplicate callback fields`);
  }
});
