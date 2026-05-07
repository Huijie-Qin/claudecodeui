import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getWorkspaceToolsPaths,
  listWorkspaceTools,
  previewMcpJsonImport,
  probeHttpMcpServer,
  probeWorkspaceMcpServer,
  readMcpDrafts,
  readMcpStatus,
  readWorkspaceMcpConfig,
  removeWorkspaceMcpServer,
  upsertWorkspaceMcpServer,
  writeWorkspaceMcpConfig,
} from './workspace-tools.js';

async function createWorkspace() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-tools-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  return {
    workspacePath,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
  };
}

function okProbe(tools = [{ name: 'search', description: 'Search docs' }]) {
  return async () => ({
    status: 'healthy',
    phase: 'tools_list',
    error: '',
    latencyMs: 12,
    toolCount: tools.length,
    tools,
  });
}

test('listWorkspaceTools reads project .mcp.json and preserves unsupported existing servers', async () => {
  const { workspacePath, cleanup } = await createWorkspace();
  try {
    await writeWorkspaceMcpConfig(workspacePath, {
      mcpServers: {
        docs: { type: 'http', url: 'http://127.0.0.1:3333/mcp', headers: { Authorization: 'Bearer visible' } },
        local: { type: 'stdio', command: 'npx', args: ['server'] },
      },
    });

    const inventory = await listWorkspaceTools(workspacePath, { accessRole: 'view' });

    assert.equal(inventory.summary.builtin, 4);
    assert.equal(inventory.summary.httpMcp, 1);
    assert.equal(inventory.summary.unsupported, 1);
    assert.equal(inventory.tools.find((tool) => tool.id === 'builtin.write').status, 'read_only');
    assert.deepEqual(inventory.mcpServers.find((server) => server.name === 'docs').headers, {
      Authorization: 'Bearer visible',
    });
    assert.equal(inventory.mcpServers.find((server) => server.name === 'local').status, 'unsupported');
  } finally {
    await cleanup();
  }
});

test('upsertWorkspaceMcpServer probes, writes .mcp.json, status, and removes same-name draft', async () => {
  const { workspacePath, cleanup } = await createWorkspace();
  try {
    await upsertWorkspaceMcpServer({
      workspacePath,
      server: {
        name: 'docs',
        type: 'http',
        url: 'https://docs.example.com/mcp',
        headers: { Authorization: 'Bearer secret' },
      },
      now: () => new Date('2026-05-05T00:00:00.000Z'),
      probe: okProbe([{ name: 'lookup' }]),
    });

    const config = await readWorkspaceMcpConfig(workspacePath);
    const status = await readMcpStatus(workspacePath);

    assert.deepEqual(config.mcpServers.docs, {
      type: 'http',
      url: 'https://docs.example.com/mcp',
      headers: { Authorization: 'Bearer secret' },
    });
    assert.equal(status.servers.docs.status, 'healthy');
    assert.equal(status.servers.docs.toolCount, 1);
    assert.equal(status.servers.docs.checkedAt, '2026-05-05T00:00:00.000Z');
  } finally {
    await cleanup();
  }
});

test('upsertWorkspaceMcpServer saves needs-value drafts without writing .mcp.json', async () => {
  const { workspacePath, cleanup } = await createWorkspace();
  try {
    const result = await upsertWorkspaceMcpServer({
      workspacePath,
      server: {
        name: 'draft-docs',
        type: 'http',
        url: '',
        headers: { Authorization: '' },
      },
      now: () => new Date('2026-05-05T01:00:00.000Z'),
      probe: okProbe(),
    });

    const { mcpConfigPath } = getWorkspaceToolsPaths(workspacePath);
    const drafts = await readMcpDrafts(workspacePath);

    assert.equal(result.savedAsDraft, true);
    assert.deepEqual(result.server.missingValues, ['url', 'headers.Authorization']);
    await assert.rejects(fs.access(mcpConfigPath), { code: 'ENOENT' });
    assert.equal(drafts.drafts['draft-docs'].status, 'needs_value');
  } finally {
    await cleanup();
  }
});

test('upsertWorkspaceMcpServer stores probe failures but does not write failing server config', async () => {
  const { workspacePath, cleanup } = await createWorkspace();
  try {
    await assert.rejects(
      upsertWorkspaceMcpServer({
        workspacePath,
        server: {
          name: 'broken',
          type: 'http',
          url: 'http://127.0.0.1:4444/mcp',
        },
        probe: async () => ({
          status: 'probe_failed',
          phase: 'network',
          error: 'connection refused',
          latencyMs: 4,
          toolCount: 0,
          tools: [],
        }),
      }),
      /connection refused/,
    );

    const config = await readWorkspaceMcpConfig(workspacePath);
    const status = await readMcpStatus(workspacePath);

    assert.deepEqual(config.mcpServers, {});
    assert.equal(status.servers.broken.status, 'probe_failed');
    assert.equal(status.servers.broken.phase, 'network');
  } finally {
    await cleanup();
  }
});

