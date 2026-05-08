import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMcpPresetPayload,
  normalizeMcpPresetName,
  parseHeadersText,
} from './adminMcpPresetUtils';

test('normalizeMcpPresetName creates MCP-safe preset names', () => {
  assert.equal(normalizeMcpPresetName('Knowledge Retrieval MCP'), 'knowledge_retrieval_mcp');
  assert.equal(normalizeMcpPresetName('data.query'), 'data.query');
  assert.equal(normalizeMcpPresetName('---'), '');
});

test('parseHeadersText accepts JSON objects and key-value lines', () => {
  assert.deepEqual(parseHeadersText('{"Authorization":"Bearer token"}'), {
    Authorization: 'Bearer token',
  });
  assert.deepEqual(parseHeadersText('X-Team: CloudCLI\nX-Env=prod'), {
    'X-Team': 'CloudCLI',
    'X-Env': 'prod',
  });
});

test('buildMcpPresetPayload creates Admin-managed HTTP config without user setup fields', () => {
  assert.deepEqual(buildMcpPresetPayload({
    tenantId: 7,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search docs',
    url: 'https://mcp.internal/knowledge',
    headersText: 'Authorization: Bearer token',
    status: 'draft',
  }), {
    tenantId: 7,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search docs',
    status: 'draft',
    type: 'http',
    url: 'https://mcp.internal/knowledge',
    headers: {
      Authorization: 'Bearer token',
    },
  });
});
