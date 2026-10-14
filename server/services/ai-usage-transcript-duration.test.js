import assert from 'node:assert/strict';
import test from 'node:test';

import { createTranscriptDurationTracker, transcriptTurnRows } from './ai-usage-transcript-duration.js';

const scope = { tenant_id: 1, workspace_id: 10, user_id: 7, provider: 'claude', provider_session_id: 'session-a' };
const timeZone = 'Asia/Shanghai';
const at = seconds => new Date(Date.parse('2026-09-11T02:00:00.000Z') + seconds * 1000).toISOString();
const user = (uuid, seconds, content = 'A real request') => ({ type: 'user', uuid, timestamp: at(seconds),
  message: { role: 'user', content } });
const reply = (uuid, seconds, stopReason = 'end_turn', content = [{ type: 'text', text: 'A generated answer' }]) => ({
  type: 'assistant', uuid, timestamp: at(seconds), message: { id: `api-${uuid}`, role: 'assistant', stop_reason: stopReason, content },
});
const tool = (id, seconds) => reply(`tool-${id}`, seconds, 'tool_use', [{ type: 'tool_use', id, name: 'Read', input: { path: '/private/source' } }]);
const result = (id, seconds) => user(`result-${id}`, seconds, [{ type: 'tool_result', tool_use_id: id, content: 'Tool result' }]);
function fixture(options = {}, identity = scope) {
  const emitted = [], anomalies = [], turns = new Map();
  const zone = options.timeZone || timeZone;
  const tracker = createTranscriptDurationTracker(identity, { timeZone: zone,
    onTurn: turn => { emitted.push(turn); turns.set(turn.turnKey, turn); }, onAnomaly: item => anomalies.push(item), ...options });
  const rows = () => [...turns.values()].flatMap(turn => transcriptTurnRows(identity, turn, zone));
  const milliseconds = () => rows().reduce((sum, row) => sum + (row.value.durationMs || 0), 0);
  return { tracker, emitted, anomalies, turns, rows, milliseconds,
    observe: (...entries) => entries.forEach(entry => tracker.observe(entry)) };
}

test('successful request intervals use original file timestamps and exclude idle time between turns', () => {
  const f = fixture();
  f.observe(user('first', 0), reply('first-answer', 10), user('second', 3600), reply('second-answer', 3620));
  f.tracker.flush();
  assert.equal(f.milliseconds(), 30000);
  assert.equal(f.turns.size, 2);
  assert.deepEqual(f.emitted.map(turn => turn.status), ['completed', 'completed']);
  assert.equal(f.emitted[0].source, 'native_transcript');
  assert.equal(f.emitted[0].completionEvidence, 'end_turn');
  assert.deepEqual(f.anomalies, []);
});

test('completed file turns split exactly at local midnight without changing their full source interval', () => {
  const f = fixture();
  f.observe({ ...user('cross-day', 0), timestamp: '2026-09-11T15:59:50.000Z' },
    { ...reply('answer', 1), timestamp: '2026-09-11T16:00:10.000Z' });
  f.tracker.flush();
  const rows = f.rows();
  assert.deepEqual(rows.map(row => [row.stat_date, row.value.durationMs]), [['2026-09-11', 10000], ['2026-09-12', 10000]]);
  assert.ok(rows.every(row => row.value.requestStartedAt === '2026-09-11T15:59:50.000Z'
    && row.value.responseCompletedAt === '2026-09-11T16:00:10.000Z'));
  assert.ok(rows.every(row => row.session_key === JSON.stringify([1, 10, 7, 'claude', 'session-a'])));
});

test('a successful zero-duration turn remains a completed zero rather than disappearing', () => {
  const f = fixture();
  f.observe(user('zero', 0), reply('zero-answer', 0));
  f.tracker.flush();
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].value.durationMs, 0);
  assert.equal(f.rows()[0].value.status, 'completed');
});

