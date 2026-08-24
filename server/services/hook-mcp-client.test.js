import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHeaders } from './hook-mcp-client.js';

test('Hook MCP headersHelper can run in the user runtime environment', async () => {
  const calls = [];
  const headers = await resolveHeaders('ccui-hook-mcp-notify', {
    url: 'https://example.com/mcp',
    headers: { 'X-Static': 'static' },
    headersHelper: 'python3 headers.py',
  }, async (request) => {
    calls.push(request);
    return { stdout: JSON.stringify({ Authorization: 'Bearer from-user-container' }) };
  });

  assert.deepEqual(headers, {
    'X-Static': 'static',
    Authorization: 'Bearer from-user-container',
  });
  assert.equal(calls[0].command, 'python3 headers.py');
  assert.equal(calls[0].env.CLAUDE_CODE_MCP_SERVER_NAME, 'ccui-hook-mcp-notify');
  assert.equal(calls[0].env.CLAUDE_CODE_MCP_SERVER_URL, 'https://example.com/mcp');
});
