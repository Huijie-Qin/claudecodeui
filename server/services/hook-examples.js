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

export const REQUESTED_HOOK_EXAMPLES = Object.freeze([
  {
    id: 'sql-check-enforcement',
    name: '示例 · SQL Check 强制校验',
    description: '检测模型输出中的 SQL 并调用 MCP Tool 做语法校验；请先选择 SQL 检查 MCP Tool 并映射工具入参，再发布。',
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
          toolName: '',
          condition: { source: 'reference', path: 'script.output.detected' },
          inputs: {},
        },
      },
    ],
    claudeResponse: { bindings: {} },
  },
  {
    id: 'sql-line-record',
    name: '示例 · SQL 行数记录',
    description: '检测模型输出中的 SQL，并将 SQL 行数、语句数等指标写入 Hook 数据记录；不调用 SQL 检查 MCP。',
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
    name: '示例 · 对话正常结束通知',
    description: '正常结束后调用通知 Skill；请先上传或选择内置 Hook Skill，再发布。',
    eventName: 'Stop',
    matcher: {},
    extensionLogic: null,
    postActions: [{
      id: 'notify-normal-stop',
      type: 'invoke_skill',
      position: 0,
      config: {
        skillId: '',
        skillName: '',
        argumentsTemplate: 'status=success event=Stop session={{ccui.env.sessionId}}',
      },
    }],
    claudeResponse: { bindings: {} },
  },
  {
    id: 'http-200-error-recovery',
    name: '示例 · HTTP 200 错误恢复',
    description: '失败结束后调用恢复 Skill；Skill 应在错误详情包含 HTTP 200 时恢复原会话并重试。请先选择 Skill，再发布。',
    eventName: 'StopFailure',
    matcher: {},
    extensionLogic: null,
    postActions: [{
      id: 'notify-failure-and-recover',
      type: 'invoke_skill',
      position: 0,
      config: {
        skillId: '',
        skillName: '',
        argumentsTemplate: 'status=failure event=StopFailure session={{ccui.env.sessionId}} error={{event.error}} details={{event.error_details}}',
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
