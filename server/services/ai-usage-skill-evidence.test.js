import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSkillEvidence, reconcileSkillEvidence } from './ai-usage-skill-evidence.js';

const scope = { tenant_id: 1, user_id: 2, workspace_id: 3, provider: 'claude', provider_session_id: 'session-1' };
const start = '2026-09-10T23:59:00.000Z';
const later = '2026-09-11T00:01:00.000Z';
const options = { timeZone: 'UTC' };
const user = (id, content, extra = {}) => ({ type: 'user', uuid: id, timestamp: start,
  message: { role: 'user', content }, ...extra });
const tool = (id, name = 'report', extra = {}) => ({ type: 'assistant', timestamp: later,
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', id,
    input: { skill: name, args: 'PRIVATE ARGUMENTS' } }] }, ...extra });
const binding = (extra = {}) => ({ tenant_id: 1, workspace_id: 3, local_name: 'report',
  remote_skill_id: 'remote-report', valid_from: '2026-01-01T00:00:00Z', valid_to: null, ...extra });
const context = (kind, id, extra = {}) => ({ tenant_id: 1, user_id: 2, workspace_id: 3,
  provider: 'claude', session_id: 'session-1', context_kind: kind, context_id: id,
  request_id: kind === 'request' ? id : null, origin: 'user', skill_name: 'report',
  occurred_at: kind === 'tool' ? later : start, updated_at: later, ...extra });
const collect = (message, extra = {}) => collectSkillEvidence(scope, message, { ...options, ...extra });
const reconcile = (evidence, extra = {}) => reconcileSkillEvidence({ evidence, ...options, ...extra });
const slash = (id = 'request-1', extra = {}) => collect(user(id, '/report PRIVATE ARGUMENTS'), extra);

test('collector keeps only leading slash candidates and no bodies, paths or arguments', () => {
  const state = {};
  const facts = collect(user('request-1', ' /plugin:report PRIVATE ARGUMENTS\nPRIVATE BODY'), { state });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].dataset, 'skill_evidence');
  assert.equal(facts[0].value.skillName, 'plugin:report');
  assert.deepEqual(state, { requestId: 'request-1', origin: 'user' });
  assert.equal(JSON.stringify(facts).includes('PRIVATE'), false);
  for (const text of ['please /report', '/folder/SKILL.md', 'Read SKILL.md', 'Bash cat SKILL.md']) {
    assert.deepEqual(collect(user('request-2', text)), []);
  }
  assert.equal(collect(user('request-3', '<command-name>/report</command-name>\n<command-args>PRIVATE</command-args>'))[0].value.skillName, 'report');
  assert.equal(collect(user('request-4', '<command-message>report</command-message>\n<command-name>/report</command-name>'))[0].value.skillName, 'report');
  assert.deepEqual(collect(user('request-5', 'quoted <command-name>/report</command-name>')), []);
});

test('ordinary commands are unproven candidates; effective bindings validate only the correct name/scope/time', () => {
  const facts = slash();
  assert.deepEqual(reconcile(facts), []);
  assert.deepEqual(reconcile(collect(user('help', '/help')), { bindings: [binding()] }), []);
  assert.equal(reconcile(facts, { bindings: [binding()] }).length, 1);
  for (const bad of [{ local_name: 'another' }, { tenant_id: 9 }, { workspace_id: 9 },
    { valid_from: later }, { valid_to: start }, { valid_from: null }, { remote_skill_id: null }]) {
    assert.deepEqual(reconcile(facts, { bindings: [binding(bad)] }), []);
  }
});

test('native Skill tools count attempts independently of tool results; Read and Bash never count', () => {
  const state = {};
  const facts = [...collect(user('req', 'perform report'), { state }), ...collect(tool('tool-1'), { state })];
  assert.equal(facts.length, 1);
  assert.equal(facts[0].value.requestId, 'req');
  assert.equal(facts[0].value.origin, 'user');
  assert.equal(reconcile(facts).length, 1);
  assert.equal(JSON.stringify(facts).includes('PRIVATE'), false);
  assert.equal(collect({ kind: 'tool_use', timestamp: start, toolName: 'Skill', toolId: 'normalized',
    toolInput: { skill: 'report' } }).length, 1);
  for (const name of ['Read', 'Bash', 'Skilltool', 'skill']) {
    assert.deepEqual(collect({ kind: 'tool_use', timestamp: start, toolName: name,
      toolId: 'no', toolInput: { skill: 'report' } }), []);
  }
});

