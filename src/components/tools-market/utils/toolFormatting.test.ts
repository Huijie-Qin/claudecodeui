import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterWorkspaceTools,
  formatHeaderLines,
  parseHeaderLines,
  sortWorkspaceTools,
  type WorkspaceTool,
} from './toolFormatting';

const tools: WorkspaceTool[] = [
  { id: 'mcp.broken', name: 'broken', type: 'mcp', status: 'probe_failed', transport: 'http' },
  { id: 'builtin.write', name: 'write', type: 'builtin', status: 'available' },
  { id: 'mcp.docs', name: 'docs', type: 'mcp', status: 'healthy', transport: 'http' },
  { id: 'builtin.read', name: 'read', type: 'builtin', status: 'read_only' },
];

test('sortWorkspaceTools keeps built-ins first and orders MCPs by health', () => {
  assert.deepEqual(
    sortWorkspaceTools(tools).map((tool) => tool.id),
    ['builtin.write', 'builtin.read', 'mcp.docs', 'mcp.broken'],
  );
});

test('filterWorkspaceTools searches probe tool names and configuration values', () => {
  const result = filterWorkspaceTools([
    {
      id: 'mcp.docs',
      name: 'docs',
      type: 'mcp',
      status: 'healthy',
      transport: 'http',
      url: 'https://docs.example.com/mcp',
      tools: [{ name: 'lookup_docs', description: 'Lookup docs' }],
    },
  ], 'lookup');

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'docs');
});

test('parseHeaderLines and formatHeaderLines preserve visible values', () => {
  const headers = parseHeaderLines('Authorization=Bearer secret\nX-Empty=\nLoose-Header');

  assert.deepEqual(headers, {
    Authorization: 'Bearer secret',
    'X-Empty': '',
    'Loose-Header': '',
  });
  assert.equal(formatHeaderLines({ Authorization: 'Bearer secret' }), 'Authorization=Bearer secret');
});