test('missing completion evidence never turns the last assistant timestamp into a successful duration', () => {
  const f = fixture();
  f.observe(user('first', 0), reply('partial', 10, null), user('second', 100), reply('second-final', 120));
  f.tracker.flush();
  assert.equal(f.emitted[0].status, 'incomplete');
  assert.equal(f.emitted[0].responseCompletedAt, null);
  assert.equal(f.rows()[0].value.durationMs, null);
  assert.equal(f.milliseconds(), 20000);
});

for (const [name, marker, expected] of [
  ['turn_duration', { type: 'system', subtype: 'turn_duration', timestamp: at(3600), durationMs: 9999999 }, 'turn_duration'],
  ['successful result', { type: 'result', subtype: 'success', is_error: false, timestamp: at(3600) }, 'result'],
]) {
  test(`${name} confirms the last assistant time without adding marker latency`, () => {
    const f = fixture();
    f.observe(user('request', 0), reply('old-cli-answer', 10, null), marker);
    f.tracker.flush();
    assert.equal(f.milliseconds(), 10000);
    assert.equal(f.emitted[0].responseCompletedAt, at(10));
    assert.equal(f.emitted[0].completionEvidence, expected);
  });
}

test('a persisted reply UUID can complete a null-stop reply, including after an earlier flush', () => {
  const markers = new Set();
  const f = fixture({ completedReplyUuids: markers });
  f.observe(user('request', 0), reply('saved-answer', 10, null));
  f.tracker.flush();
  assert.equal(f.emitted[0].status, 'incomplete');
  markers.add('saved-answer');
  f.tracker.flush();
  assert.equal(f.emitted[1].turnKey, f.emitted[0].turnKey);
  assert.equal(f.emitted[1].completionEvidence, 'completed_reply');
  assert.equal(f.milliseconds(), 10000);
});

test('tool execution and its result remain within one main request interval', () => {
  const f = fixture();
  f.observe(user('request', 0), tool('read', 5), result('read', 20), reply('answer', 30));
  f.tracker.flush();
  assert.equal(f.turns.size, 1);
  assert.equal(f.milliseconds(), 30000);
});

test('unresolved tools and a later tool result cannot make a premature answer complete', () => {
  const f = fixture();
  f.observe(user('request', 0), tool('read', 5), reply('premature', 10),
    { type: 'system', subtype: 'turn_duration' });
  f.tracker.flush();
  assert.equal(f.emitted.at(-1).status, 'incomplete');
  f.observe(result('read', 20), { type: 'system', subtype: 'turn_duration' });
  f.tracker.flush();
  assert.equal(f.milliseconds(), 0);
  f.observe(reply('real-final', 30));
  f.tracker.flush();
  assert.equal(f.milliseconds(), 30000);
});

test('main replies replace earlier completion candidates instead of counting every assistant block', () => {
  const f = fixture();
  f.observe(user('request', 0), reply('first-block', 10));
  f.tracker.flush();
  f.observe({ ...reply('last-block', 20), message: { ...reply('last-block', 20).message, id: 'api-first-block' } });
  f.tracker.flush();
  assert.equal(f.turns.size, 1);
  assert.equal(f.emitted[0].turnKey, f.emitted[1].turnKey);
  assert.equal(f.milliseconds(), 20000);
});

test('sidechains, parent tool messages, and inherited fork copies cannot start or extend main turns', () => {
  const f = fixture();
  f.observe({ ...user('copied', -100), forkedFrom: { sessionId: 'parent', messageUuid: 'old' } },
    { ...reply('copied-answer', -50), inherited: true },
    user('own', 0),
    { ...user('child-prompt', 1), isSidechain: true },
    { ...reply('child-answer', 100), parent_tool_use_id: 'agent' },
    { ...reply('nested-child', 110), message: { ...reply('nested-child', 110).message, is_sidechain: true } },
    { ...reply('copied-late', 120), message: { ...reply('copied-late', 120).message, inherited: true } },
    reply('main-answer', 10));
  f.tracker.flush();
  assert.equal(f.turns.size, 1);
  assert.equal(f.milliseconds(), 10000);
  assert.deepEqual(f.anomalies, []);
});