test('SDK metadata expansion corroborates local Skills without persisting directory/body', () => {
  const state = {};
  const facts = slash('req', { state });
  facts.push(...collect(user('expanded', 'Base directory for this skill: /PRIVATE/HOME/skills/report\nPRIVATE BODY',
    { isMeta: true }), { state }));
  assert.equal(facts[1].value.kind, 'expansion');
  assert.equal(facts[1].value.skillName, 'report');
  assert.equal(JSON.stringify(facts).includes('PRIVATE'), false);
  assert.equal(reconcile(facts).length, 1);
  assert.deepEqual(reconcile([facts[1]]), []);
  const fake = collect(user('fake', 'Base directory for this skill: /skills/report\nBODY'), { state });
  assert.deepEqual(fake, []);
  assert.deepEqual(reconcile([...slash('other'), facts[1]]), []);
  assert.deepEqual(reconcile([...slash('req'), { ...facts[1], value: { ...facts[1].value, subagentId: 'child' } }]), []);
});

test('Hook wrappers mark later tools excluded; MCP continuation keeps its existing request', () => {
  const state = {};
  const facts = slash('req', { state });
  collect(user('mcp', '<ccui-mcp-loop-results count="1">/report PRIVATE</ccui-mcp-loop-results>'), { state });
  assert.deepEqual(state, { requestId: 'req', origin: 'user' });
  facts.push(...collect(tool('user-tool'), { state }));
  collect(user('hook', '<ccui-hook-recovery>PRIVATE</ccui-hook-recovery>'), { state });
  assert.deepEqual(state, { requestId: 'hook', origin: 'hook' });
  facts.push(...collect(tool('hook-tool'), { state }));
  collect(user('mcp-hook', '<ccui-mcp-loop-results>PRIVATE</ccui-mcp-loop-results>'), { state });
  assert.deepEqual(state, { requestId: 'hook', origin: 'hook' });
  assert.deepEqual(reconcile(facts).map((row) => row.value.toolUseId), ['user-tool']);
});

test('optional database boundaries retain only real request identities/sources and are not invocations', () => {
  const normal = collect(user('normal', 'PRIVATE BODY'), { includeBoundaries: true });
  const hooked = collect(user('hook', '<ccui-hook-recovery>PRIVATE BODY</ccui-hook-recovery>'), { includeBoundaries: true });
  assert.equal(normal[0].value.kind, 'boundary');
  assert.equal(normal[0].value.requestId, 'normal');
  assert.equal(normal[0].value.origin, 'user');
  assert.equal(hooked[0].value.kind, 'boundary');
  assert.equal(hooked[0].value.origin, 'hook');
  assert.equal(JSON.stringify([...normal, ...hooked]).includes('PRIVATE'), false);
  assert.deepEqual(reconcile([...normal, ...hooked]), []);
  assert.equal(collect(user('slash', '/report'), { includeBoundaries: true }).length, 2);
  for (const message of [user('meta', '/report', { isMeta: true }),
    user('mcp', '<ccui-mcp-loop-results>PRIVATE</ccui-mcp-loop-results>'),
    user('timeless', 'PRIVATE', { timestamp: undefined }),
    user('timeless-hook', '<ccui-hook-recovery>PRIVATE</ccui-hook-recovery>', { timestamp: undefined }),
    user(null, 'PRIVATE')]) {
    assert.deepEqual(collect(message, { includeBoundaries: true }), []);
  }
});

test('metadata, tool results, and child agent prompts never become human slash requests', () => {
  const state = { requestId: 'original', origin: 'user' };
  for (const message of [user('meta', '/report', { isMeta: true }), user('result', [
    { type: 'tool_result', tool_use_id: 'tool', content: '/report' },
  ]), user('child-prompt', '/report', { parent_tool_use_id: 'agent-tool' })]) {
    assert.deepEqual(collect(message, { state }), []);
  }
  assert.deepEqual(collect(user('child', '/report'), { state: {}, subagentId: 'child' }), []);
  assert.deepEqual(state, { requestId: 'original', origin: 'user' });
});

test('real identities and timestamps are mandatory; stable fallbacks produce stable evidence keys', () => {
  assert.deepEqual(collect(user(null, '/report')), []);
  assert.deepEqual(collect(user('req', '/report', { timestamp: undefined })), []);
  assert.deepEqual(collect(tool(null)), []);
  const raw = { type: 'user', message: { content: '/report' } };
  const first = collect(raw, { fallbackId: 'actual-db-id', fallbackTime: start });
  assert.equal(first.length, 1);
  assert.deepEqual(first, collect(raw, { fallbackId: 'actual-db-id', fallbackTime: start }));
  assert.equal(collect(tool('native-id', 'report', { uuid: undefined })).length, 1);
});

