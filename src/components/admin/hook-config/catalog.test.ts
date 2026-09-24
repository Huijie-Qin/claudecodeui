import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVENT_DEFINITIONS,
  buildCompletionReviewValidationChoices,
  buildFieldChoices,
  buildReferenceChoices,
  buildScriptTemplate,
  canAddCompletionReviewAction,
  canAddConfirmationAction,
  createDefaultCompletionReviewConfig,
  createEmptyHook,
  createHookCopyDraft,
  getCompletionReviewConfigError,
  getHookSubagentLabel,
  getClaudeOutputFields,
  inferNativeMatcherMode,
  hasTerminalPostAction,
  parseCompletionReviewArtifactPaths,
  retainCompatiblePostActions,
  retainReviewCompatibleClaudeBindings,
  shouldShowBusinessData,
} from './catalog';
import type { HookConfig, HookConfigDraft, HookPostAction, HookResources } from './types';

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

test('confirmation exposes typed request fields without implying user approval', () => {
  const choices = buildReferenceChoices({
    ...draft,
    postActions: [{ id: 'confirm-1', type: 'request_confirmation', position: 0, config: {} }],
  }, resources).filter((field) => field.group === 'action');

  assert.deepEqual(choices.map(({ path, type }) => ({ path, type })), [
    { path: 'actions.confirm-1.output', type: 'object' },
    { path: 'actions.confirm-1.output.requested', type: 'boolean' },
    { path: 'actions.confirm-1.output.reason', type: 'string' },
    { path: 'actions.confirm-1.output.toolName', type: 'string' },
    { path: 'actions.confirm-1.output.toolInput', type: 'object' },
  ]);
  assert.match(choices.find((field) => field.path.endsWith('.requested'))?.label || '', /不代表用户已同意/);
});

test('confirmation is available only before tool execution and ends the action list', () => {
  for (const event of EVENT_DEFINITIONS) {
    assert.equal(canAddConfirmationAction({ ...draft, eventName: event.name }), event.name === 'PreToolUse', event.name);
  }
  const record: HookPostAction = { id: 'record', type: 'write_record', position: 0, config: {} };
  assert.equal(canAddConfirmationAction({ ...draft, postActions: [record] }), true);
  assert.equal(hasTerminalPostAction([record]), false);
  for (const type of ['request_confirmation', 'mcp_loop_run', 'review_completion'] as const) {
    const actions: HookPostAction[] = [record, { id: 'terminal', type, position: 1, config: {} }];
    assert.equal(canAddConfirmationAction({ ...draft, postActions: actions }), false);
    assert.equal(hasTerminalPostAction(actions), true);
  }
});

test('completion review is available once for Stop and ends the action list', () => {
  for (const event of EVENT_DEFINITIONS) {
    assert.equal(canAddCompletionReviewAction({ ...draft, eventName: event.name }), event.name === 'Stop', event.name);
  }
  const record: HookPostAction = { id: 'record', type: 'write_record', position: 0, config: {} };
  const review: HookPostAction = { id: 'review', type: 'review_completion', position: 1, config: { maxReviews: 3, model: '' } };
  assert.equal(canAddCompletionReviewAction({ ...draft, eventName: 'Stop', postActions: [record] }), true);
  assert.equal(canAddCompletionReviewAction({ ...draft, eventName: 'Stop', postActions: [record, review] }), false);
  assert.equal(hasTerminalPostAction([record, review]), true);
});

test('completion review exposes typed verdict fields', () => {
  const choices = buildReferenceChoices({
    ...draft,
    eventName: 'Stop',
    postActions: [{ id: 'review', type: 'review_completion', position: 0, config: {} }],
  }, resources).filter((field) => field.group === 'action');

  assert.deepEqual(choices.map(({ path, type }) => ({ path, type })), [
    { path: 'actions.review.output', type: 'object' },
    { path: 'actions.review.output.complete', type: 'boolean' },
    { path: 'actions.review.output.reason', type: 'string' },
    { path: 'actions.review.output.nextStep', type: 'string' },
    { path: 'actions.review.output.reviewNumber', type: 'number' },
    { path: 'actions.review.output.maxReviews', type: 'number' },
    { path: 'actions.review.output.failed', type: 'boolean' },
  ]);
});