test('metadata and MCP continuations do not create a new user request or reset its start', () => {
  const f = fixture();
  f.observe(user('request', 0), { ...user('expanded', 5, 'Base directory for this skill: /secret'), isMeta: true },
    user('mcp-result', 8, ' <ccui-mcp-loop-results>finished</ccui-mcp-loop-results>'),
    { ...reply('metadata', 500), isMeta: true }, reply('answer', 10));
  f.tracker.flush();
  assert.equal(f.turns.size, 1);
  assert.equal(f.milliseconds(), 10000);
});

for (const isMeta of [false, true]) {
  test(`MCP continuation at EOF retracts completion and resumes the same request (meta=${isMeta})`, () => {
    const markers = new Set(['initial-answer']);
    const first = fixture({ completedReplyUuids: markers });
    first.observe(user('request', 0), reply('initial-answer', 10));
    first.tracker.flush();
    const completed = first.emitted.at(-1);
    assert.equal(completed.status, 'completed');
    first.observe({ ...user('mcp-result', 20, '<ccui-mcp-loop-results>PRIVATE_RESULT</ccui-mcp-loop-results>'), isMeta });
    first.tracker.flush();
    const withdrawn = first.emitted.at(-1);
    assert.equal(withdrawn.turnKey, completed.turnKey);
    assert.equal(withdrawn.status, 'incomplete');
    assert.equal(withdrawn.responseCompletedAt, null);
    assert.equal(withdrawn.completionEvidence, null);
    assert.equal(first.milliseconds(), 0);
    const state = JSON.parse(JSON.stringify(first.tracker.snapshot()));
    assert.equal(state.current.awaitingAssistant, true);
    assert.equal(JSON.stringify(state).includes('PRIVATE_RESULT'), false);
    const resumed = fixture({ state, completedReplyUuids: markers });
    resumed.tracker.flush();
    assert.equal(resumed.emitted.length, 0, 'the old sidecar cannot complete a request awaiting continuation');
    resumed.observe(reply('continued-answer', 30));
    resumed.tracker.flush();
    assert.equal(resumed.emitted.at(-1).turnKey, completed.turnKey);
    assert.equal(resumed.emitted.at(-1).status, 'completed');
    assert.equal(resumed.milliseconds(), 30000);
  });
}

test('Hook recovery closes the user turn and its subsequent assistant work is not added', () => {
  const f = fixture();
  f.observe(user('request', 0), reply('answer', 10),
    user('hook', 11, ' <ccui-hook-recovery>internal work</ccui-hook-recovery>'), reply('hook-answer', 100));
  f.tracker.flush();
  assert.equal(f.turns.size, 1);
  assert.equal(f.milliseconds(), 10000);
});

for (const [label, error, status] of [
  ['API error', { ...reply('api-error', 5), isApiErrorMessage: true }, 'failed'],
  ['failed result', { type: 'result', subtype: 'error_during_execution', is_error: true }, 'failed'],
  ['interruption', { type: 'system', subtype: 'interrupted' }, 'cancelled'],
  ['cancellation message', user('cancel', 5, '[Request interrupted by user]'), 'cancelled'],
]) {
  test(`${label} only discards the current round, preserving successful neighboring requests`, () => {
    const f = fixture();
    f.observe(user('before', 0), reply('before-answer', 10), user('bad', 20), reply('partial', 22, null), error,
      reply('stray-after-error', 25), user('after', 30), reply('after-answer', 40));
    f.tracker.flush();
    assert.equal(f.milliseconds(), 20000);
    assert.deepEqual([...f.turns.values()].map(turn => turn.status), ['completed', status, 'completed']);
    assert.equal(f.anomalies.length, 1);
  });
}

