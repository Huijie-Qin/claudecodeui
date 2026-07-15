import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadMcpConfig } from './services/claude-mcp-config.js';
import {
  WORKSPACE_CONTAINER_ROOT_ENV,
  WORKSPACE_HOST_ROOT_ENV,
} from './services/workspace-path-mapping.js';

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('loadMcpConfig merges workspace .mcp.json into SDK mcpServers', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sdk-mcp-'));
  const homeDir = path.join(tempRoot, 'home');
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  await writeJson(path.join(homeDir, '.claude.json'), {
    mcpServers: {
      global_docs: {
        type: 'http',
        url: 'https://global.example.com/mcp',
      },
    },
    claudeProjects: {
      [workspacePath]: {
        mcpServers: {
          project_docs: {
            type: 'http',
            url: 'https://project.example.com/mcp',
          },
          workspace_override: {
            type: 'http',
            url: 'https://project.example.com/old',
          },
        },
      },
    },
  });
  await writeJson(path.join(workspacePath, '.mcp.json'), {
    mcpServers: {
      workspace_override: {
        type: 'http',
        url: 'https://workspace.example.com/new',
      },
      admin_installed: {
        type: 'http',
        url: 'https://admin.example.com/mcp',
        headers: {
          Authorization: 'Bearer admin-managed',
        },
      },
    },
  });

  const config = await loadMcpConfig(workspacePath, { homeDir });

  assert.equal(config.global_docs.url, 'https://global.example.com/mcp');
  assert.equal(config.project_docs.url, 'https://project.example.com/mcp');
  assert.equal(config.workspace_override.url, 'https://workspace.example.com/new');
  assert.deepEqual(config.admin_installed, {
    type: 'http',
    url: 'https://admin.example.com/mcp',
    headers: {
      Authorization: 'Bearer admin-managed',
    },
  });
});

test('loadMcpConfig can isolate docker mode to workspace .mcp.json', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sdk-mcp-docker-'));
  const homeDir = path.join(tempRoot, 'home');
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  await writeJson(path.join(homeDir, '.claude.json'), {
    mcpServers: {
      host_only: {
        type: 'http',
        url: 'https://host.example.com/mcp',
      },
    },
  });
  await writeJson(path.join(workspacePath, '.mcp.json'), {
    mcpServers: {
      workspace_only: {
        type: 'http',
        url: 'https://workspace.example.com/mcp',
      },
    },
  });

  const config = await loadMcpConfig(workspacePath, {
    homeDir,
    includeHostConfig: false,
  });

  assert.deepEqual(Object.keys(config), ['workspace_only']);
  assert.equal(config.workspace_only.url, 'https://workspace.example.com/mcp');
});

test('loadMcpConfig rewrites local MCP URLs for docker mode', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sdk-mcp-docker-local-'));
  const homeDir = path.join(tempRoot, 'home');
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  await writeJson(path.join(workspacePath, '.mcp.json'), {
    mcpServers: {
      local_docs: {
        type: 'http',
        url: 'http://127.0.0.1:39999/mcp',
      },
      remote_docs: {
        type: 'http',
        url: 'https://remote.example.com/mcp',
      },
    },
  });

  const config = await loadMcpConfig(workspacePath, {
    homeDir,
    includeHostConfig: false,
    runtimeMode: 'docker',
  });

  assert.equal(config.local_docs.url, 'http://host.docker.internal:39999/mcp');
  assert.equal(config.remote_docs.url, 'https://remote.example.com/mcp');
});

test('loadMcpConfig reads workspace .mcp.json through a container workspace root mapping', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sdk-mcp-mapped-'));
  const homeDir = path.join(tempRoot, 'home');
  const containerRoot = path.join(tempRoot, 'host-home');
  const mappedWorkspacePath = path.join(containerRoot, 'default', 'j00939207', 'test');
  await fs.mkdir(mappedWorkspacePath, { recursive: true });

  await writeJson(path.join(mappedWorkspacePath, '.mcp.json'), {
    mcpServers: {
      env_enum: {
        type: 'http',
        url: 'http://host.docker.internal:40002/mcp',
      },
    },
  });

  const hostRoot = `C:\\cloudcli-missing-${Date.now()}-${process.pid}`;
  const workspacePath = `${hostRoot}\\default\\j00939207\\test`;
  const config = await loadMcpConfig(workspacePath, {
    homeDir,
    includeHostConfig: false,
    env: {
      [WORKSPACE_HOST_ROOT_ENV]: hostRoot,
      [WORKSPACE_CONTAINER_ROOT_ENV]: containerRoot,
    },
  });

  assert.deepEqual(config, {
    env_enum: {
      type: 'http',
      url: 'http://host.docker.internal:40002/mcp',
    },
  });
});

test('loadMcpConfig returns null when no MCP servers are configured', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sdk-mcp-empty-'));
  const homeDir = path.join(tempRoot, 'home');
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const config = await loadMcpConfig(workspacePath, { homeDir });

  assert.equal(config, null);
});
