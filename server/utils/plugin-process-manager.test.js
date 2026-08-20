import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createPluginProcessManager } from './plugin-process-manager.js';

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      child.emit('exit', 0);
    });
    return true;
  };
  return child;
}

function createManager(child) {
  return createPluginProcessManager({
    spawnProcess: () => child,
    startupTimeoutMs: 1_000,
    forceKillTimeoutMs: 100,
    logger: { log() {}, warn() {}, error() {} },
  });
}

test('a normally started plugin remains available until it is stopped', async () => {
  const child = createFakeChild();
  const manager = createManager(child);
  const starting = manager.startPluginServer('example', '/plugins/example', 'server.js');

  child.stdout.emit('data', '{"ready":true,"port":4567}\n');
  assert.equal(await starting, 4567);
  assert.equal(manager.getPluginPort('example'), 4567);

  await manager.stopPluginServer('example');
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(manager.getPluginPort('example'), null);
});

test('stopAllPlugins terminates an in-flight child and prevents late ready registration', async () => {
  const child = createFakeChild();
  const manager = createManager(child);
  const starting = manager.startPluginServer('slow', '/plugins/slow', 'server.js');
  const observedStart = starting.then(
    () => ({ resolved: true }),
    (error) => ({ resolved: false, error }),
  );

  const stopping = manager.stopAllPlugins();
  child.stdout.emit('data', '{"ready":true,"port":9876}\n');
  await stopping;

  const startResult = await observedStart;
  assert.equal(startResult.resolved, false);
  assert.equal(startResult.error.code, 'PLUGIN_HOST_SHUTTING_DOWN');
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(manager.getPluginPort('slow'), null);
  await assert.rejects(
    () => manager.startPluginServer('later', '/plugins/later', 'server.js'),
    (error) => error.code === 'PLUGIN_HOST_SHUTTING_DOWN',
  );
});