test('model review config keeps legacy defaults and validates optional acceptance inputs', () => {
  const defaults = createDefaultCompletionReviewConfig();
  assert.deepEqual(defaults, { maxReviews: 3, model: '', criteria: '', artifactPaths: [] });
  assert.equal(getCompletionReviewConfigError(defaults), null);
  assert.equal(getCompletionReviewConfigError({ maxReviews: 3, model: '' }), null);
  assert.equal(getCompletionReviewConfigError({ ...defaults, maxReviews: 5 }), null);
  assert.equal(getCompletionReviewConfigError({ ...defaults, maxReviews: 6 }), 'maxReviews');
  assert.equal(getCompletionReviewConfigError({ ...defaults, maxReviews: null }), 'maxReviews');
  assert.deepEqual(parseCompletionReviewArtifactPaths(' ./reports/** \n\n screenshots/[ab]?.png \r\n'), [
    './reports/**',
    'screenshots/[ab]?.png',
  ]);
  assert.equal(getCompletionReviewConfigError({
    ...defaults,
    criteria: 'x'.repeat(8000),
    artifactPaths: ['./reports/**', 'screenshots/[ab]?.png', 'x'.repeat(500)],
  }), null);
  assert.equal(getCompletionReviewConfigError({ ...defaults, criteria: 'x'.repeat(8001) }), 'criteria');
  assert.equal(getCompletionReviewConfigError({ ...defaults, artifactPaths: Array(21).fill('report.md') }), 'artifactPathsCount');
  assert.equal(getCompletionReviewConfigError({ ...defaults, artifactPaths: ['x'.repeat(501)] }), 'artifactPathLength');
  for (const path of ['/tmp/report.md', '~/report.md', 'C:/report.md', '\\\\server\\report.md', 'https://example.com/report', 'foo/../bar', 'foo\\bar', 'foo\tbar']) {
    assert.equal(getCompletionReviewConfigError({ ...defaults, artifactPaths: [path] }), 'artifactPathFormat', path);
  }
});

test('model review can reference only declared object script outputs or earlier MCP results', () => {
  const hook: HookConfigDraft = {
    ...draft,
    eventName: 'Stop',
    extensionLogic: {
      language: 'javascript',
      code: 'return { output: { validation: { passed: true } } };',
      outputs: [
        { name: 'validation', type: 'object' },
        { name: 'summary', type: 'string' },
      ],
    },
    postActions: [
      { id: 'mcp-before', type: 'call_mcp_tool', position: 0, config: { toolName: 'validate_report' } },
      { id: 'record-before', type: 'write_record', position: 1, config: {} },
      { id: 'review', type: 'review_completion', position: 2, config: {} },
      { id: 'mcp-after', type: 'call_mcp_tool', position: 3, config: {} },
    ],
  };
  const choices = buildCompletionReviewValidationChoices(hook, 'review');
  const paths = choices.map((choice) => choice.path);
  assert.deepEqual(paths, ['script.output.validation', 'actions.mcp-before.output']);
  const defaults = createDefaultCompletionReviewConfig();
  assert.equal(getCompletionReviewConfigError({ ...defaults, validationResultPath: paths[0] }, paths), null);
  assert.equal(getCompletionReviewConfigError({ ...defaults, validationResultPath: paths[1] }, paths), null);
  assert.equal(getCompletionReviewConfigError({ ...defaults, validationResultPath: 'script.output.summary' }, paths), 'validationResultPath');
  assert.equal(getCompletionReviewConfigError({ ...defaults, validationResultPath: 'actions.mcp-after.output' }, paths), 'validationResultPath');
});

test('changing events removes incompatible actions and reindexes retained actions', () => {
  const actions: HookPostAction[] = [
    { id: 'skill', type: 'invoke_skill', position: 0, config: {} },
    { id: 'record', type: 'write_record', position: 1, config: { recordType: 'audit' } },
    { id: 'review', type: 'review_completion', position: 2, config: { maxReviews: 3, model: '' } },
    { id: 'message', type: 'send_agent_message', position: 3, config: {} },
    { id: 'confirm', type: 'request_confirmation', position: 4, config: {} },
    { id: 'loop', type: 'mcp_loop_run', position: 5, config: {} },
    { id: 'duplicate-review', type: 'review_completion', position: 6, config: { maxReviews: 5, model: 'other' } },
  ];
  for (const [eventName, expectedIds] of [
    ['PreToolUse', ['record', 'confirm']],
    ['PostToolUse', ['record', 'loop']],
    ['Stop', ['skill', 'record', 'message', 'review']],
    ['StopFailure', ['skill', 'record', 'message']],
    ['SessionStart', ['record']],
  ] as const) {
    const retained = retainCompatiblePostActions(actions, eventName);
    assert.deepEqual(retained.map(({ id }) => id), expectedIds);
    assert.deepEqual(retained.map(({ position }) => position), expectedIds.map((_, index) => index));
    assert.deepEqual(retained.find(({ id }) => id === 'record')?.config, { recordType: 'audit' });
  }
  assert.equal(actions[1].position, 1);
});

