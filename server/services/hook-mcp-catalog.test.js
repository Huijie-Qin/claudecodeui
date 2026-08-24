import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHookMcpCatalogService } from './hook-mcp-catalog.js';

function createConfigStore() {
  const values = new Map();
  return {
    get: (key) => values.get(key) || null,
    set: (key, value) => values.set(key, value),
  };
}

test('Hook MCP catalog creates, updates, tests, and exposes isolated runtime config', async () => {
  const probeCalls = [];
  const service = createHookMcpCatalogService({
    configStore: createConfigStore(),
    now: (() => {
      const values = [
        '2026-08-23T01:00:00.000Z',
        '2026-08-23T01:01:00.000Z',
        '2026-08-23T01:02:00.000Z',
      ];
      return () => values.shift() || '2026-08-23T01:03:00.000Z';
    })(),
    probe: async (config) => {
      probeCalls.push(config);
      return {
        status: 'healthy',
        toolCount: 1,
        tools: [{ name: 'send', description: 'Send notification' }],
      };
    },
  });

  const created = service.createServer({
    userId: 9,
    input: {
      name: 'notify',
      displayName: '通知 MCP',
      description: 'Hook notification transport',
      url: 'https://notify.example.com/mcp',
      headers: { Authorization: 'Bearer secret' },
    },
  });
  assert.equal(created.config.alwaysLoad, true);
  assert.equal(created.lastTestStatus, null);
  assert.equal(service.listServers().length, 1);

  const updated = service.updateServer({
    serverName: 'notify',
    userId: 10,
    input: {
      displayName: '通知服务',
      url: 'https://notify.example.com/v2/mcp',
      headers: {},
      headersHelper: 'node /opt/hook-mcp/auth.js',
    },
  });
  assert.equal(updated.name, 'notify');
  assert.equal(updated.displayName, '通知服务');
  assert.equal(updated.updatedByUserId, 10);

  const tested = await service.testServer({ serverName: 'notify', userId: 10 });
  assert.equal(tested.lastTestStatus, 'healthy');
  assert.equal(tested.toolCount, 1);
  assert.deepEqual(probeCalls, [{
    name: 'notify',
    type: 'http',
    url: 'https://notify.example.com/v2/mcp',
    headers: {},
    headersHelper: 'node /opt/hook-mcp/auth.js',
    alwaysLoad: true,
  }]);
  assert.deepEqual(await service.getRuntimeConfig(), {
    mcpServers: {
      [tested.runtimeAlias]: {
        type: 'http',
        url: 'https://notify.example.com/v2/mcp',
        headers: {},
        headersHelper: 'node /opt/hook-mcp/auth.js',
        alwaysLoad: true,
      },
    },
    toolNames: [`mcp__${tested.runtimeAlias}__send`],
  });

  assert.equal(service.deleteServer({ serverName: 'notify' }).name, 'notify');
  assert.deepEqual(service.listServers(), []);
});

test('Hook MCP catalog keeps helper scripts private and materializes runtime-scoped copies', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-mcp-helper-'));
  const probeConfigs = [];
  const service = createHookMcpCatalogService({
    configStore: createConfigStore(),
    temporaryRoot: tempRoot,
    probe: async (config) => {
      probeConfigs.push(config);
      return { status: 'healthy', toolCount: 1, tools: [{ name: 'send' }] };
    },
  });

  try {
    service.createServer({
      userId: 9,
      input: {
        name: 'notify',
        displayName: 'Notify',
        url: 'http://127.0.0.1:3017/mcp/sql-syntax-check',
        headersHelper: 'python3 auth.py',
        helperEnv: { ROOT_SECRET: 'private-key' },
      },
    });
    const uploaded = service.uploadHelperScript({
      serverName: 'notify',
      userId: 9,
      originalName: 'auth.py',
      content: 'print("{}")\n',
    });
    assert.equal(uploaded.helperScript.fileName, 'auth.py');
    assert.equal(uploaded.helperScript.sha256.length, 64);
    assert.equal(Object.hasOwn(uploaded.helperScript, 'content'), false);

    await service.testServer({ serverName: 'notify', userId: 9 });
    assert.match(probeConfigs[0].headersHelper, /^cd '.+\/notify' && set -a/);
    assert.equal(Object.hasOwn(probeConfigs[0], 'helperEnv'), false);

    const hostDirectory = path.join(tempRoot, 'runtime', 'mcp-helpers');
    const runtime = await service.getRuntimeConfig({
      hostDirectory,
      commandDirectory: hostDirectory,
    });
    const runtimeServer = runtime.mcpServers[uploaded.runtimeAlias];
    const resourceDirectory = path.join(hostDirectory, uploaded.id, uploaded.contentHash);
    assert.match(runtimeServer.headersHelper, new RegExp(`^cd '${resourceDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.equal(
      await fs.readFile(path.join(resourceDirectory, 'auth.py'), 'utf8'),
      'print("{}")\n',
    );
    await assert.rejects(
      fs.readFile(path.join(resourceDirectory, '.headers-helper.env.sh'), 'utf8'),
      /ENOENT/,
    );
    assert.equal(Object.hasOwn(runtimeServer, 'helperEnv'), false);

    const dockerHostDirectory = path.join(tempRoot, 'docker-runtime', 'mcp-helpers');
    const dockerRuntime = await service.getRuntimeConfig({
      hostDirectory: dockerHostDirectory,
      commandDirectory: '/workspace/.cloudcli/hook-config/mcp',
      runtimeMode: 'docker',
      runtimeOwner: { uid: 1000, gid: 1000 },
    });
    assert.equal(
      dockerRuntime.mcpServers[uploaded.runtimeAlias].headersHelper,
      `cd '/workspace/.cloudcli/hook-config/mcp/${uploaded.id}/${uploaded.contentHash}' && python3 auth.py`,
    );
    assert.equal(
      dockerRuntime.mcpServers[uploaded.runtimeAlias].url,
      'http://host.docker.internal:3017/mcp/sql-syntax-check',
    );
    assert.equal(
      await fs.readFile(path.join(dockerHostDirectory, uploaded.id, uploaded.contentHash, 'auth.py'), 'utf8'),
      'print("{}")\n',
    );

    const deleted = service.deleteHelperScript({ serverName: 'notify', userId: 9 });
    assert.equal(deleted.helperScript, null);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Hook MCP catalog rejects duplicate servers and invalid HTTP configuration', () => {
  const service = createHookMcpCatalogService({ configStore: createConfigStore() });
  assert.throws(() => service.createServer({
    input: { name: 'bad name', displayName: 'Bad', url: 'https://example.com/mcp' },
  }), /name must use/);
  assert.throws(() => service.createServer({
    input: { name: 'notify', displayName: 'Notify', url: 'file:///tmp/mcp' },
  }), /must start with http/);
  service.createServer({
    input: { name: 'notify', displayName: 'Notify', url: 'https://example.com/mcp' },
  });
  assert.throws(() => service.createServer({
    input: { name: 'notify', displayName: 'Again', url: 'https://example.com/other' },
  }), /already exists/);
  assert.throws(() => service.updateServer({
    serverName: 'notify',
    input: {
      name: 'notify',
      displayName: 'Notify',
      url: 'https://example.com/mcp',
      headersHelper: { command: 'node auth.js' },
    },
  }), /headersHelper must be a string/);
});