test('probeWorkspaceMcpServer records real probe result without writing config', async () => {
  const { workspacePath, cleanup } = await createWorkspace();
  try {
    const result = await probeWorkspaceMcpServer({
      workspacePath,
      server: {
        name: 'probe-only',
        type: 'http',
        url: 'http://127.0.0.1:5555/mcp',
      },
      now: () => new Date('2026-05-05T02:00:00.000Z'),
      probe: okProbe([{ name: 'fetch' }]),
    });
    const config = await readWorkspaceMcpConfig(workspacePath);
    const status = await readMcpStatus(workspacePath);

    assert.equal(result.status, 'healthy');
    assert.deepEqual(config.mcpServers, {});
    assert.equal(status.servers['probe-only'].toolCount, 1);
  } finally {
    await cleanup();
  }
});

test('removeWorkspaceMcpServer deletes config, status, and draft metadata', async () => {
  const { workspacePath, cleanup } = await createWorkspace();
  try {
    await upsertWorkspaceMcpServer({
      workspacePath,
      server: { name: 'docs', type: 'http', url: 'https://docs.example.com/mcp' },
      probe: okProbe(),
    });
    await upsertWorkspaceMcpServer({
      workspacePath,
      server: { name: 'draft', type: 'http', url: '' },
      probe: okProbe(),
    });

    const result = await removeWorkspaceMcpServer({ workspacePath, name: 'docs' });
    const draftResult = await removeWorkspaceMcpServer({ workspacePath, name: 'draft' });
    const config = await readWorkspaceMcpConfig(workspacePath);
    const status = await readMcpStatus(workspacePath);
    const drafts = await readMcpDrafts(workspacePath);
    const paths = getWorkspaceToolsPaths(workspacePath);

    assert.deepEqual(result, { removed: true, name: 'docs' });
    assert.deepEqual(draftResult, { removed: true, name: 'draft' });
    assert.deepEqual(config.mcpServers, {});
    assert.deepEqual(status.servers, {});
    assert.deepEqual(drafts.drafts, {});
    await assert.rejects(fs.access(paths.mcpConfigPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(paths.statusPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(paths.draftsPath), { code: 'ENOENT' });
  } finally {
    await cleanup();
  }
});

test('previewMcpJsonImport classifies HTTP, needs-value, unsupported, invalid, and conflicts independently', () => {
  const preview = previewMcpJsonImport({
    existingNames: ['existing'],
    json: JSON.stringify({
      mcpServers: {
        ready: { type: 'http', url: 'http://localhost:3000/mcp' },
        missing: { type: 'http', headers: { Authorization: '' } },
        stdio: { type: 'stdio', command: 'npx' },
        invalid: null,
        existing: { type: 'http', url: 'https://existing.example.com/mcp' },
      },
    }),
  });

  assert.equal(preview.summary.ready, 2);
  assert.equal(preview.summary.needsValue, 1);
  assert.equal(preview.summary.unsupported, 1);
  assert.equal(preview.summary.invalid, 1);
  assert.equal(preview.summary.conflicts, 1);
  assert.equal(preview.entries.find((entry) => entry.name === 'existing').conflict, true);
});

test('probeHttpMcpServer performs initialize and tools/list over HTTP JSON-RPC', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-one' },
      });
    }
    if (calls.length === 2) {
      return new Response('', { status: 202 });
    }
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          { name: 'zeta' },
          { name: 'alpha', description: 'Alpha tool' },
        ],
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await probeHttpMcpServer(
    { type: 'http', url: 'http://127.0.0.1:9000/mcp', headers: { Authorization: 'Bearer abc' } },
    { fetchImpl },
  );

  assert.equal(result.status, 'healthy');
  assert.equal(result.toolCount, 2);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['alpha', 'zeta']);
  assert.equal(calls[0].body.method, 'initialize');
  assert.equal(calls[2].body.method, 'tools/list');
  assert.equal(calls[2].headers['Mcp-Session-Id'], 'session-one');
});

test('probeHttpMcpServer reports auth and static validation failures', async () => {
  const authResult = await probeHttpMcpServer(
    { type: 'http', url: 'https://secure.example.com/mcp' },
    {
      fetchImpl: async () => new Response('Unauthorized', { status: 401 }),
    },
  );
  const invalidResult = await probeHttpMcpServer({ type: 'http', url: 'ftp://example.com/mcp' });

  assert.equal(authResult.status, 'probe_failed');
  assert.equal(authResult.phase, 'auth');
  assert.equal(invalidResult.phase, 'static_validation');
  assert.match(invalidResult.error, /http:\/\/ or https:\/\//);
});
