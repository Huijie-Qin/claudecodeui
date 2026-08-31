import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionStreamAccumulator } from './sessionStreamAccumulator';

test('session stream accumulator keeps interleaved streams isolated by session', () => {
  const accumulator = createSessionStreamAccumulator();

  assert.equal(accumulator.appendDelta('session-1', 'A1 '), 'A1 ');
  assert.equal(accumulator.appendDelta('session-2', 'B1 '), 'B1 ');
  assert.equal(accumulator.appendDelta('session-1', 'A2'), 'A1 A2');
  assert.equal(accumulator.appendDelta('session-2', 'B2'), 'B1 B2');

  assert.equal(accumulator.get('session-1'), 'A1 A2');
  assert.equal(accumulator.get('session-2'), 'B1 B2');
  assert.equal(accumulator.finish('session-1'), 'A1 A2');
  assert.equal(accumulator.get('session-1'), '');
  assert.equal(accumulator.get('session-2'), 'B1 B2');
});

test('clearing one session stream leaves other active streams intact', () => {
  const accumulator = createSessionStreamAccumulator();

  accumulator.appendDelta('session-1', 'first');
  accumulator.appendDelta('session-2', 'second');
  accumulator.clear('session-1');

  assert.equal(accumulator.get('session-1'), '');
  assert.equal(accumulator.get('session-2'), 'second');
});

test('finishing a stream segment lets later deltas start a new segment', () => {
  const accumulator = createSessionStreamAccumulator();

  accumulator.appendDelta('session-1', 'Before tool.', '2026-06-13T10:00:00.000Z');
  const firstSegment = accumulator.finishSnapshot('session-1');

  accumulator.appendDelta('session-1', 'After tool.', '2026-06-13T10:00:02.000Z');
  const secondSegment = accumulator.getSnapshot('session-1');

  assert.equal(firstSegment?.id, '__streaming_session-1_1');
  assert.equal(firstSegment?.content, 'Before tool.');
  assert.equal(firstSegment?.timestamp, '2026-06-13T10:00:00.000Z');
  assert.equal(secondSegment?.id, '__streaming_session-1_2');
  assert.equal(secondSegment?.content, 'After tool.');
  assert.equal(secondSegment?.timestamp, '2026-06-13T10:00:02.000Z');
});

test('draining snapshots preserves every buffered session before a lifecycle reset', () => {
  const accumulator = createSessionStreamAccumulator();

  accumulator.appendDelta('session-1', 'opening text', '2026-08-12T10:00:00.000Z');
  accumulator.appendDelta('session-2', 'background text', '2026-08-12T10:00:01.000Z');

  assert.deepEqual(accumulator.drainSnapshots(), [
    {
      id: '__streaming_session-1_1',
      sessionId: 'session-1',
      content: 'opening text',
      timestamp: '2026-08-12T10:00:00.000Z',
    },
    {
      id: '__streaming_session-2_1',
      sessionId: 'session-2',
      content: 'background text',
      timestamp: '2026-08-12T10:00:01.000Z',
    },
  ]);
  assert.equal(accumulator.getSnapshot('session-1'), null);
  assert.deepEqual(accumulator.drainSnapshots(), []);
});

test('keeps main-agent and subagent stream deltas isolated within one session', () => {
  const accumulator = createSessionStreamAccumulator();

  accumulator.appendDelta('session-1', 'main', undefined);
  accumulator.appendDelta('session-1', 'child ', undefined, 'toolu_agent_1');
  accumulator.appendDelta('session-1', 'output', undefined, 'toolu_agent_1');

  assert.equal(accumulator.get('session-1'), 'main');
  assert.equal(accumulator.get('session-1', 'toolu_agent_1'), 'child output');
  assert.equal(
    accumulator.getSnapshot('session-1', 'toolu_agent_1')?.parentToolUseId,
    'toolu_agent_1',
  );
});