test('bad assistant timestamps retract a current completion and allow the next request to succeed', () => {
  const f = fixture();
  f.observe(user('bad', 0), reply('initial', 10));
  f.tracker.flush();
  f.observe({ ...reply('bad-time', 11), timestamp: 'not-a-time' }, user('good', 20), reply('good-answer', 25));
  f.tracker.flush();
  assert.equal(f.emitted[1].turnKey, f.emitted[0].turnKey);
  assert.equal(f.emitted[1].status, 'incomplete');
  assert.equal(f.milliseconds(), 5000);
  assert.equal(f.anomalies[0].reason, 'invalid_assistant_timestamp');
});

test('bad user identities and timestamps break attribution instead of attaching later output to the previous user', () => {
  const f = fixture();
  f.observe(user('good', 0), reply('good-answer', 5),
    { ...user('missing-time', 10), timestamp: null }, reply('unowned', 20),
    { ...user('missing-id', 30), uuid: null }, reply('still-unowned', 40),
    user('next-good', 50), reply('next-answer', 55));
  f.tracker.flush();
  assert.equal(f.turns.size, 2);
  assert.equal(f.milliseconds(), 10000);
  assert.deepEqual(f.anomalies.map(item => item.reason), ['invalid_request_timestamp', 'missing_request_identity']);
});

test('snapshots resume an unfinished round and repeated flushes emit only changed stable-key facts', () => {
  const first = fixture();
  first.observe(user('request', 0), reply('candidate', 10, null));
  first.tracker.flush();
  first.tracker.flush();
  assert.equal(first.emitted.length, 1);
  const state = JSON.parse(JSON.stringify(first.tracker.snapshot()));
  const resumed = fixture({ state });
  resumed.tracker.flush();
  assert.equal(resumed.emitted.length, 0);
  resumed.observe({ type: 'system', subtype: 'turn_duration', timestamp: at(100) });
  resumed.tracker.flush();
  resumed.tracker.flush();
  assert.equal(resumed.emitted.length, 1);
  assert.equal(resumed.emitted[0].turnKey, first.emitted[0].turnKey);
  assert.equal(resumed.milliseconds(), 10000);
});

test('invalidating malformed file input retracts only the current stable-key turn', () => {
  const f = fixture();
  f.observe(user('first', 0), reply('first-answer', 10), user('second', 20), reply('second-answer', 30));
  f.tracker.flush();
  const priorKey = f.emitted.at(-1).turnKey;
  f.tracker.invalidate('malformed_jsonl');
  f.observe(reply('stray', 40), user('third', 50), reply('third-answer', 60));
  f.tracker.flush();
  assert.equal(f.turns.get(priorKey).status, 'incomplete');
  assert.equal(f.milliseconds(), 20000);
  assert.equal(f.anomalies[0].turnKey, priorKey);
  assert.equal(f.anomalies[0].reason, 'malformed_jsonl');
});

test('snapshot state is bounded and contains no request, generated text, tool input, or result bodies', () => {
  const f = fixture();
  f.observe(user('request', 0, 'PRIVATE_REQUEST'.repeat(10000)), tool('read', 5), result('read', 10),
    reply('answer', 20, null, [{ type: 'text', text: 'PRIVATE_ANSWER'.repeat(10000) }]));
  const serialized = JSON.stringify(f.tracker.snapshot());
  assert.ok(serialized.length < 1200);
  for (const secret of ['PRIVATE_REQUEST', 'PRIVATE_ANSWER', '/private/source', 'Tool result']) assert.ok(!serialized.includes(secret));
  const snapshot = f.tracker.snapshot();
  snapshot.current.pendingToolIds.push('external-mutation');
  assert.deepEqual(f.tracker.snapshot().current.pendingToolIds, []);
});

test('too many pending tool identities abort only the current turn with bounded state', () => {
  const f = fixture();
  f.observe(user('request', 0), reply('many-tools', 1, 'tool_use', Array.from({ length: 129 }, (_, index) => ({ type: 'tool_use', id: `tool-${index}` }))));
  assert.equal(f.anomalies[0].reason, 'too_many_pending_tools');
  assert.equal(f.tracker.snapshot().current, null);
  f.observe(user('next', 10), reply('done', 20));
  f.tracker.flush();
  assert.equal(f.milliseconds(), 10000);
});