test('an MCP Matcher exposes its tool input schema even when native matcher syntax is regex', () => {
  const mcpResources: HookResources = {
    ...resources,
    mcpTools: [{
      name: 'mcp__tasks__get_task_status',
      mcpServerId: 'tasks-server',
      serverName: 'tasks',
      serverDisplayName: 'Tasks',
      runtimeAlias: 'ccui-hook-tasks',
      toolName: 'get_task_status',
      description: '',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task ID' } },
      },
      tenantCodes: [],
    }],
  };
  const choices = buildFieldChoices({
    ...draft,
    eventName: 'PostToolUse',
    matcher: { mode: 'regex', value: 'mcp__tasks__get_task_status' },
  }, mcpResources);
  assert.ok(choices.some((field) => field.path === 'event.tool_input.task_id'));
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
  assert.equal(copy.includeSubagents, true);
  assert.deepEqual(copy.postActions, hook.postActions);
  copy.postActions[0].config.fields = { copied: true };
  assert.deepEqual(hook.postActions[0].config.fields, {});
});

test('new Hooks require an explicit opt-in to run inside subagents', () => {
  for (const { name } of EVENT_DEFINITIONS) {
    assert.equal(createEmptyHook(name).includeSubagents, false, name);
  }
});

test('copying preserves explicit subagent choices and historical event defaults', () => {
  for (const includeSubagents of [false, true]) {
    const copy = createHookCopyDraft({ ...draft, includeSubagents } as HookConfig, '副本');
    assert.equal(copy.includeSubagents, includeSubagents);
  }
  assert.equal(createHookCopyDraft(draft as HookConfig, '旧工具 Hook 副本').includeSubagents, true);
  assert.equal(createHookCopyDraft({ ...draft, eventName: 'Stop' } as HookConfig, '旧 Stop Hook 副本').includeSubagents, false);
});

test('subagent labels distinguish opt-in, historical defaults, and native child events', () => {
  assert.equal(getHookSubagentLabel(createEmptyHook('PreToolUse')), '仅主代理');
  assert.equal(getHookSubagentLabel({ eventName: 'PreToolUse' }), '主代理和子代理');
  assert.equal(getHookSubagentLabel({ eventName: 'Stop' }), '仅主代理');
  assert.equal(getHookSubagentLabel({ eventName: 'Stop', includeSubagents: true }), '主代理和子代理');
  assert.equal(getHookSubagentLabel({ eventName: 'SubagentStart' }), '子代理');
  assert.equal(getHookSubagentLabel({ eventName: 'SubagentStop' }), '子代理');
  assert.equal(getHookSubagentLabel({ eventName: 'SessionStart' }), null);
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

test('completion review reserves its four Claude response fields and clears conflicting bindings', () => {
  const review: HookPostAction = { id: 'review', type: 'review_completion', position: 0, config: {} };
  const fields = getClaudeOutputFields('Stop', [review]).map((field) => field.path);
  assert.deepEqual(fields, ['suppressOutput', 'systemMessage']);

  const bindings = {
    continue: { source: 'literal' as const, value: false },
    stopReason: { source: 'literal' as const, value: 'custom' },
    decision: { source: 'literal' as const, value: 'block' },
    reason: { source: 'literal' as const, value: 'custom' },
    systemMessage: { source: 'literal' as const, value: 'keep' },
  };
  assert.deepEqual(retainReviewCompatibleClaudeBindings(bindings, [review]), {
    systemMessage: bindings.systemMessage,
  });
  assert.equal(retainReviewCompatibleClaudeBindings(bindings, []), bindings);
  assert.equal(Object.keys(bindings).length, 5);
});

test('each SDK event template exposes every callback field once', () => {
  for (const event of EVENT_DEFINITIONS) {
    const keys = event.fields.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, `${event.name} contains duplicate callback fields`);
  }
});

test('personal variables appear in references and are copied without sharing definitions', () => {
  const userVariables = [{ name: 'personal_token', label: '个人 Token', description: '', required: true, secret: true }];
  const configured = { ...draft, userVariables };
  assert.ok(buildReferenceChoices(configured, resources).some((field) => field.path === 'ccui.env.userVariables.personal_token'));
  const copy = createHookCopyDraft(configured as HookConfig, '副本');
  assert.deepEqual(copy.userVariables, userVariables);
  copy.userVariables![0].name = 'changed';
  assert.equal(userVariables[0].name, 'personal_token');
});
