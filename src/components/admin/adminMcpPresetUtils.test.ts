import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMcpPresetPayload,
  normalizeMcpPresetName,
  parseHelperEnvText,
  parseHeadersText,
  parseTimeoutMsText,
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

test('parseHelperEnvText accepts JSON objects and key-value lines', () => {
  assert.deepEqual(parseHelperEnvText('{"ROOT_SECRET":"root-key"}'), {
    ROOT_SECRET: 'root-key',
  });
  assert.deepEqual(parseHelperEnvText('ROOT_SECRET=root-key\nTOKEN: token-value'), {
    ROOT_SECRET: 'root-key',
    TOKEN: 'token-value',
  });
});

test('parseTimeoutMsText keeps the native MCP timeout optional', () => {
  assert.equal(parseTimeoutMsText(''), undefined);
  assert.equal(parseTimeoutMsText('180000'), 180000);
  assert.throws(() => parseTimeoutMsText('0'), /positive integer in milliseconds/);
});

test('buildMcpPresetPayload creates Admin-managed HTTP config without user setup fields', () => {
  assert.deepEqual(buildMcpPresetPayload({
    tenantId: 7,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search docs',
    url: 'https://mcp.internal/knowledge',
    timeoutMsText: '180000',
    headersText: 'Authorization: Bearer token',
    headersHelper: '/opt/bin/get-mcp-auth-headers.sh',
    helperEnvText: 'ROOT_SECRET=root-key',
    preinstall: true,
    status: 'draft',
  }), {
    tenantId: 7,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search docs',
    status: 'draft',
    preinstallScope: 'all_workspaces',
    type: 'http',
    url: 'https://mcp.internal/knowledge',
    timeout: 180000,
    headers: {
      Authorization: 'Bearer token',
    },
    headersHelper: '/opt/bin/get-mcp-auth-headers.sh',
    helperEnv: {
      ROOT_SECRET: 'root-key',
    },
  });
});