test('one slash and its first native Skill merge, but different tool IDs remain separate', () => {
  const state = {};
  const facts = slash('req', { state });
  const first = collect(tool('tool-1'), { state });
  const second = collect(tool('tool-2'), { state });
  const rows = reconcile([...facts, ...facts, ...first, ...first, ...second]);
  assert.deepEqual(rows.map((row) => row.value.toolUseId), ['tool-1', 'tool-2']);
  assert.equal(new Set(rows.map((row) => row.row_key)).size, 2);
});

test('late native tool replaces earlier slash key and uses its actual next-day timestamp', () => {
  const state = {};
  const facts = slash('req', { state });
  const before = reconcile(facts, { bindings: [binding()] });
  assert.equal(before[0].stat_date, '2026-09-10');
  const after = reconcile([...facts, ...collect(tool('late-tool'), { state })], { bindings: [binding()] });
  assert.equal(after.length, 1);
  assert.equal(after[0].stat_date, '2026-09-11');
  assert.notEqual(after[0].row_key, before[0].row_key);
});

test('same tool IDs in different branches count separately; slash never merges into another branch', () => {
  const state = { requestId: 'req', origin: 'user' };
  const facts = [...slash('req'), ...collect(tool('same'), { state, subagentId: 'a' }),
    ...collect(tool('same'), { state, subagentId: 'b' })];
  const rows = reconcile(facts, { bindings: [binding()] });
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.row_key)).size, 3);
});

test('trusted request sources override file state and remain tenant/session scoped', () => {
  const state = {};
  const facts = [...slash('req', { state }), ...collect(tool('native'), { state })];
  assert.deepEqual(reconcile(facts, { bindings: [binding()],
    contexts: [context('request', 'req', { origin: 'hook' })] }), []);
  for (const different of [{ tenant_id: 9 }, { user_id: 9 }, { workspace_id: 9 },
    { session_id: 'another' }, { provider: 'another' }]) {
    assert.equal(reconcile(facts, { contexts: [context('request', 'req', { origin: 'hook', ...different })] }).length, 1);
  }
});

test('trusted unknown tool/null request never borrows file ordering or a nearby user request', () => {
  const state = {};
  const facts = [...slash('req', { state }), ...collect(tool('native'), { state })];
  const rows = reconcile(facts, { bindings: [binding()], contexts: [
    context('request', 'req'), context('tool', 'native', { origin: 'unknown', request_id: null }),
  ] });
  assert.equal(rows.length, 2);
  const native = rows.find((row) => row.value.toolUseId);
  assert.equal(native.value.origin, 'unknown');
  assert.equal(native.value.requestId, null);
  const historical = reconcile(collect(tool('old')))[0];
  assert.equal(historical.value.origin, 'unknown');
  assert.equal(historical.value.requestId, null);
});

