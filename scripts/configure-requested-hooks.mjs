import crypto from 'node:crypto';

const baseUrl = String(process.env.CCUI_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const username = String(process.env.CCUI_ADMIN_USERNAME || 'root');
const gitEmail = String(process.env.CCUI_ADMIN_EMAIL || 'admin@ccui.local');
let password = String(process.env.CCUI_ADMIN_PASSWORD || '');

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${payload.error || payload.message || 'unknown error'}`);
  }
  return payload;
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

const hooks = [
  {
    name: 'SQL 响应指标记录',
    description: '模型正常返回后检测 SQL；调用管理员已配置的 MCP Tool 检查语法，并用“记录数据”保存统计指标，不在业务记录中保存 SQL 正文。',
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
          toolName: 'mcp__sql-syntax-checker__check_sql_syntax',
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
  },
  {
    name: '对话正常结束通知',
    description: '正常结束时调用 CCUI 内置模拟通知 Skill，并写入可验证的本地通知记录。',
    eventName: 'Stop',
    matcher: {},
    extensionLogic: null,
    postActions: [{
      id: 'notify-normal-stop',
      type: 'invoke_skill',
      position: 0,
      config: {
        skillId: 'builtin:hook-notification',
        skillName: 'hook-notification',
        argumentsTemplate: 'status=success event=Stop session={{ccui.env.sessionId}}',
      },
    }],
    claudeResponse: { bindings: {} },
  },
  {
    name: '失败通知与 HTTP 200 会话恢复',
    description: '失败结束时调用通知 Skill；当错误详情包含 HTTP 200 时，在原 session 追加恢复回合并重试上一请求。',
    eventName: 'StopFailure',
    matcher: {},
    extensionLogic: null,
    postActions: [{
      id: 'notify-failure-and-recover',
      type: 'invoke_skill',
      position: 0,
      config: {
        skillId: 'builtin:hook-notification',
        skillName: 'hook-notification',
        argumentsTemplate: 'status=failure event=StopFailure session={{ccui.env.sessionId}} error={{event.error}} details={{event.error_details}}',
      },
    }],
    claudeResponse: { bindings: {} },
  },
];

if (process.argv.includes('--direct-database')) {
  const [{ db }, { hookConfigService }, { createHookSkillCatalogService }] = await Promise.all([
    import('../dist-server/server/database/db.js'),
    import('../dist-server/server/services/hook-configs.js'),
    import('../dist-server/server/services/hook-skill-catalog.js'),
  ]);
  const admin = db.prepare('SELECT id, username, is_system_admin FROM users WHERE username = ?').get(username);
  if (!admin?.is_system_admin) throw new Error(`${username} is not a CCUI system administrator`);
  const catalog = createHookSkillCatalogService();
  const existing = hookConfigService.listHooks();
  const byName = new Map(existing.map((hook) => [hook.name, hook]));
  const configured = [];
  for (const input of hooks) {
    const current = byName.get(input.name);
    const saved = current
      ? hookConfigService.updateHook({ hookId: current.id, input, userId: admin.id })
      : hookConfigService.createHook({ input, userId: admin.id });
    const validatedSkills = await catalog.validateHookSkills({ hook: saved });
    hookConfigService.publishHook({ hookId: saved.id, userId: admin.id, validatedSkills });
    const binding = hookConfigService.replaceHookBindings({
      hookId: saved.id,
      userIds: [admin.id],
      boundBy: admin.id,
    });
    const activeHook = binding.hook;
    configured.push({
      id: activeHook.id,
      name: activeHook.name,
      eventName: activeHook.eventName,
      status: activeHook.status,
      boundUserCount: activeHook.boundUserCount,
    });
  }
  const settings = hookConfigService.getSettings();
  const visibleEvents = [...new Set([...(settings.visibleEvents || []), 'Stop', 'StopFailure'])];
  hookConfigService.updateSettings({ visibleEvents });
  console.log(JSON.stringify({ admin: { username }, hooks: configured, visibleEvents }, null, 2));
  process.exit(0);
}

const authStatus = await request('/api/auth/status');
let auth;
let generatedPassword = false;
if (authStatus.needsSetup) {
  if (!password) {
    password = `CCUI-${crypto.randomBytes(18).toString('base64url')}!`;
    generatedPassword = true;
  }
  auth = await request('/api/auth/register', {
    method: 'POST',
    body: { username, password, gitEmail },
  });
} else {
  if (!password) throw new Error('CCUI already has users; set CCUI_ADMIN_PASSWORD to update Hooks through Admin APIs');
  auth = await request('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
}

if (!auth.user?.is_system_admin) throw new Error(`${username} is not a CCUI system administrator`);
const token = auth.token;
const existing = await request('/api/admin/hooks', { token });
const byName = new Map((existing.hooks || []).map((hook) => [hook.name, hook]));
const configured = [];

for (const input of hooks) {
  const current = byName.get(input.name);
  const saved = current
    ? await request(`/api/admin/hooks/${current.id}`, { method: 'PUT', token, body: input })
    : await request('/api/admin/hooks', { method: 'POST', token, body: input });
  const published = await request(`/api/admin/hooks/${saved.hook.id}/publish`, { method: 'POST', token });
  const binding = await request(`/api/admin/hooks/${published.hook.id}/bindings`, {
    method: 'PUT',
    token,
    body: { userIds: [auth.user.id] },
  });
  const activeHook = binding.hook;
  configured.push({
    id: activeHook.id,
    name: activeHook.name,
    eventName: activeHook.eventName,
    status: activeHook.status,
    boundUserCount: activeHook.boundUserCount,
  });
}

const settings = await request('/api/admin/hooks/settings', { token });
const visibleEvents = [...new Set([...(settings.visibleEvents || []), 'Stop', 'StopFailure'])];
await request('/api/admin/hooks/settings', { method: 'PUT', token, body: { visibleEvents } });

console.log(JSON.stringify({
  admin: {
    username,
    ...(generatedPassword ? { generatedPassword: password } : {}),
  },
  hooks: configured,
  visibleEvents,
}, null, 2));