test('turn keys use all five scope dimensions and do not depend on assistant UUIDs', () => {
  const keys = [];
  for (const identity of [scope, { ...scope, tenant_id: 2 }, { ...scope, workspace_id: 20 },
    { ...scope, user_id: 8 }, { ...scope, provider: 'codex' }, { ...scope, provider_session_id: 'session-b' }]) {
    const f = fixture({}, identity);
    f.observe(user('same-user-id', 0), reply('answer', 10));
    f.tracker.flush();
    keys.push(f.emitted[0].turnKey);
  }
  assert.equal(new Set(keys).size, 6);
  assert.ok(keys.every(key => /^history:[a-f0-9]{64}$/.test(key)));
});

test('state from another session cannot attach a main reply to the wrong request', () => {
  const first = fixture();
  first.observe(user('request', 0));
  const other = fixture({ state: first.tracker.snapshot() }, { ...scope, provider_session_id: 'other' });
  other.observe(reply('wrong-scope', 10));
  other.tracker.flush();
  assert.equal(other.turns.size, 0);
});

test('system and callback errors are not swallowed as malformed business records', () => {
  const error = new Error('database is locked');
  const f = fixture({ onTurn: () => { throw error; } });
  f.observe(user('request', 0), reply('answer', 10));
  assert.throws(() => f.tracker.flush(), candidate => candidate === error);
  const broken = fixture({ onAnomaly: () => { throw error; } });
  assert.throws(() => broken.tracker.invalidate('bad-line'), candidate => candidate === error);
});

test('invalid intervals cannot produce negative or fabricated standard duration rows', () => {
  const base = { turnKey: 'history:fixture', status: 'completed', requestStartedAt: at(10), responseCompletedAt: at(0) };
  assert.throws(() => transcriptTurnRows(scope, base, timeZone), /AI_USAGE_INVALID_DURATION_INTERVAL/);
  assert.throws(() => transcriptTurnRows(scope, { ...base, requestStartedAt: null }, timeZone), /AI_USAGE_INVALID_DURATION_INTERVAL/);
});

for (const invalid of ['0001-01-01T00:00:00.000Z', '9999-12-31T00:00:00.000Z', '+010000-01-01T00:00:00.000Z']) {
  test(`unrepresentable calendar request ${invalid} preserves healthy neighboring turns`, () => {
    const f = fixture();
    f.observe(user('before', 0), reply('before-answer', 10),
      { ...user('bad', 20), timestamp: invalid }, reply('unowned', 25),
      user('after', 30), reply('after-answer', 40));
    f.tracker.flush();
    assert.equal(f.milliseconds(), 20000);
    assert.equal(f.turns.size, 2);
    assert.deepEqual(f.anomalies.map(item => item.reason), ['invalid_request_timestamp']);
    assert.ok(f.rows().every(row => row.value.status === 'completed'));
  });
}

test('unrepresentable assistant calendar retracts a flushed completion without affecting the following turn', () => {
  const f = fixture();
  f.observe(user('request', 0), reply('initial-answer', 10));
  f.tracker.flush();
  const key = f.emitted[0].turnKey;
  f.observe({ ...reply('invalid-answer', 20), timestamp: '+010000-01-01T00:00:00.000Z' },
    user('next', 30), reply('next-answer', 40));
  f.tracker.flush();
  assert.equal(f.turns.get(key).status, 'incomplete');
  assert.equal(f.milliseconds(), 10000);
  assert.deepEqual(f.anomalies.map(item => item.reason), ['invalid_assistant_timestamp']);
});

