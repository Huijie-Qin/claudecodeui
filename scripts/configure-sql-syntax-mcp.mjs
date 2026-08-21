const presetName = 'sql-syntax-checker';
const toolName = 'check_sql_syntax';
const qualifiedToolName = `mcp__${presetName}__${toolName}`;
const serverPort = Number(process.env.SERVER_PORT || 3001);
const presetUrl = String(
  process.env.CCUI_SQL_SYNTAX_MCP_URL
  || `http://host.docker.internal:${serverPort}/mcp/sql-syntax-check`,
);
const adminUsername = String(process.env.CCUI_ADMIN_USERNAME || 'root');

const [
  { db, userDb },
  { multitenancyDb },
  { mcpPresetService },
  { createWorkspaceMcpToolsService },
  { hookConfigService },
  { createHookRuntimeSession },
] = await Promise.all([
  import('../dist-server/server/database/db.js'),
  import('../dist-server/server/database/multitenancy-db.js'),
  import('../dist-server/server/services/mcp-presets.js'),
  import('../dist-server/server/services/workspace-mcp-tools.js'),
  import('../dist-server/server/services/hook-configs.js'),
  import('../dist-server/server/services/hook-runtime.js'),
]);

const admin = userDb.getUserByUsername(adminUsername);
if (!admin?.is_system_admin) throw new Error(`${adminUsername} is not a CCUI system administrator`);
const tenant = multitenancyDb.tenants.listTenants().find((item) => item.status === 'active');
if (!tenant) throw new Error('No active tenant is available');

const presetInput = {
  name: presetName,
  displayName: 'SQL 语法检查 MCP',
  description: '模拟 SQL 静态语法检查服务；只分析输入文本，不连接或执行任何数据库。',
  preinstallScope: 'all_workspaces',
  config: {
    type: 'http',
    url: presetUrl,
    timeout: 10_000,
  },
};

const existingPreset = mcpPresetService
  .listAdminPresets({ tenantId: tenant.id })
  .find((item) => item.name === presetName);
let preset;
if (existingPreset) {
  ({ preset } = await mcpPresetService.updatePreset({
    tenantId: tenant.id,
    presetId: existingPreset.id,
    userId: admin.id,
    input: presetInput,
  }));
} else {
  preset = mcpPresetService.createPreset({
    tenantId: tenant.id,
    userId: admin.id,
    input: presetInput,
  });
}

const tested = await mcpPresetService.testPreset({
  tenantId: tenant.id,
  presetId: preset.id,
  userId: admin.id,
});
if (tested.lastTestStatus !== 'healthy' || tested.toolCount < 1) {
  throw new Error(`SQL syntax MCP test failed: ${tested.lastTestError || 'no tools returned'}`);
}
preset = mcpPresetService.publishPreset({
  tenantId: tenant.id,
  presetId: preset.id,
  userId: admin.id,
});

const workspaceMcpTools = createWorkspaceMcpToolsService({ multitenancy: multitenancyDb });
const workspaces = multitenancyDb.workspaces.listActiveForTenant({ tenantId: tenant.id });
const installed = [];
for (const workspace of workspaces) {
  const result = await workspaceMcpTools.installWorkspaceMcpPreset({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    workspaceDisplayName: workspace.display_name,
    presetId: preset.id,
    userId: workspace.owner_user_id || admin.id,
  });
  installed.push(result.installed);
}

const sqlMetricsScript = [
  'export async function run(event, ccui) {',
  "  const message = String(event.last_assistant_message || '');",
  '  const snippets = [];',
  '  const fencedPattern = /```sql\\s*\\n?([\\s\\S]*?)```/gi;',
  '  let match;',
  '  while ((match = fencedPattern.exec(message)) !== null) {',
  '    if (match[1].trim()) snippets.push(match[1].trim());',
  '  }',
  '  const sqlStartPattern = /(?:^|\\n)\\s*(?:WITH|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE)\\b/i;',
  '  if (snippets.length === 0 && sqlStartPattern.test(message)) snippets.push(message.trim());',
  '  if (snippets.length === 0) {',
  '    return { output: { detected: false, sqlBlockCount: 0, sqlLineCount: 0, statementCount: 0 } };',
  '  }',
  '  const lines = snippets.flatMap((sql) => sql.split(/\\r?\\n/));',
  '  const statements = snippets.flatMap((sql) => sql.split(/;(?=\\s|$)/).map((part) => part.trim()).filter(Boolean));',
  '  const statementTypes = statements.map((statement) => {',
  "    const keyword = statement.match(/^(?:--[^\\n]*\\n\\s*)*(WITH|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE)\\b/i)?.[1] || 'UNKNOWN';",
  '    return keyword.toUpperCase();',
  '  });',
  '  const metrics = {',
  '    capturedAt: new Date().toISOString(),',
  '    sessionId: event.session_id || ccui.env.sessionId || null,',
  '    sqlBlockCount: snippets.length,',
  '    sqlLineCount: lines.length,',
  '    nonEmptySqlLineCount: lines.filter((line) => line.trim()).length,',
  '    statementCount: statements.length,',
  '    statementTypes,',
  '    characterCount: snippets.reduce((total, sql) => total + sql.length, 0),',
  '  };',
  "  await ccui.log.info('SQL response metrics calculated', metrics);",
  '  return { output: { detected: true, ...metrics } };',
  '}',
].join('\n');

