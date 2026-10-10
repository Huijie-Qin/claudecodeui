import { REPORT_QUALITY_HOOK_EXAMPLE } from './report-quality-hook.js';

const SQL_EXTRACTION_SCRIPT_LINES = [
  "  const sqlKeywords = '(?:WITH|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|REPLACE|UPSERT|TRUNCATE|EXPLAIN|SHOW|DESCRIBE|PRAGMA|GRANT|REVOKE|CALL|EXECUTE|VALUES|VACUUM)';",
  "  const sqlStartPattern = new RegExp('^\\\\s*' + sqlKeywords + '\\\\b', 'i');",
  '  const stripLeadingComments = (value) => {',
  "    let text = String(value || '').replace(/^\\uFEFF/, '').trim();",
  '    let previous;',
  '    do {',
  '      previous = text;',
  "      text = text.replace(/^--[^\\r\\n]*(?:\\r?\\n|$)/, '').replace(/^\\/\\*[\\s\\S]*?\\*\\//, '').trimStart();",
  '    } while (text !== previous);',
  '    return text;',
  '  };',
  '  const looksLikeSql = (value) => sqlStartPattern.test(stripLeadingComments(value));',
  '  const snippets = [];',
  '  const seenSnippets = new Set();',
  '  const addSnippet = (value) => {',
  "    const normalized = String(value || '').trim();",
  '    if (!normalized || seenSnippets.has(normalized)) return;',
  '    seenSnippets.add(normalized);',
  '    snippets.push(normalized);',
  '  };',
  '  const visitJson = (value, key = "", depth = 0) => {',
  '    if (depth > 10 || value == null) return;',
  "    if (typeof value === 'string') {",
  '      if (/(?:sql|query|statement)/i.test(key) && looksLikeSql(value)) addSnippet(value);',
  '      return;',
  '    }',
  '    if (Array.isArray(value)) {',
  '      value.forEach((entry) => visitJson(entry, key, depth + 1));',
  '      return;',
  '    }',
  "    if (typeof value === 'object') {",
  '      Object.entries(value).forEach(([childKey, entry]) => visitJson(entry, childKey, depth + 1));',
  '    }',
  '  };',
  '  const extractJsonSql = (value) => {',
  '    try {',
  '      visitJson(JSON.parse(String(value || "").trim()));',
  '      return true;',
  '    } catch {',
  '      return false;',
  '    }',
  '  };',
  '  let match;',
  '  const dialectFencePattern = /```(?:sql|mysql|mariadb|postgres(?:ql)?|sqlite|tsql|plsql|hive|sparksql|bigquery|snowflake|redshift|oracle)\\b[^\\r\\n]*\\r?\\n([\\s\\S]*?)```/gi;',
  '  while ((match = dialectFencePattern.exec(message)) !== null) addSnippet(match[1]);',
  '  const jsonFencePattern = /```json\\b[^\\r\\n]*\\r?\\n([\\s\\S]*?)```/gi;',
  '  while ((match = jsonFencePattern.exec(message)) !== null) extractJsonSql(match[1]);',
  '  const unlabeledFencePattern = /```[ \\t]*\\r?\\n([\\s\\S]*?)```/g;',
  '  while ((match = unlabeledFencePattern.exec(message)) !== null) {',
  '    if (looksLikeSql(match[1])) addSnippet(match[1]);',
  '    else extractJsonSql(match[1]);',
  '  }',
  '  const xmlSqlPattern = /<sql(?:\\s[^>]*)?>([\\s\\S]*?)<\\/sql>/gi;',
  '  while ((match = xmlSqlPattern.exec(message)) !== null) {',
  '    if (looksLikeSql(match[1])) addSnippet(match[1]);',
  '  }',
  '  const trimmedMessage = message.trim();',
  "  if (trimmedMessage.startsWith('{') || trimmedMessage.startsWith('[')) {",
  '    extractJsonSql(trimmedMessage);',
  '  }',
  "  const withoutBlocks = message.replace(/```[\\s\\S]*?```/g, '\\n').replace(/<sql(?:\\s[^>]*)?>[\\s\\S]*?<\\/sql>/gi, '\\n');",
  "  const inlineSource = withoutBlocks.replace(/(^|[^`])`([^`\\r\\n]+)`(?!`)/g, (whole, prefix, content) => {",
  '    if (looksLikeSql(content)) addSnippet(content);',
  "    return prefix + ' ';",
  '  });',
  '  const rawLines = inlineSource.split(/\\r?\\n/);',
  '  for (let index = 0; index < rawLines.length; index += 1) {',
  "    let firstLine = rawLines[index].replace(/^\\s*(?:(?:[-*+]|>|\\d+[.)])\\s+)*/, '').trimStart();",
  "    firstLine = firstLine.replace(/^(?:SQL(?:\\s+(?:query|statement))?|查询(?:语句)?)(?:如下)?\\s*[:：]\\s*/i, '');",
  '    if (!looksLikeSql(firstLine)) continue;',
  '    const block = [firstLine];',
  '    let nextIndex = index + 1;',
  '    while (nextIndex < rawLines.length && rawLines[nextIndex].trim()) {',
  "      block.push(rawLines[nextIndex].replace(/^\\s*>\\s?/, ''));",
  '      nextIndex += 1;',
  '    }',
  "    addSnippet(block.join('\\n'));",
  '    index = nextIndex;',
  '  }',
];

