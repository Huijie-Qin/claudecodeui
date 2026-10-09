import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutionActivity } from './executionActivity';
import type { ExecutionTask, ExecutionTaskEvent } from './types';

const title = 'Fetch origin with SSL verification disabled';
const summary = `Background command "${title}" completed (exit code 0)`;
const event = (id: string, time: string, status: string, summary: string, result?: unknown): ExecutionTaskEvent => ({
  id, timestamp: new Date(`2026-10-09T08:16:${time}Z`), status, summary,
  ...(result !== undefined ? { result } : {}),
});
const liveEvents = () => [
  event('invocation:bash', '46.825', 'running', title),
  event('sdk-started', '46.881', 'running', title),
  event('result:bash', '46.886', 'running', 'Bash', ''),
  event('sdk-updated', '50.937', 'completed', 'Background task updated'),
  event('sdk-completed', '50.941', 'completed', summary),
  event('native-completed', '51.031', 'completed', summary),
];
const task = (events: ExecutionTaskEvent[], overrides: Partial<ExecutionTask> = {}): ExecutionTask => ({
  id: 'background:task:b3kiutlxz', taskId: 'b3kiutlxz', kind: 'background',
  title, status: 'completed', summary, events, exitCode: 0, ...overrides,
});

test('the real fetch receipts display one start and one completion without mutating source history', () => {
  const value = task(liveEvents());
  const original = JSON.stringify(value);
  const activity = buildExecutionActivity(value);
  assert.deepEqual(activity.map(item => [item.id, item.kind]), [
    ['invocation:bash', 'started'], ['native-completed', 'completed'],
  ]);
  assert.equal(activity[0].timestamp.toISOString(), '2026-10-09T08:16:46.825Z');
  assert.equal(activity[1].timestamp.toISOString(), '2026-10-09T08:16:51.031Z');
  assert.equal(JSON.stringify(value), original);
});

test('query failures and actual empty-file reads remain separate events of the completed execution', () => {
  const value = task([...liveEvents(),
    event('task-output:query', '55.000', 'unknown', 'TaskOutput', '<tool_use_error>No task found</tool_use_error>'),
    event('output-read:read', '56.000', 'completed', 'Read /tmp/b3kiutlxz.output', '<system-reminder>Empty file</system-reminder>'),
  ]);
  const activity = buildExecutionActivity(value);
  assert.deepEqual(activity.map(item => item.kind), ['started', 'completed', 'result', 'output']);
  assert.match(String(activity[2].result), /No task found/);
  assert.match(String(activity[3].result), /Empty file/);
  assert.equal(value.status, 'completed');
  assert.equal(value.exitCode, 0);
});

test('partial launch stdout and distinct progress survive lifecycle receipt consolidation', () => {
  const value = task([...liveEvents(),
    event('result:partial-launch', '47.000', 'running', 'Bash', 'Receiving objects: 40%'),
    event('progress-a', '48.000', 'running', 'Receiving objects: 60%'),
    event('progress-b', '49.000', 'running', 'Receiving objects: 60%'),
    event('late-progress', '52.000', 'running', 'Delayed progress'),
  ]);
  const activity = buildExecutionActivity(value);
  assert.deepEqual(activity.map(item => item.kind), ['started', 'output', 'progress', 'progress', 'completed', 'progress']);
  assert.equal(activity[1].result, 'Receiving objects: 40%');
});

test('terminal output, distinct diagnostics and unfamiliar statuses are not discarded', () => {
  const value = task([
    event('started', '46.000', 'running', title),
    event('other-finish', '50.000', 'completed', 'Validated remote refs'),
    event('finish-empty', '51.000', 'completed', summary, ''),
    event('duplicate-no-body', '51.500', 'completed', summary),
    event('finish-output', '52.000', 'completed', summary, 'New remote ref'),
    event('unfamiliar', '53.000', 'provider_new_state', 'Provider diagnostic'),
  ]);
  const activity = buildExecutionActivity(value);
  assert.deepEqual(activity.map(item => item.id), ['started', 'other-finish', 'finish-empty', 'duplicate-no-body', 'finish-output', 'unfamiliar']);
  assert.equal(activity.at(-1)?.kind, 'unknown');
});

test('progress without a start receipt is not invented into a start event', () => {
  const activity = buildExecutionActivity(task([event('progress-only', '48.000', 'running', 'Receiving objects: 60%')]));
  assert.deepEqual(activity.map(item => item.kind), ['progress']);
});

test('terminal receipts with different explicit exit codes remain inspectable', () => {
  const activity = buildExecutionActivity(task([
    { ...event('first-failure', '50.000', 'failed', 'Command failed'), exitCode: 1 },
    { ...event('second-failure', '51.000', 'failed', 'Command failed'), exitCode: 2 },
    { ...event('repeated-failure', '52.000', 'failed', 'Command failed'), exitCode: 2 },
  ]));
  assert.deepEqual(activity.map(item => [item.id, item.exitCode]), [
    ['first-failure', 1], ['repeated-failure', 2],
  ]);
});
