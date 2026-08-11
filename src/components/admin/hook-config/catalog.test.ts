import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFieldChoices,
  buildScriptTemplate,
  inferScriptOutputs,
  isConcreteToolMatcher,
} from './catalog';
import type { HookConfigDraft, HookResources } from './types';

const resources: HookResources = {
  events: [],
  builtinTools: [],
  mcpTools: [],
  skills: [],
  environmentVariables: [],
};

test('script template documents read-only workspace access without predeclaring an output', () => {
  const template = buildScriptTemplate({
    eventName: 'Stop',
    eventLabel: '回答结束',
    eventDescription: '模型准备结束回答时',
    inputs: [],
  });

  assert.match(template, /workspace\.readText\('src\/index\.ts'\)/);
  assert.match(template, /@output-example sqlLineCount:number/);
  assert.deepEqual(inferScriptOutputs(template), []);
});

test('@output declarations become fields available to execution gates and basic actions', () => {
  const code = `/**\n * @output sqlLineCount:number SQL 有效行数\n */`;
  const outputs = inferScriptOutputs(code);
  const draft: HookConfigDraft = {
    name: 'SQL 分析',
    description: '',
    eventName: 'Stop',
    matcher: {},
    gate: { mode: 'all', conditions: [] },
    advancedScript: { enabled: true, language: 'javascript', code, outputs },
    actions: [],
  };

  assert.deepEqual(outputs, [{ name: 'sqlLineCount', type: 'number', description: 'SQL 有效行数' }]);
  assert.ok(buildFieldChoices(draft, resources).some((field) => (
    field.path === '$script.output.sqlLineCount'
    && field.type === 'number'
    && field.group === 'script'
  )));
});

test('only an exact concrete tool matcher exposes schema-dependent input editing', () => {
  assert.equal(isConcreteToolMatcher('Bash', 'exact'), true);
  assert.equal(isConcreteToolMatcher('Bash|Write', 'regex'), false);
  assert.equal(isConcreteToolMatcher('*', 'exact'), false);
});