const SQL_METRICS_SCRIPT = [
  'export async function run(event, ccui) {',
  "  const message = String(event.last_assistant_message || '');",
  ...SQL_EXTRACTION_SCRIPT_LINES,
  '  if (snippets.length === 0) {',
  '    return { output: { detected: false, sqlBlockCount: 0, sqlLineCount: 0, statementCount: 0 } };',
  '  }',
  '  const lines = snippets.flatMap((sql) => sql.split(/\\r?\\n/));',
  "  const statementBoundary = new RegExp(';\\\\s*(?=' + sqlKeywords + '\\\\b|$)', 'i');",
  '  const statements = snippets.flatMap((sql) => sql.split(statementBoundary).map((part) => part.trim()).filter(Boolean));',
  '  const statementTypes = statements.map((statement) => {',
  "    const keyword = stripLeadingComments(statement).match(new RegExp('^(' + sqlKeywords.slice(3, -1) + ')\\\\b', 'i'))?.[1] || 'UNKNOWN';",
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
  "  if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'Write') {",
  "    return { output: { detected: false, sql: '' } };",
  '  }',
  "  if (typeof event.tool_input?.content !== 'string') throw new Error('Write content must be a string');",
  '  const message = event.tool_input.content;',
  "  if (/\\.sql$/i.test(String(event.tool_input.file_path || ''))) return { output: { detected: Boolean(message.trim()), sql: message.trim() } };",
  ...SQL_EXTRACTION_SCRIPT_LINES,
  "  return { output: { detected: snippets.length > 0, sql: snippets.join('\\n\\n') } };",
  '}',
].join('\n');

const HTTP_200_RECOVERY_SCRIPT = [
  'export async function run(event) {',
  "  const details = String(event.error_details || '');",
  "  return { output: { shouldRecover: details.includes('HTTP 200') } };",
  '}',
].join('\n');

// Replace both paths and the field checks when adapting this draft to a real deliverable.
const REPORT_DATA_VALIDATION_SCRIPT = [
  'export async function run(_event, ccui) {',
  "  const reportPath = 'reports/report.html';",
  "  const dataPath = 'data/metrics.json';",
  '  const issues = [];',
  '  const evidence = { reportPath, dataPath, reportExists: false, dataExists: false, checkedMetricRows: 0 };',
  '  try {',
  '    evidence.reportExists = await ccui.workspace.exists(reportPath);',
  "    if (!evidence.reportExists) issues.push('缺少报告文件：' + reportPath);",
  '  } catch (error) {',
  "    issues.push('无法检查报告文件：' + String(error?.message || error));",
  '  }',
  '  try {',
  '    evidence.dataExists = await ccui.workspace.exists(dataPath);',
  "    if (!evidence.dataExists) issues.push('缺少数据文件：' + dataPath);",
  '  } catch (error) {',
  "    issues.push('无法检查数据文件：' + String(error?.message || error));",
  '  }',
  '  if (evidence.dataExists) {',
  '    try {',
  '      const data = await ccui.workspace.readJson(dataPath);',
  '      if (!data || typeof data !== "object" || Array.isArray(data)) {',
  "        issues.push('数据根节点必须是对象');",
  '      } else {',
  "        if (typeof data.period !== 'string' || !data.period.trim()) issues.push('period 必须是非空字符串');",
  '        if (!Array.isArray(data.metrics) || data.metrics.length === 0) {',
  "          issues.push('metrics 必须是非空数组');",
  '        } else {',
  '          evidence.checkedMetricRows = data.metrics.length;',
  '          const names = new Set();',
  '          for (let index = 0; index < data.metrics.length; index += 1) {',
  '            const row = data.metrics[index];',
  '            const prefix = "metrics[" + index + "]";',
  '            if (!row || typeof row !== "object" || Array.isArray(row)) {',
  "              if (issues.length < 20) issues.push(prefix + ' 必须是对象');",
  '              continue;',
  '            }',
  "            if (typeof row.name !== 'string' || !row.name.trim()) {",
  "              if (issues.length < 20) issues.push(prefix + '.name 必须是非空字符串');",
  '            } else if (names.has(row.name.trim())) {',
  "              if (issues.length < 20) issues.push(prefix + '.name 重复：' + row.name.trim());",
  '            } else names.add(row.name.trim());',
  "            if (typeof row.value !== 'number' || !Number.isFinite(row.value)) {",
  "              if (issues.length < 20) issues.push(prefix + '.value 必须是有限数字');",
  '            }',
  "            if (typeof row.unit !== 'string' || !row.unit.trim()) {",
  "              if (issues.length < 20) issues.push(prefix + '.unit 必须是非空字符串');",
  '            }',
  '          }',
  '        }',
  '      }',
  '    } catch (error) {',
  "      issues.push('数据文件无法读取或不是合法 JSON：' + String(error?.message || error));",
  '    }',
  '  }',
  '  return { output: { validation: { passed: issues.length === 0, issues, evidence } } };',
  '}',
].join('\n');