test('a timezone skipping an entire date only excludes the affected turn and every output remains convertible', () => {
  const zone = 'Pacific/Apia';
  const f = fixture({ timeZone: zone });
  const localUser = (id, timestamp) => ({ ...user(id, 0), timestamp });
  const localReply = (id, timestamp) => ({ ...reply(id, 0), timestamp });
  f.observe(localUser('before', '2011-12-28T12:00:00.000Z'), localReply('before-answer', '2011-12-28T12:00:10.000Z'),
    localUser('date-skip', '2011-12-29T22:00:00.000Z'), localReply('date-skip-answer', '2011-12-30T12:00:00.000Z'),
    localUser('after', '2011-12-31T12:00:00.000Z'), localReply('after-answer', '2011-12-31T12:00:10.000Z'));
  f.tracker.flush();
  assert.deepEqual(f.emitted.map(turn => turn.status), ['completed', 'incomplete', 'completed']);
  assert.equal(f.milliseconds(), 20000);
  assert.deepEqual(f.anomalies.map(item => item.reason), ['AI_USAGE_INVALID_DURATION_CALENDAR']);
  assert.equal(f.rows().find(row => row.value.status === 'incomplete').value.durationMs, null);
});

test('a late append across a skipped calendar day retracts a completion once and survives restart', () => {
  const zone = 'Pacific/Apia';
  const markers = new Set(['late-answer']);
  const f = fixture({ timeZone: zone, completedReplyUuids: markers });
  f.observe({ ...user('request', 0), timestamp: '2011-12-28T12:00:00.000Z' },
    { ...reply('first-answer', 0), timestamp: '2011-12-28T12:00:10.000Z' });
  f.tracker.flush();
  assert.equal(f.milliseconds(), 10000);
  f.observe({ ...reply('late-answer', 0), timestamp: '2011-12-30T12:00:00.000Z' });
  f.tracker.flush();
  f.tracker.flush();
  assert.equal(f.emitted.length, 2);
  assert.equal(f.emitted[1].turnKey, f.emitted[0].turnKey);
  assert.equal(f.emitted[1].status, 'incomplete');
  assert.equal(f.milliseconds(), 0);
  assert.equal(f.anomalies.length, 1);
  const resumed = fixture({ timeZone: zone, completedReplyUuids: markers, state: JSON.parse(JSON.stringify(f.tracker.snapshot())) });
  resumed.tracker.flush();
  assert.equal(resumed.emitted.length, 0);
  assert.equal(resumed.anomalies.length, 0);
});

test('valid modern long request intervals are retained without a duration cap', () => {
  const f = fixture();
  f.observe({ ...user('long', 0), timestamp: '2026-01-01T00:00:00.000Z' },
    { ...reply('long-answer', 0), timestamp: '2026-04-01T00:00:00.000Z' });
  f.tracker.flush();
  assert.equal(f.milliseconds(), 90 * 86400000);
  assert.equal(f.anomalies.length, 0);
});

test('row conversion classifies calendar boundaries without swallowing callback or timezone configuration errors', () => {
  const turn = { turnKey: 'history:calendar', status: 'completed', requestStartedAt: '2011-12-29T22:00:00.000Z',
    responseCompletedAt: '2011-12-30T12:00:00.000Z' };
  assert.throws(() => transcriptTurnRows(scope, turn, 'Pacific/Apia'), error => error.code === 'AI_USAGE_INVALID_DURATION_CALENDAR');
  assert.throws(() => transcriptTurnRows(scope, turn, 'Invalid/Zone'), /Invalid time zone/);
  const failure = new RangeError('Invalid time value');
  const callback = fixture({ onTurn: () => { throw failure; } });
  callback.observe(user('request', 0), reply('answer', 10));
  assert.throws(() => callback.tracker.flush(), error => error === failure);
  const diagnostic = fixture({ timeZone: 'Pacific/Apia', onAnomaly: () => { throw failure; } });
  diagnostic.observe({ ...user('request', 0), timestamp: turn.requestStartedAt },
    { ...reply('answer', 0), timestamp: turn.responseCompletedAt });
  assert.throws(() => diagnostic.tracker.flush(), error => error === failure);
});
