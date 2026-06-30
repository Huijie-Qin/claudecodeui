import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeSweeper } from './runtime-sweeper.js';

const ENABLED_CONFIG = {
  enabled: true,
  idleTimeoutMinutes: 30,
  sweeperIntervalSeconds: 60,
};

function createLogger() {
  return {
    entries: [],
    info: () => {},
    warn(message, metadata) {
      this.entries.push({ level: 'warn', message, metadata });
    },
  };
}

function createMultitenancy(candidates) {
  const calls = [];
  return {
    calls,
    runtimes: {
      listExpiredIdleRuntimes(args) {
        calls.push(args);
        return candidates;
      },
    },
  };
}

test('sweepOnce stops only expired idle runtimes with running containers', async () => {
  const candidates = [
    { runtime_id: 'runtime-running', container_name: 'container-running' },
    { runtime_id: 'runtime-exited', container_name: 'container-exited' },
    { runtime_id: 'runtime-missing', container_name: 'container-missing' },
  ];
  const multitenancy = createMultitenancy(candidates);
  const inspected = [];
  const stopped = [];
  const docker = {
    async inspectContainer(containerName) {
      inspected.push(containerName);
      if (containerName === 'container-running') return { exists: true, running: true };
      if (containerName === 'container-exited') return { exists: true, running: false };
      return null;
    },
  };
  const runtimeManager = {
    async stopExpiredIdleRuntime(args) {
      stopped.push(args);
      return true;
    },
    stopRuntime: async () => {
      throw new Error('sweeper must not use generic stopRuntime');
    },
  };
  const sweeper = createRuntimeSweeper({
    config: ENABLED_CONFIG,
    multitenancy,
    docker,
    runtimeManager,
    logger: createLogger(),
  });

  const result = await sweeper.sweepOnce();

  assert.deepEqual(result, { inspected: 3, stopped: 1, failed: 0 });
  assert.deepEqual(multitenancy.calls, [{ olderThanMinutes: 30, limit: 100, cursor: null }]);
  assert.deepEqual(inspected, ['container-running', 'container-exited', 'container-missing']);
  assert.deepEqual(stopped, [{ runtimeId: 'runtime-running', olderThanMinutes: 30 }]);
});

test('sweepOnce skips a running candidate when protected stop reports stale revalidation', async () => {
  const candidates = [{ runtime_id: 'runtime-resumed', container_name: 'container-resumed' }];
  const multitenancy = createMultitenancy(candidates);
  const stopped = [];
  const sweeper = createRuntimeSweeper({
    config: ENABLED_CONFIG,
    multitenancy,
    docker: {
      async inspectContainer() {
        return { exists: true, running: true };
      },
    },
    runtimeManager: {
      async stopExpiredIdleRuntime(args) {
        stopped.push(args);
        return false;
      },
      stopRuntime: async () => {
        throw new Error('sweeper must not use generic stopRuntime');
      },
    },
    logger: createLogger(),
  });

  const result = await sweeper.sweepOnce();

  assert.deepEqual(result, { inspected: 1, stopped: 0, failed: 0 });
  assert.deepEqual(stopped, [{ runtimeId: 'runtime-resumed', olderThanMinutes: 30 }]);
});

test('sweepOnce continues through all expired idle runtime batches', async () => {
  const firstBatch = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    runtime_id: `runtime-${index + 1}`,
    container_name: `container-${index + 1}`,
    last_used_at: '2026-05-04 00:00:00',
  }));
  const secondBatch = [{
    id: 101,
    runtime_id: 'runtime-101',
    container_name: 'container-101',
    last_used_at: '2026-05-04 00:01:00',
  }];
  const batches = [firstBatch, secondBatch];
  const calls = [];
  const inspected = [];
  const sweeper = createRuntimeSweeper({
    config: ENABLED_CONFIG,
    multitenancy: {
      runtimes: {
        listExpiredIdleRuntimes(args) {
          calls.push(args);
          return batches.shift() ?? [];
        },
      },
    },
    docker: {
      async inspectContainer(containerName) {
        inspected.push(containerName);
        return { exists: true, running: true };
      },
    },
    runtimeManager: {
      async stopExpiredIdleRuntime() {
        return true;
      },
    },
    logger: createLogger(),
  });

  const result = await sweeper.sweepOnce();

  assert.deepEqual(result, { inspected: 101, stopped: 101, failed: 0 });
  assert.equal(inspected.length, 101);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { olderThanMinutes: 30, limit: 100, cursor: null });
  assert.deepEqual(calls[1], {
    olderThanMinutes: 30,
    limit: 100,
    cursor: { lastUsedAt: '2026-05-04 00:00:00', id: 100 },
  });
});

test('disabled sweeper returns zeros and does not query database', async () => {
  const multitenancy = {
    runtimes: {
      listExpiredIdleRuntimes() {
        throw new Error('disabled sweeper should not query DB');
      },
    },
  };
  const sweeper = createRuntimeSweeper({
    config: { ...ENABLED_CONFIG, enabled: false },
    multitenancy,
    docker: {},
    runtimeManager: {},
    logger: createLogger(),
  });

  assert.deepEqual(await sweeper.sweepOnce(), { inspected: 0, stopped: 0, failed: 0 });
});