const SQL_CHECK_TOOL_NAME = 'mcp__sql-syntax-checker__check_sql_syntax';
const NOTIFICATION_SKILL_ID = 'builtin:hook-notification';
const NOTIFICATION_SKILL_NAME = 'hook-notification';

export const REQUESTED_HOOK_EXAMPLES = Object.freeze([
  {
    id: 'sql-check-enforcement',
    name: 'SQL Check 强制校验',
    description: 'Write 写入前使用当前项目规则校验 SQL；校验不通过或服务异常时拒绝写入。',
    eventName: 'PreToolUse',
    includeSubagents: false,
    matcher: { value: '^Write$' },
    extensionLogic: {
      language: 'javascript',
      code: SQL_DETECTION_SCRIPT,
      failClosed: true,
      outputs: [
        { name: 'detected', type: 'boolean' },
        { name: 'sql', type: 'string' },
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
            sql: { source: 'reference', path: 'script.output.sql' },
            dialect: { source: 'literal', value: 'generic' },
            rule_ids: { source: 'reference', path: 'ccui.env.sqlCheckRuleIds' },
          },
        },
      },
    ],
    claudeResponse: { bindings: {
      'hookSpecificOutput.permissionDecision': { source: 'reference', path: 'actions.check-sql-syntax.output.permissionDecision' },
      'hookSpecificOutput.permissionDecisionReason': { source: 'reference', path: 'actions.check-sql-syntax.output.permissionDecisionReason' },
    } },
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
        { name: 'detected', type: 'boolean' },
        { name: 'sqlBlockCount', type: 'number' },
        { name: 'sqlLineCount', type: 'number' },
        { name: 'nonEmptySqlLineCount', type: 'number' },
        { name: 'statementCount', type: 'number' },
        { name: 'statementTypes', type: 'array' },
        { name: 'characterCount', type: 'number' },
        { name: 'capturedAt', type: 'string' },
        { name: 'sessionId', type: 'string' },
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
    id: 'independent-completion-review',
    name: '独立模型任务完成度复核',
    description: '主代理准备结束时，由全新会话的审查模型依据任务与执行证据判断是否完成；未完成则让原主循环继续。可按需填写验收标准和交付物路径。',
    eventName: 'Stop',
    includeSubagents: false,
    matcher: {},
    extensionLogic: null,
    postActions: [{
      id: 'review-main-task-completion',
      type: 'review_completion',
      position: 0,
      config: { maxReviews: 3, model: '', criteria: '', artifactPaths: [] },
    }],
    claudeResponse: { bindings: {} },
  },
  {
    id: 'report-data-deliverable-review',
    name: '报告与数据交付验收（程序校验示例）',
    description: '先用 Hook 脚本检查示例 JSON 字段和交付文件，再由独立模型核对报告内容；发布前请修改路径和字段要求。',
    eventName: 'Stop',
    includeSubagents: false,
    matcher: {},
    extensionLogic: {
      language: 'javascript',
      code: REPORT_DATA_VALIDATION_SCRIPT,
      outputs: [{ name: 'validation', type: 'object' }],
    },
    postActions: [{
      id: 'review-report-data-deliverables',
      type: 'review_completion',
      position: 0,
      config: {
        maxReviews: 3,
        model: '',
        criteria: [
          '以当前用户任务为准，实际读取 reports/report.html 和 data/metrics.json 后再判断。确认报告覆盖用户要求的章节、结论和数据说明，不存在占位文字或缺失模块。',
          '结合程序校验结果，核对报告中的 period、指标名称、数值和单位与 data/metrics.json 是否一致；程序校验仅检查示例 JSON 结构，不代表内容一致。',
          '只有证据覆盖全部明确要求时才通过；缺少文件、无法读取或无法核实的项目要列出具体缺口与下一步。不要仅凭主代理的完成声明通过。',
        ].join('\n'),
        artifactPaths: ['reports/report.html', 'data/metrics.json'],
        validationResultPath: 'script.output.validation',
      },
    }],
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
        { name: 'shouldRecover', type: 'boolean' },
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
  REPORT_QUALITY_HOOK_EXAMPLE,
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
