import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MCP_TOOL_OVERRIDES_RELATIVE_PATH,
  applyMcpToolOverrides,
  buildMcpToolOverridePreToolUseOutput,
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

test('applyMcpToolOverrides supports sparse configs with only custom parameters', () => {
  const result = applyMcpToolOverrides({
    toolName: 'mcp__typed_python_mcp__search_docs',
    input: {
      query: 'model query',
      max_results: 3,
      indexes: ['model-index'],
      filters: { owner: 'model' },
      fresh_only: false,
    },
    config: {
      version: 1,
      mcpServers: {
        typed_python_mcp: {
          tools: {
            search_docs: {
              params: {
                query: { custom: true, value: 'custom query' },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(result.applied, true);
  assert.deepEqual(result.appliedParams, ['query']);
  assert.deepEqual(result.input, {
    query: 'custom query',
    max_results: 3,
    indexes: ['model-index'],
    filters: { owner: 'model' },
    fresh_only: false,
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

test('buildMcpToolOverridePreToolUseOutput returns SDK updatedInput for MCP calls', () => {
  const result = buildMcpToolOverridePreToolUseOutput({
    toolName: 'mcp__typed_python_mcp__search_docs',
    input: {
      query: 'model query',
      max_results: 3,
      indexes: ['model-index'],
    },
    config: {
      mcpServers: {
        typed_python_mcp: {
          tools: {
            search_docs: {
              params: {
                query: { custom: false, value: 'ignored query' },
                max_results: { custom: true, value: 8 },
                indexes: { custom: true, value: ['engineering', 'policy'] },
              },
            },
          },
        },
      },
    },
  });

  assert.deepEqual(result.output, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: {
        query: 'model query',
        max_results: 8,
        indexes: ['engineering', 'policy'],
      },
    },
  });
  assert.equal(result.overrideResult.applied, true);
  assert.deepEqual(result.overrideResult.appliedParams, ['max_results', 'indexes']);
});

test('buildMcpToolOverridePreToolUseOutput is a no-op when no custom MCP params match', () => {
  const input = { query: 'model query' };
  const result = buildMcpToolOverridePreToolUseOutput({
    toolName: 'mcp__typed_python_mcp__search_docs',
    input,
    config: {
      mcpServers: {
        typed_python_mcp: {
          tools: {
            search_docs: {
              params: {
                query: { custom: false, value: 'ignored query' },
              },
            },
          },
        },
      },
    },
  });

  assert.deepEqual(result.output, {});
  assert.equal(result.overrideResult.input, input);
  assert.equal(result.overrideResult.applied, false);
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

