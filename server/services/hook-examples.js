const SQL_METRICS_SCRIPT = [
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

const SQL_DETECTION_SCRIPT = [
  'export async function run(event) {',
  "  const message = String(event.last_assistant_message || '');",
  '  const fencedSql = /```sql\\s*\\n?[\\s\\S]*?```/i.test(message);',
  '  const inlineSql = /(?:^|\\n)\\s*(?:WITH|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE)\\b/i.test(message);',
  '  return { output: { detected: fencedSql || inlineSql } };',
  '}',
].join('\n');

const HTTP_200_RECOVERY_SCRIPT = [
  'export async function run(event) {',
  "  const details = String(event.error_details || '');",
  "  return { output: { shouldRecover: details.includes('HTTP 200') } };",
  '}',
].join('\n');

const SQL_CHECK_TOOL_NAME = 'mcp__sql-syntax-checker__check_sql_syntax';
const NOTIFICATION_SKILL_ID = 'builtin:hook-notification';
const NOTIFICATION_SKILL_NAME = 'hook-notification';

export const REQUESTED_HOOK_EXAMPLES = Object.freeze([
  {
    id: 'sql-check-enforcement',
    name: 'SQL Check 强制校验',
    description: '检测模型输出中的 SQL，并调用 SQL Check MCP Tool 执行强制语法校验。',
    eventName: 'Stop',
    matcher: {},
    extensionLogic: {
      language: 'javascript',
      code: SQL_DETECTION_SCRIPT,
      outputs: [
        { name: 'detected', type: 'boolean', description: '是否检测到 SQL' },
      ],
    },
    postActions: [
      {
        id: 'check-sql-syntax',
        type: 'call_mcp_tool',
        position: 0,
        config: {
          toolName: SQL_CHECK_TOOL_NAME,
          condition: { source: 'reference', path: 'script.output.detected' },
          inputs: {
            sql: { source: 'reference', path: 'event.last_assistant_message' },
            dialect: { source: 'literal', value: 'generic' },
          },
        },
      },
    ],
    claudeResponse: { bindings: {} },
  },
  {
    id: 'sql-line-record',
    name: 'SQL 行数记录',
    description: '检测模型输出中的 SQL，并将 SQL 行数、语句数等指标写入 Hook 业务数据；不调用 SQL 检查 MCP。',
    eventName: 'Stop',
    matcher: {},
    extensionLogic: {
      language: 'javascript',
      code: SQL_METRICS_SCRIPT,
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
        id: 'record-sql-response-metrics',
        type: 'write_record',
        position: 0,
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
    id: 'normal-end-notification',
    name: '对话正常结束通知',
    description: '回答正常结束后调用内置通知 Skill，写入可验证的本地通知记录。',
    eventName: 'Stop',
    matcher: {},
    extensionLogic: null,
    postActions: [{
      id: 'notify-normal-stop',
      type: 'invoke_skill',
      position: 0,
      config: {
        skillId: NOTIFICATION_SKILL_ID,
        skillName: NOTIFICATION_SKILL_NAME,
        condition: null,
        argumentsTemplate: 'status=success event=Stop session={{ccui.env.sessionId}}',
      },
    }],
    claudeResponse: { bindings: {} },
  },
  {
    id: 'failure-notification',
    name: '失败通知',
    description: '回答异常结束后调用内置通知 Skill；仅记录失败通知，不触发会话恢复。',
    eventName: 'StopFailure',
    matcher: {},
    extensionLogic: null,
    postActions: [{
      id: 'notify-failure',
      type: 'invoke_skill',
      position: 0,
      config: {
        skillId: NOTIFICATION_SKILL_ID,
        skillName: NOTIFICATION_SKILL_NAME,
        condition: null,
        argumentsTemplate: 'status=failure event=StopFailure session={{ccui.env.sessionId}} error={{event.error}}',
      },
    }],
    claudeResponse: { bindings: {} },
  },
  {
    id: 'http-200-session-recovery',
    name: 'HTTP 200 会话恢复',
    description: '仅当错误详情包含 HTTP 200 时调用内置 Skill，在原会话追加恢复回合并重试上一请求。',
    eventName: 'StopFailure',
    matcher: {},
    extensionLogic: {
      language: 'javascript',
      code: HTTP_200_RECOVERY_SCRIPT,
      outputs: [
        { name: 'shouldRecover', type: 'boolean', description: '是否为 HTTP 200 异常' },
      ],
    },
    postActions: [{
      id: 'recover-http-200-session',
      type: 'invoke_skill',
      position: 0,
      config: {
        skillId: NOTIFICATION_SKILL_ID,
        skillName: NOTIFICATION_SKILL_NAME,
        condition: { source: 'reference', path: 'script.output.shouldRecover' },
        argumentsTemplate: 'status=failure recovery=http-200 event=StopFailure session={{ccui.env.sessionId}} error={{event.error}} details={{event.error_details}}',
      },
    }],
    claudeResponse: { bindings: {} },
  },
]);

function cloneExample(example) {
  const { id: _id, ...hookInput } = example;
  return JSON.parse(JSON.stringify(hookInput));
}

export function listRequestedHookExamples({ hookConfigs }) {
  const existingNames = new Set(hookConfigs.listHooks().map((hook) => hook.name));
  return REQUESTED_HOOK_EXAMPLES.map((example) => ({
    id: example.id,
    name: example.name,
    description: example.description,
    eventName: example.eventName,
    exists: existingNames.has(example.name),
  }));
}

export function createRequestedHookExamples({ hookConfigs, userId, exampleIds }) {
  const requestedIds = Array.isArray(exampleIds)
    ? [...new Set(exampleIds.filter((id) => typeof id === 'string'))]
    : [];
  if (requestedIds.length === 0) {
    const error = new Error('Select at least one Hook example');
    error.statusCode = 400;
    throw error;
  }

  const examplesById = new Map(REQUESTED_HOOK_EXAMPLES.map((example) => [example.id, example]));
  const unknownIds = requestedIds.filter((id) => !examplesById.has(id));
  if (unknownIds.length > 0) {
    const error = new Error(`Unknown Hook example: ${unknownIds.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  const selectedExamples = requestedIds.map((id) => examplesById.get(id));
  const existingByName = new Map(hookConfigs.listHooks().map((hook) => [hook.name, hook]));
  const created = [];
  const skipped = [];

  for (const example of selectedExamples) {
    const existing = existingByName.get(example.name);
    if (existing) {
      skipped.push(existing);
      continue;
    }
    const hook = hookConfigs.createHook({ input: cloneExample(example), userId });
    created.push(hook);
    existingByName.set(hook.name, hook);
  }

  const settings = hookConfigs.getSettings();
  const visibleEvents = [...new Set([
    ...(settings.visibleEvents || []),
    ...selectedExamples.map((example) => example.eventName),
  ])];
  hookConfigs.updateSettings({ visibleEvents });

  return {
    hooks: [...created, ...skipped],
    createdCount: created.length,
    skippedCount: skipped.length,
    visibleEvents,
  };
}