test('trusted tool context restores exact request link and supersedes untrusted file origin', () => {
  const facts = [...slash('req'), ...collect(tool('native'), { state: { requestId: 'wrong', origin: 'hook' } })];
  const rows = reconcile(facts, { contexts: [context('tool', 'native', { request_id: 'req' }), context('request', 'req')] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value.origin, 'user');
  assert.equal(rows[0].value.requestId, 'req');
});

test('trusted tool-only capture counts with no transcript and adopts a later raw child branch once', () => {
  const contexts = [context('tool', 'native', { origin: 'unknown' })];
  const before = reconcile([], { contexts });
  assert.equal(before.length, 1);
  assert.equal(before[0].value.subagentId, null);
  const after = reconcile(collect(tool('native'), { subagentId: 'child' }), { contexts });
  assert.equal(after.length, 1);
  assert.equal(after[0].value.subagentId, 'child');
  assert.notEqual(before[0].row_key, after[0].row_key);
});

test('trusted subagent IDs survive missing transcripts and never collapse a different known branch', () => {
  const contexts = [context('tool', 'native', { subagent_id: 'a', origin: 'unknown' })];
  assert.equal(reconcile([], { contexts })[0].value.subagentId, 'a');
  assert.equal(reconcile(collect(tool('native')), { contexts })[0].value.subagentId, 'a');
  const rows = reconcile([...collect(tool('native'), { subagentId: 'a' }),
    ...collect(tool('native'), { subagentId: 'b' })], { contexts });
  assert.deepEqual(rows.map((row) => row.value.subagentId).sort(), ['a', 'b']);
  const separate = reconcile(collect(tool('native'), { subagentId: 'b' }), { contexts });
  assert.equal(separate.length, 2);
  assert.equal(collect(tool('sdk', 'report', { agent_id: 'native-agent' }))[0].value.subagentId, 'native-agent');
});

test('request-only slash candidates require binding and do not make command text proof', () => {
  const contexts = [context('request', 'req')];
  assert.deepEqual(reconcile([], { contexts }), []);
  assert.equal(reconcile([], { contexts, bindings: [binding()] }).length, 1);
  assert.deepEqual(reconcile([], { contexts: [context('request', 'req', { skill_name: 'compact' })],
    bindings: [binding()] }), []);
  assert.deepEqual(reconcile([], { contexts: [context('request', 'req', { origin: 'hook' })],
    bindings: [binding()] }), []);
});

test('MCP request contexts canonicalize the same original submission without duplicate slash', () => {
  const facts = [...slash('req'), ...slash('resume')];
  const rows = reconcile(facts, { bindings: [binding()], contexts: [context('request', 'req'),
    context('request', 'resume', { request_id: 'req', skill_name: null })] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value.requestId, 'req');
  assert.deepEqual(reconcile(slash('resume'), { bindings: [binding()], contexts: [
    context('request', 'resume', { request_id: 'req', skill_name: null }),
  ] }), []);
});

test('untimestamped genuine requests still reset checkpoint identity instead of borrowing the old request', () => {
  const state = { requestId: 'old', origin: 'user' };
  assert.deepEqual(collect(user('new', '/report', { timestamp: undefined }), { state }), []);
  assert.deepEqual(state, { requestId: null, origin: 'unknown' });
  assert.equal(collect(tool('native'), { state })[0].value.requestId, null);
  collect(user('hook', '<ccui-hook-recovery>PRIVATE</ccui-hook-recovery>', { timestamp: undefined }), { state });
  assert.deepEqual(reconcile(collect(tool('hook-native'), { state })), []);
});

test('Hook, Agent Graph and Top Skill sources are excluded at request, tool and whole-session levels', () => {
  const state = {};
  const facts = [...slash('req', { state }), ...collect(tool('native'), { state })];
  for (const source of ['hook', 'agent_graph', 'top_skill']) {
    assert.deepEqual(reconcile(facts, { contexts: [context('request', 'req', { origin: source })], bindings: [binding()] }), []);
    assert.deepEqual(reconcile(collect(tool('native')), { contexts: [context('tool', 'native', { origin: source })] }), []);
    assert.deepEqual(reconcile(facts, { contexts: [context('session', 'run-1', { origin: source, occurred_at: later })],
      bindings: [binding()] }), []);
  }
});

test('subagent Hook source applies only to its branch at and after the injection timestamp', () => {
  const facts = [...collect(tool('before', 'report', { timestamp: start }), { subagentId: 'child' }),
    ...collect(tool('after'), { subagentId: 'child' }), ...collect(tool('unaffected'), { subagentId: 'sibling' }),
    ...collect(tool('main'))];
  const rows = reconcile(facts, { contexts: [context('session', 'subagent:child', { origin: 'hook', occurred_at: later })] });
  assert.deepEqual(rows.map((row) => row.value.toolUseId).sort(), ['before', 'main', 'unaffected']);
});

test('output preserves caller scope and never claims publisher attribution or stores unsafe context fields', () => {
  const rows = reconcile(slash('req'), { bindings: [binding({ publisher_user_id: 99, publisher_account_id: 'PRIVATE' })],
    contexts: [context('request', 'req', { prompt: 'PRIVATE', args: 'PRIVATE' })] });
  assert.equal(rows[0].user_id, scope.user_id);
  assert.equal(rows[0].value.callerUserId, scope.user_id);
  assert.equal(rows[0].subject_id, null);
  assert.equal(rows[0].value.publisherUserId, null);
  assert.equal(JSON.stringify(rows).includes('PRIVATE'), false);
});

test('malformed/mismatched scope facts and untimestamped contexts cannot generate invocations', () => {
  const native = collect(tool('native'))[0];
  assert.deepEqual(reconcile([{ ...native, tenant_id: 999 }, { ...native, session_key: 'not-json' },
    { ...native, occurred_at: null }]), []);
  assert.deepEqual(reconcile([], { contexts: [context('tool', 'native', { occurred_at: null }),
    context('request', 'req', { session_id: null })], bindings: [binding()] }), []);
});
