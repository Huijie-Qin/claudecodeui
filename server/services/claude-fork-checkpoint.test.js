import assert from 'node:assert/strict';
import test from 'node:test';

import { collectClaudeForkCheckpoints, createClaudeCompletedReplyTracker } from './claude-fork-checkpoint.js';

const reply = (uuid, stop_reason = 'end_turn', content = [{ type: 'text', text: 'Answer' }]) => ({
  type: 'assistant', uuid, message: { role: 'assistant', stop_reason, content },
});

test('fork checkpoints require a complete main-thread reply and paired tools', () => {
  const entries = [
    reply('first'),
    reply('preamble', 'tool_use', [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: 't' }]),
    reply('premature'),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } },
    reply('finished'),
    { ...reply('subagent'), isSidechain: true },
    { ...reply('error'), isApiErrorMessage: true },
    reply('truncated', 'max_tokens'),
  ];
  assert.deepEqual([...collectClaudeForkCheckpoints(entries)], ['first', 'finished']);
});

test('missing stop reason requires persisted completion evidence', () => {
  const entries = [reply('old-cli', null)];
  assert.deepEqual([...collectClaudeForkCheckpoints(entries)], []);
  assert.deepEqual([...collectClaudeForkCheckpoints(entries, { sessionCompleted: true })], []);
  assert.deepEqual([...collectClaudeForkCheckpoints(entries, { completedReplyUuids: new Set(['old-cli']) })], ['old-cli']);
  assert.deepEqual([...collectClaudeForkCheckpoints([...entries, { type: 'system', subtype: 'turn_duration' }])], ['old-cli']);
  assert.deepEqual([...collectClaudeForkCheckpoints([...entries, { type: 'result', subtype: 'error' }], { sessionCompleted: true })], []);
});

test('completion markers establish each historical null-stop turn independently', () => {
  const entries = [reply('first', null), { type: 'user', message: { content: 'again' } }, reply('last', null)];
  assert.deepEqual([...collectClaudeForkCheckpoints(entries, { completedReplyUuids: new Set(['first', 'last']) })], ['first', 'last']);
  assert.deepEqual([...collectClaudeForkCheckpoints(entries, { completedReplyUuids: new Set(['missing', 'first']) })], ['first']);
  assert.deepEqual([...collectClaudeForkCheckpoints([
    reply('pending', 'tool_use', [{ type: 'tool_use', id: 'tool' }]), reply('last', null),
  ], { completedReplyUuids: new Set(['last']) })], []);
});

test('a logical assistant reply branches only after its last content block', () => {
  const entries = ['first-block', 'last-block'].map(uuid => {
    const entry = reply(uuid);
    entry.message.id = 'same-api-message';
    return entry;
  });
  assert.deepEqual([...collectClaudeForkCheckpoints(entries)], ['last-block']);
});

test('compaction keeps pending calls when their original message is preserved', () => {
  const tool = reply('tool-message', 'tool_use', [{ type: 'tool_use', id: 'tool-id' }]);
  const boundary = { type: 'system', uuid: 'compact', subtype: 'compact_boundary' };
  for (const compactMetadata of [
    { preservedMessages: { uuids: ['tool-message'] } },
    { preservedSegment: { headUuid: 'tool-message', tailUuid: 'tool-message' } },
    { preservedMessages: { uuids: ['missing'] } },
  ]) {
    assert.deepEqual([...collectClaudeForkCheckpoints([tool, { ...boundary, compactMetadata }, reply('after')])], []);
  }
  assert.deepEqual([...collectClaudeForkCheckpoints([tool, boundary, reply('after')])], ['after']);
});

test('error, interruption, and tool-result records cannot complete an old null-stop reply', () => {
  for (const trailing of [
    { type: 'system', subtype: 'error', level: 'error' },
    { type: 'system', subtype: 'interrupted' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown' }] } },
  ]) {
    assert.deepEqual([...collectClaudeForkCheckpoints([
      reply('partial', null), trailing, { type: 'system', subtype: 'turn_duration' },
    ], { sessionCompleted: true })], []);
  }
});

test('SDK completion tracking requires a successful explicit end_turn and a final parent text block', () => {
  const tracker = createClaudeCompletedReplyTracker();
  const success = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' };
  assert.equal(tracker.observe(reply('first', null)), null);
  tracker.observe({ ...reply('child'), parent_tool_use_id: 'agent' });
  assert.equal(tracker.observe(success), 'first');
  assert.equal(tracker.observe(success), null, 'An empty or repeated result must not reuse the previous reply');
  for (const overrides of [
    { is_error: true }, { subtype: 'error_max_turns' }, { stop_reason: null },
    { stop_reason: 'max_tokens' }, { stop_reason: 'tool_use' }, { stop_reason: 'tool_deferred' },
  ]) {
    tracker.observe(reply('partial', null));
    assert.equal(tracker.observe({ ...success, ...overrides }), null);
  }
  tracker.observe(reply('tool', null, [{ type: 'tool_use', id: 't' }]));
  assert.equal(tracker.observe(success), null);
  tracker.observe(reply('reply', null));
  tracker.observe({ type: 'user', message: { content: 'new input' } });
  assert.equal(tracker.observe(success), null);
});

test('an interrupted reply followed by a new prompt is not a completed checkpoint', () => {
  assert.deepEqual([...collectClaudeForkCheckpoints([
    reply('partial', null), { type: 'user', message: { content: 'try again' } }, reply('done'),
  ])], ['done']);
});
