import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHookWorkspaceResourcesService } from './hook-workspace-resources.js';

test('Hook resources materialize full Skill folders and non-secret MCP cache entries idempotently', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-resources-'));
  const skillSource = path.join(root, 'source-skill');
  const workspacePath = path.join(root, 'workspace');
  await fs.mkdir(path.join(skillSource, 'scripts'), { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(skillSource, 'SKILL.md'), '# Notify\nRun scripts/notify.py.\n', { mode: 0o600 });
  await fs.writeFile(path.join(skillSource, 'scripts', 'notify.py'), 'print("ok")\n', { mode: 0o600 });
  await fs.writeFile(path.join(skillSource, 'scripts', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });

  const rawServer = {
    id: 'hook-mcp-notify',
    name: 'notify',
    displayName: 'Notify',
    description: 'Notification service',
    contentHash: 'abc123',
    runtimeAlias: 'ccui-hook-mcp-notify',
    config: {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret' },
      headersHelper: 'python3 headers.py',
      helperEnv: { PRIVATE_TOKEN: 'never-write-me' },
    },
    helperScript: {
      fileName: 'headers.py',
      content: 'import os\nprint("{}")\n',
      sha256: 'helper-sha',
    },
  };
  const catalog = {
    listServers: () => [{
      ...rawServer,
      helperScript: { fileName: 'headers.py', sha256: 'helper-sha' },
    }],
    getServerById: (serverId) => serverId === rawServer.id ? rawServer : null,
    listToolResources: () => [{
      name: 'mcp__notify__send',
      mcpServerId: rawServer.id,
    }],
  };
  const service = createHookWorkspaceResourcesService({
    hookMcpCatalog: catalog,
    skillLoader: async () => ({
      skillId: 'builtin:notify',
      name: 'notify',
      displayName: 'Notify',
      manifestPath: path.join(skillSource, 'SKILL.md'),
      content: '# Notify\n',
    }),
  });
  const hook = {
    id: 'hook-one',
    version: 2,
    postActions: [
      {
        type: 'invoke_skill',
        config: { skillId: 'builtin:notify', skillName: 'notify' },
      },
      {
        type: 'call_mcp_tool',
        config: { toolName: 'mcp__notify__send', mcpServerId: rawServer.id },
      },
    ],
  };

  try {
    const first = await service.materializeHook({ hook, workspacePath });
    const copiedSkillPath = path.join(first.skills[0].hostDirectory, 'SKILL.md');
    const copiedScriptPath = path.join(first.skills[0].hostDirectory, 'scripts', 'notify.py');
    const copiedExecutablePath = path.join(first.skills[0].hostDirectory, 'scripts', 'run.sh');
    const metadataPath = path.join(first.skills[0].hostDirectory, '.ccui-resource.json');

    assert.equal((await fs.stat(path.join(skillSource, 'SKILL.md'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(skillSource, 'scripts', 'notify.py'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(copiedSkillPath)).mode & 0o777, 0o644);
    assert.equal((await fs.stat(copiedScriptPath)).mode & 0o777, 0o644);
    assert.equal((await fs.stat(copiedExecutablePath)).mode & 0o777, 0o755);

    // Simulate a legacy cache created for another container user. Cache hits
    // must repair its modes instead of returning the stale private files.
    await fs.chmod(path.join(workspacePath, '.cloudcli'), 0o700);
    await fs.chmod(first.skills[0].hostDirectory, 0o700);
    await fs.chmod(path.join(first.skills[0].hostDirectory, 'scripts'), 0o700);
    await fs.chmod(copiedSkillPath, 0o600);
    await fs.chmod(copiedScriptPath, 0o600);
    await fs.chmod(copiedExecutablePath, 0o600);
    await fs.chmod(metadataPath, 0o600);

    const second = await service.materializeHook({ hook, workspacePath });
    assert.equal(first.skills[0].hostDirectory, second.skills[0].hostDirectory);
    assert.equal(
      await fs.readFile(copiedScriptPath, 'utf8'),
      'print("ok")\n',
    );
    assert.equal((await fs.stat(path.join(workspacePath, '.cloudcli'))).mode & 0o111, 0o111);
    assert.equal((await fs.stat(first.skills[0].hostDirectory)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(path.join(first.skills[0].hostDirectory, 'scripts'))).mode & 0o777, 0o755);
    assert.equal((await fs.stat(copiedSkillPath)).mode & 0o777, 0o644);
    assert.equal((await fs.stat(copiedScriptPath)).mode & 0o777, 0o644);
    assert.equal((await fs.stat(copiedExecutablePath)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(metadataPath)).mode & 0o777, 0o644);

    const mcpDirectory = first.mcpServers[0].hostDirectory;
    assert.equal(await fs.readFile(path.join(mcpDirectory, 'headers.py'), 'utf8'), rawServer.helperScript.content);
    const manifest = await fs.readFile(path.join(mcpDirectory, 'server.json'), 'utf8');
    assert.equal(manifest.includes('Bearer secret'), false);
    assert.equal(manifest.includes('never-write-me'), false);
    assert.match(manifest, /ccui-hook-mcp-notify/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Hook Skill MCP selections are ignored; only MCP call actions materialize servers', () => {
  const catalog = {
    listServers: () => [],
    getServerById: () => null,
    listToolResources: () => [],
  };
  const service = createHookWorkspaceResourcesService({ hookMcpCatalog: catalog });
  assert.deepEqual(service.resolveActionMcpServerIds({
    postActions: [{
      type: 'invoke_skill',
      config: { skillId: 'builtin:notify', skillName: 'notify', mcpServerIds: ['legacy-mcp'] },
    }],
  }, catalog), []);
});

test('MCP loop materializes the server selected by the Hook Matcher', () => {
  const catalog = {
    listServers: () => [],
    getServerById: () => null,
    listToolResources: () => [{
      name: 'mcp__tasks__get_task_status',
      mcpServerId: 'tasks-server',
    }],
  };
  const service = createHookWorkspaceResourcesService({ hookMcpCatalog: catalog });
  assert.deepEqual(service.resolveActionMcpServerIds({
    matcher: { value: 'mcp__tasks__get_task_status' },
    postActions: [{ type: 'mcp_loop_run', config: {} }],
  }, catalog), ['tasks-server']);
});

test('Hook Skill materialization rejects symbolic links', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-resources-link-'));
  const skillSource = path.join(root, 'skill');
  const workspacePath = path.join(root, 'workspace');
  await fs.mkdir(skillSource, { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(skillSource, 'SKILL.md'), '# Unsafe\n');
  await fs.symlink('/tmp', path.join(skillSource, 'escape'));
  const service = createHookWorkspaceResourcesService({
    hookMcpCatalog: { listServers: () => [], getServerById: () => null, listToolResources: () => [] },
    skillLoader: async () => ({
      skillId: 'builtin:unsafe',
      name: 'unsafe',
      manifestPath: path.join(skillSource, 'SKILL.md'),
    }),
  });
  try {
    await assert.rejects(
      service.materializeHook({
        workspacePath,
        hook: {
          id: 'unsafe-hook',
          version: 1,
          postActions: [{ type: 'invoke_skill', config: { skillId: 'builtin:unsafe', skillName: 'unsafe' } }],
        },
      }),
      /symbolic link/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
