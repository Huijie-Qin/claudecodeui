import assert from 'node:assert/strict';
import test from 'node:test';

import { callHookMcpTool, resolveHostRuntimeMcpUrl } from './hook-mcp-client.js';
import {
  SQL_SYNTAX_MCP_TOOL_NAME,
  checkSqlSyntax,
  createSqlSyntaxMcpServer,
  extractSqlForSyntaxCheck,
} from './sql-syntax-mcp-server.js';

test('simulated SQL syntax checker accepts structurally valid SQL', () => {
  const result = checkSqlSyntax('SELECT id,\n       username\nFROM users;', 'sqlite');
  assert.equal(result.valid, true);
  assert.equal(result.statementCount, 1);
  assert.equal(result.dialect, 'sqlite');
  assert.deepEqual(result.issues, []);
});

test('simulated SQL syntax checker reports common structural errors', () => {
  const result = checkSqlSyntax('SELECT id, FROM users WHERE (');
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((entry) => entry.code === 'trailing_comma'));
  assert.ok(result.issues.some((entry) => entry.code === 'unclosed_parenthesis'));
});

test('simulated SQL syntax checker extracts fenced SQL from a model response', () => {
  const sql = extractSqlForSyntaxCheck('查询如下：\n```sql\nSELECT id FROM users;\n```');
  assert.equal(sql, 'SELECT id FROM users;');
  assert.equal(checkSqlSyntax(sql).valid, true);
});

test('Hook MCP client performs a real HTTP call to the simulated SQL checker', async () => {
  const server = createSqlSyntaxMcpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    const output = await callHookMcpTool({
      qualifiedToolName: `mcp__sql-syntax-checker__${SQL_SYNTAX_MCP_TOOL_NAME}`,
      input: { sql: 'SELECT 1;', dialect: 'generic', rule_ids: ['limit_rows'] },
      mcpServers: {
        'sql-syntax-checker': {
          type: 'http',
          url: `http://host.docker.internal:${address.port}`,
        },
      },
      cwd: process.cwd(),
    });
    assert.equal(output.valid, true);
    assert.equal(output.checker, 'ccui-simulated-sql-syntax-checker');
    assert.equal(output.statementCount, 1);
    assert.deepEqual(output.ruleIds, ['limit_rows']);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('Hook MCP host URL normalization leaves ordinary remote servers unchanged', () => {
  assert.equal(
    resolveHostRuntimeMcpUrl('sql-syntax-checker', 'https://mcp.example.com/tools').toString(),
    'https://mcp.example.com/tools',
  );
  assert.equal(
    resolveHostRuntimeMcpUrl('custom-host-service', 'http://host.docker.internal:4500/mcp').toString(),
    'http://host.docker.internal:4500/mcp',
  );
});