test('start and stop manage one unref interval using configured milliseconds', () => {
  const intervals = [];
  const cleared = [];
  const sweeper = createRuntimeSweeper({
    config: { ...ENABLED_CONFIG, sweeperIntervalSeconds: 12 },
    multitenancy: createMultitenancy([]),
    docker: {},
    runtimeManager: {},
    logger: createLogger(),
    setIntervalFn(callback, ms) {
      const interval = {
        callback,
        ms,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      intervals.push(interval);
      return interval;
    },
    clearIntervalFn(interval) {
      cleared.push(interval);
    },
  });

  sweeper.start();
  sweeper.start();

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 12_000);
  assert.equal(intervals[0].unrefCalled, true);

  sweeper.stop();
  sweeper.stop();

  assert.deepEqual(cleared, [intervals[0]]);
});

test('sweepOnce contains inspect and stop failures and counts failed runtimes', async () => {
  const candidates = [
    { runtime_id: 'runtime-inspect-fails', container_name: 'container-inspect-fails' },
    { runtime_id: 'runtime-stop-fails', container_name: 'container-stop-fails' },
    { runtime_id: 'runtime-running', container_name: 'container-running' },
  ];
  const stopped = [];
  const sweeper = createRuntimeSweeper({
    config: ENABLED_CONFIG,
    multitenancy: createMultitenancy(candidates),
    docker: {
      async inspectContainer(containerName) {
        if (containerName === 'container-inspect-fails') {
          throw new Error('inspect failed');
        }
        return { exists: true, running: true };
      },
    },
    runtimeManager: {
      async stopExpiredIdleRuntime({ runtimeId }) {
        if (runtimeId === 'runtime-stop-fails') {
          throw new Error('stop failed');
        }
        stopped.push(runtimeId);
        return true;
      },
    },
    logger: createLogger(),
  });

  const result = await sweeper.sweepOnce();

  assert.deepEqual(result, { inspected: 3, stopped: 1, failed: 2 });
  assert.deepEqual(stopped, ['runtime-running']);
});

test('sweepOnce contains candidate-list failures and resets reentrant guard', async () => {
  let calls = 0;
  const logger = createLogger();
  const sweeper = createRuntimeSweeper({
    config: ENABLED_CONFIG,
    multitenancy: {
      runtimes: {
        listExpiredIdleRuntimes() {
          calls += 1;
          if (calls === 1) {
            throw new Error('list failed');
          }
          return [];
        },
      },
    },
    docker: {},
    runtimeManager: {},
    logger,
  });

  assert.deepEqual(await sweeper.sweepOnce(), { inspected: 0, stopped: 0, failed: 1 });
  assert.deepEqual(await sweeper.sweepOnce(), { inspected: 0, stopped: 0, failed: 0 });
  assert.equal(calls, 2);
  assert.equal(logger.entries[0].message, 'runtime sweeper list failed');
});

test('interval-triggered sweep failure is contained', async () => {
  const logger = createLogger();
  const intervals = [];
  const sweeper = createRuntimeSweeper({
    config: ENABLED_CONFIG,
    multitenancy: {
      runtimes: {
        listExpiredIdleRuntimes() {
          throw new Error('list failed');
        },
      },
    },
    docker: {},
    runtimeManager: {},
    logger,
    setIntervalFn(callback, ms) {
      const interval = { callback, ms };
      intervals.push(interval);
      return interval;
    },
    clearIntervalFn: () => {},
  });

  sweeper.start();
  assert.doesNotThrow(() => intervals[0].callback());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(logger.entries[0].message, 'runtime sweeper list failed');
});

test('concurrent sweepOnce calls return zeros for the reentrant call without listing again', async () => {
  let listStarted;
  let resolveListStarted;
  let releaseList;
  listStarted = new Promise((resolve) => {
    resolveListStarted = resolve;
  });
  const multitenancy = {
    calls: 0,
    runtimes: {
      async listExpiredIdleRuntimes() {
        multitenancy.calls += 1;
        resolveListStarted();
        await new Promise((release) => {
          releaseList = release;
        });
        return [{ runtime_id: 'runtime-running', container_name: 'container-running' }];
      },
    },
  };
  const sweeper = createRuntimeSweeper({
    config: ENABLED_CONFIG,
    multitenancy,
    docker: {
      async inspectContainer() {
        return { exists: true, running: true };
      },
    },
    runtimeManager: {
      async stopExpiredIdleRuntime() {
        return true;
      },
    },
    logger: createLogger(),
  });

  const firstSweep = sweeper.sweepOnce();
  await listStarted;

  const secondResult = await sweeper.sweepOnce();
  assert.deepEqual(secondResult, { inspected: 0, stopped: 0, failed: 0 });
  assert.equal(multitenancy.calls, 1);

  releaseList();
  assert.deepEqual(await firstSweep, { inspected: 1, stopped: 1, failed: 0 });
});
