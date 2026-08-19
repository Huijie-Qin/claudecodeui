import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVENT_DEFINITIONS,
  buildFieldChoices,
  buildReferenceChoices,
  buildScriptTemplate,
  getClaudeOutputFields,
  inferNativeMatcherMode,
} from './catalog';
import type { HookConfigDraft, HookResources } from './types';

const resources: HookResources = {
  events: [],
  builtinTools: [],
  mcpTools: [],
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
    outputs: [{ name: 'riskLevel', type: 'string', description: '分析得到的风险等级' }],
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
    outputs: [{ name: 'summary', type: 'string', description: '处理摘要' }],
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
      outputs: [{ name: 'riskLevel', type: 'string', description: '风险等级' }],
    },
    postActions: [{ id: 'mcp-1', type: 'call_mcp_tool', position: 0, config: {} }],
  }, resources);
  const paths = choices.map((field) => field.path);
  assert.ok(paths.includes('event.tool_name'));
  assert.ok(paths.includes('ccui.env.userId'));
  assert.ok(paths.includes('script.output.riskLevel'));
  assert.ok(paths.includes('actions.mcp-1.output'));
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
