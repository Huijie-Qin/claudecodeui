import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createScheduledTaskLogger,
  formatScheduledTaskError,
} from './scheduled-task-logger.js';

function createSink() {
  const entries = [];
  return {
    entries,
    debug(...args) { entries.push({ level: 'debug', args }); },
    info(...args) { entries.push({ level: 'info', args }); },
    warn(...args) { entries.push({ level: 'warn', args }); },
    error(...args) { entries.push({ level: 'error', args }); },
  };
}

test('scheduled task logger writes one-line structured lifecycle logs', () => {
  const sink = createSink();
  const logger = createScheduledTaskLogger({
    sink,
    now: () => new Date('2026-08-20T05:45:00.000Z'),
    processId: 42,
    level: 'info',
  });

  logger.info('task_started', {
    runId: 'scheduled-task-7-1787202000000',
    taskId: 7,
    tenantId: 1,
    workspaceId: 2,
    userId: 3,
    provider: 'claude',
    scheduledFor: '2026-08-20T05:40:00.000Z',
  });

  assert.equal(sink.entries.length, 1);
  assert.equal(sink.entries[0].level, 'info');
  assert.equal(sink.entries[0].args[0], '[ScheduledTasks]');
  assert.equal(sink.entries[0].args[1].includes('\n'), false);
  assert.deepEqual(JSON.parse(sink.entries[0].args[1]), {
    timestamp: '2026-08-20T05:45:00.000Z',
    level: 'info',
    event: 'task_started',
    processId: 42,
    runId: 'scheduled-task-7-1787202000000',
    taskId: 7,
    tenantId: 1,
    workspaceId: 2,
    userId: 3,
    provider: 'claude',
    scheduledFor: '2026-08-20T05:40:00.000Z',
  });
});

test('scheduled task logger hides debug events at the default info level', () => {
  const sink = createSink();
  const logger = createScheduledTaskLogger({ sink, level: 'info' });

  const result = logger.debug('tick_started', { tickId: 'tick-1' });

  assert.equal(result, null);
  assert.equal(sink.entries.length, 0);
});

test('scheduled task logger emits debug events when explicitly enabled', () => {
  const sink = createSink();
  const logger = createScheduledTaskLogger({ sink, level: 'debug' });

  logger.debug('tick_started', { tickId: 'tick-1' });

  assert.equal(sink.entries.length, 1);
  assert.equal(sink.entries[0].level, 'debug');
});

test('scheduled task errors are bounded and retain diagnostic fields', () => {
  const error = new Error(`failure-${'x'.repeat(3_000)}`);
  error.code = 'PROVIDER_FAILED';
  error.statusCode = 502;

  const formatted = formatScheduledTaskError(error);

  assert.equal(formatted.name, 'Error');
  assert.equal(formatted.code, 'PROVIDER_FAILED');
  assert.equal(formatted.statusCode, 502);
  assert.equal(formatted.message.length <= 2_001, true);
  assert.equal(formatted.stack.length <= 4_001, true);
});

test('scheduled task logger forwards structured entries to persistence', () => {
  const sink = createSink();
  const persisted = [];
  const logger = createScheduledTaskLogger({
    sink,
    level: 'info',
    now: () => new Date('2026-08-20T06:30:00.000Z'),
    onEntry: (entry) => persisted.push(entry),
  });

  logger.info('task_succeeded', { taskId: 9, durationMs: 25 });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].event, 'task_succeeded');
  assert.equal(persisted[0].taskId, 9);
  assert.equal(persisted[0].durationMs, 25);
});

test('scheduled task logging continues when persistence fails', () => {
  const sink = createSink();
  const logger = createScheduledTaskLogger({
    sink,
    level: 'info',
    now: () => new Date('2026-08-20T06:30:00.000Z'),
    onEntry: () => {
      throw new Error('database unavailable');
    },
  });

  const payload = logger.info('task_started', { taskId: 10 });

  assert.equal(payload.event, 'task_started');
  assert.equal(sink.entries.length, 2);
  const persistenceFailure = JSON.parse(sink.entries[1].args[1]);
  assert.equal(persistenceFailure.event, 'log_persistence_failed');
  assert.equal(persistenceFailure.sourceEvent, 'task_started');
});
