import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MCP_TOOL_OVERRIDES_RELATIVE_PATH,
  applyMcpToolOverrides,
  parseMcpToolName,
  readMcpToolOverridesConfig,
} from './mcp-tool-overrides.js';

test('parseMcpToolName extracts MCP server and tool names', () => {
  assert.deepEqual(parseMcpToolName('mcp__knowledge_retrieval__search_docs'), {
    serverName: 'knowledge_retrieval',
    toolName: 'search_docs',
  });
  assert.equal(parseMcpToolName('Bash'), null);
});

test('applyMcpToolOverrides replaces model parameters when custom is true', () => {
  const result = applyMcpToolOverrides({
    toolName: 'mcp__knowledge_retrieval__search_docs',
    input: {
      query: 'deployment policy',
      indexes: ['support'],
      maxResults: 3,
      freshOnly: false,
    },
    config: {
      version: 1,
      mcpServers: {
        knowledge_retrieval: {
          tools: {
            search_docs: {
              params: {
                indexes: { custom: true, value: ['engineering', 'policy'] },
                maxResults: { custom: true, value: 8 },
                freshOnly: { custom: false, value: true },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(result.applied, true);
  assert.deepEqual(result.appliedParams, ['indexes', 'maxResults']);
  assert.deepEqual(result.input, {
    query: 'deployment policy',
    indexes: ['engineering', 'policy'],
    maxResults: 8,
    freshOnly: false,
  });
});

test('applyMcpToolOverrides leaves non-custom and non-MCP inputs unchanged', () => {
  const config = {
    mcpServers: {
      knowledge_retrieval: {
        tools: {
          search_docs: {
            params: {
              maxResults: { custom: false, value: 8 },
            },
          },
        },
      },
    },
  };
  const input = { maxResults: 3 };

  assert.deepEqual(applyMcpToolOverrides({
    toolName: 'mcp__knowledge_retrieval__search_docs',
    input,
    config,
  }), {
    input,
    applied: false,
    appliedParams: [],
    serverName: 'knowledge_retrieval',
    toolName: 'search_docs',
  });

  assert.deepEqual(applyMcpToolOverrides({
    toolName: 'Bash',
    input,
    config,
  }), {
    input,
    applied: false,
    appliedParams: [],
  });
});

test('readMcpToolOverridesConfig reads the workspace-local override file', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tool-overrides-'));
  try {
    const configPath = path.join(tempRoot, MCP_TOOL_OVERRIDES_RELATIVE_PATH);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ version: 1, mcpServers: {} }), 'utf8');

    assert.deepEqual(await readMcpToolOverridesConfig(tempRoot), {
      version: 1,
      mcpServers: {},
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('readMcpToolOverridesConfig returns null when the override file is missing', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tool-overrides-missing-'));
  try {
    assert.equal(await readMcpToolOverridesConfig(tempRoot), null);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