const hookInput = {
  name: 'SQL 响应指标记录',
  description: '模型正常返回后检测 SQL；调用 MCP Tool 做模拟语法检查，并用“记录数据”保存统计指标，不在业务记录中保存 SQL 正文。',
  eventName: 'Stop',
  matcher: {},
  extensionLogic: {
    language: 'javascript',
    code: sqlMetricsScript,
    outputs: [
      { name: 'detected', type: 'boolean', description: '是否检测到 SQL' },
      { name: 'sqlBlockCount', type: 'number', description: 'SQL 代码块数量' },
      { name: 'sqlLineCount', type: 'number', description: 'SQL 总行数' },
      { name: 'nonEmptySqlLineCount', type: 'number', description: 'SQL 非空行数' },
      { name: 'statementCount', type: 'number', description: 'SQL 语句数量' },
      { name: 'statementTypes', type: 'array', description: 'SQL 语句类型' },
      { name: 'characterCount', type: 'number', description: 'SQL 字符数' },
      { name: 'capturedAt', type: 'string', description: '捕获时间' },
      { name: 'sessionId', type: 'string', description: '会话 ID' },
    ],
  },
  postActions: [
    {
      id: 'check-sql-syntax',
      type: 'call_mcp_tool',
      position: 0,
      config: {
        toolName: qualifiedToolName,
        condition: { source: 'reference', path: 'script.output.detected' },
        inputs: {
          sql: { source: 'reference', path: 'event.last_assistant_message' },
          dialect: { source: 'literal', value: 'generic' },
        },
      },
    },
    {
      id: 'record-sql-response-metrics',
      type: 'write_record',
      position: 1,
      config: {
        recordType: 'sql_response_metrics',
        condition: { source: 'reference', path: 'script.output.detected' },
        fields: {
          capturedAt: { source: 'reference', path: 'script.output.capturedAt' },
          sessionId: { source: 'reference', path: 'script.output.sessionId' },
          sqlBlockCount: { source: 'reference', path: 'script.output.sqlBlockCount' },
          sqlLineCount: { source: 'reference', path: 'script.output.sqlLineCount' },
          nonEmptySqlLineCount: { source: 'reference', path: 'script.output.nonEmptySqlLineCount' },
          statementCount: { source: 'reference', path: 'script.output.statementCount' },
          statementTypes: { source: 'reference', path: 'script.output.statementTypes' },
          characterCount: { source: 'reference', path: 'script.output.characterCount' },
        },
      },
    },
  ],
  claudeResponse: { bindings: {} },
};

const existingHook = hookConfigService.listHooks().find((hook) => hook.name === hookInput.name);
const savedHook = existingHook
  ? hookConfigService.updateHook({ hookId: existingHook.id, input: hookInput, userId: admin.id })
  : hookConfigService.createHook({ input: hookInput, userId: admin.id });
hookConfigService.publishHook({ hookId: savedHook.id, userId: admin.id, validatedSkills: [] });
const activeHook = hookConfigService.replaceHookBindings({
  hookId: savedHook.id,
  userIds: [admin.id],
  boundBy: admin.id,
}).hook;

const verificationWorkspace = workspaces[0];
if (!verificationWorkspace) throw new Error('No active workspace is available for Hook verification');
const runtime = createHookRuntimeSession({
  hooks: [activeHook],
  userId: admin.id,
  username: admin.username,
  tenantId: tenant.id,
  workspaceId: verificationWorkspace.id,
  workspaceRoot: verificationWorkspace.path,
  mcpServers: { [presetName]: preset.config },
});
await runtime.executeHook(activeHook, {
  hook_event_name: 'Stop',
  session_id: 'verification-sql-syntax-mcp-valid',
  last_assistant_message: '```sql\nSELECT id, username FROM users;\n```',
});
await runtime.executeHook(activeHook, {
  hook_event_name: 'Stop',
  session_id: 'verification-sql-syntax-mcp-invalid',
  last_assistant_message: '```sql\nSELECT id, FROM users WHERE (;\n```',
});
await runtime.executeHook(activeHook, {
  hook_event_name: 'Stop',
  session_id: 'verification-sql-syntax-mcp-skipped',
  last_assistant_message: 'No SQL in this answer.',
});

const verificationExecutions = hookConfigService
  .listExecutions(activeHook.id, { limit: 20 })
  .filter((execution) => execution.sessionId?.startsWith('verification-sql-syntax-mcp-'));
const resultsBySession = Object.fromEntries(verificationExecutions.map((execution) => [
  execution.sessionId,
  {
    status: execution.status,
    syntaxCheck: execution.actions?.['check-sql-syntax']?.output,
    metricsRecord: execution.actions?.['record-sql-response-metrics']?.output,
  },
]));

console.log(JSON.stringify({
  preset: {
    id: preset.id,
    name: preset.name,
    status: preset.status,
    testStatus: preset.lastTestStatus,
    toolCount: preset.toolCount,
    toolName: qualifiedToolName,
    url: preset.config.url,
    preinstallScope: preset.preinstallScope,
  },
  installed,
  hook: {
    id: activeHook.id,
    name: activeHook.name,
    status: activeHook.status,
    boundUserCount: activeHook.boundUserCount,
    postActions: activeHook.postActions.map((action) => ({ id: action.id, type: action.type })),
  },
  verification: resultsBySession,
}, null, 2));

db.pragma('wal_checkpoint(PASSIVE)');
