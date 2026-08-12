import { db, appConfigDb } from '../server/database/db.js';
import {
  HOOK_EVENTS,
  allowedClaudeOutputs,
  allowedPostActions,
  createHookConfigService,
} from '../server/services/hook-configs.js';

const PREFIX = '[Hook全量测试]';
const TEST_SKILL_NAME = 'hook-matrix-recovery';

const SCRIPT_OUTPUTS = Object.freeze([
  { name: 'eventName', type: 'string', description: '本次触发的 Hook 事件名称' },
  { name: 'userId', type: 'number', description: '当前 CCUI 用户 ID' },
  { name: 'text', type: 'string', description: '工作区文本文件读写结果' },
  { name: 'json', type: 'object', description: '工作区 JSON 文件读写结果' },
  { name: 'exists', type: 'boolean', description: '工作区文件是否存在' },
  { name: 'entries', type: 'array', description: '工作区目录内容' },
]);

const JAVASCRIPT_SCRIPT = `export async function run(event, ccui) {
  const base = '.ccui-hook-test/' + event.hook_event_name + '-javascript';
  await ccui.workspace.writeText(base + '.txt', event.hook_event_name);
  const text = await ccui.workspace.readText(base + '.txt');
  await ccui.workspace.writeJson(base + '.json', { eventName: event.hook_event_name, language: 'javascript' });
  const json = await ccui.workspace.readJson(base + '.json');
  const exists = await ccui.workspace.exists(base + '.txt');
  const entries = await ccui.workspace.list('.ccui-hook-test');
  await ccui.records.write('hook_matrix_javascript', { eventName: event.hook_event_name, userId: ccui.env.userId });
  await ccui.log.info('JavaScript 全量测试执行完成', { eventName: event.hook_event_name });
  return { output: { eventName: event.hook_event_name, userId: ccui.env.userId, text, json, exists, entries } };
}`;

const PYTHON_SCRIPT = `async def run(event, ccui):
    base = ".ccui-hook-test/" + event["hook_event_name"] + "-python"
    await ccui.workspace.write_text(base + ".txt", event["hook_event_name"])
    text = await ccui.workspace.read_text(base + ".txt")
    await ccui.workspace.write_json(base + ".json", {"eventName": event["hook_event_name"], "language": "python"})
    json_value = await ccui.workspace.read_json(base + ".json")
    exists = await ccui.workspace.exists(base + ".txt")
    entries = await ccui.workspace.list(".ccui-hook-test")
    await ccui.records.write("hook_matrix_python", {"eventName": event["hook_event_name"], "userId": ccui.env.userId})
    await ccui.log.info("Python 全量测试执行完成", {"eventName": event["hook_event_name"]})
    return {"output": {"eventName": event["hook_event_name"], "userId": ccui.env.userId, "text": text, "json": json_value, "exists": exists, "entries": entries}}`;

const OUTPUT_VALUES = Object.freeze({
  continue: true,
  stopReason: '全量测试：停止原因',
  suppressOutput: true,
  systemMessage: '全量测试：系统消息',
  decision: 'approve',
  reason: '全量测试：流程决策原因',
  'hookSpecificOutput.additionalContext': '全量测试：追加给 Claude 的上下文',
  'hookSpecificOutput.initialUserMessage': '全量测试：初始用户消息',
  'hookSpecificOutput.watchPaths': ['src', 'docs'],
  'hookSpecificOutput.sessionTitle': '全量测试会话标题',
  'hookSpecificOutput.permissionDecision': 'allow',
  'hookSpecificOutput.permissionDecisionReason': '全量测试：允许工具执行',
  'hookSpecificOutput.updatedInput': { value: '全量测试修改后的输入' },
  'hookSpecificOutput.updatedMCPToolOutput': { content: [{ type: 'text', text: '全量测试修改后的工具输出' }] },
  'hookSpecificOutput.decision': { behavior: 'allow' },
  'hookSpecificOutput.retry': true,
  'hookSpecificOutput.action': 'accept',
  'hookSpecificOutput.content': { accepted: true },
  'hookSpecificOutput.worktreePath': 'D:/workspace/.claude/worktrees/hook-matrix-test',
});

function requireExplicitDatabasePath() {
  if (!process.env.DATABASE_PATH) {
    throw new Error('Set DATABASE_PATH explicitly before seeding Hook test configurations');
  }
}

function ensureTestSkill({ adminUserId, tenantId }) {
  const existing = db.prepare(`
    SELECT id FROM tenant_skill_presets WHERE tenant_id = ? AND name = ?
  `).get(tenantId, TEST_SKILL_NAME);
  if (existing) {
    db.prepare(`
      UPDATE tenant_skill_presets
      SET display_name = ?, description = ?, status = 'published',
          updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      `${PREFIX} Skill 新回合示例`,
      '仅供查看全量 Hook 测试配置；测试运行时使用临时工作区中的真实 Skill 文件。',
      adminUserId,
      existing.id,
    );
    return;
  }
  db.prepare(`
    INSERT INTO tenant_skill_presets (
      tenant_id, name, display_name, description, source_type,
      skill_id, remote_id, status, last_validation_status,
      created_by_user_id, updated_by_user_id
    ) VALUES (?, ?, ?, ?, 'skill-market-api', ?, ?, 'published', 'valid', ?, ?)
  `).run(
    tenantId,
    TEST_SKILL_NAME,
    `${PREFIX} Skill 新回合示例`,
    '仅供查看全量 Hook 测试配置；测试运行时使用临时工作区中的真实 Skill 文件。',
    'hook-matrix-test-skill',
    'hook-matrix-test-remote',
    adminUserId,
    adminUserId,
  );
}

function literalForProperty(property = {}, index = 0) {
  if (property.default !== undefined) return property.default;
  if (Array.isArray(property.enum) && property.enum.length > 0) return property.enum[0];
  if (property.type === 'number' || property.type === 'integer') return index + 1;
  if (property.type === 'boolean') return true;
  if (property.type === 'array') return [];
  if (property.type === 'object') return {};
  return `全量测试参数-${index + 1}`;
}

function buildToolInputs(tool) {
  const properties = tool.inputSchema?.properties || {};
  const names = Object.keys(properties);
  return Object.fromEntries(names.map((name, index) => {
    const property = properties[name] || {};
    if (index === 0 && ['number', 'integer'].includes(property.type)) {
      return [name, { source: 'reference', path: 'ccui.env.userId' }];
    }
    if (index === 0 && property.type === 'string') {
      return [name, {
        source: 'template',
        template: 'event={{event.hook_event_name}} user={{ccui.env.userId}}',
      }];
    }
    return [name, { source: 'literal', value: literalForProperty(property, index) }];
  }));
}

function matcherFor(eventName) {
  const values = {
    Setup: 'init',
    SessionStart: 'startup',
    StopFailure: 'server_error',
    SessionEnd: 'clear',
    UserPromptExpansion: 'review',
    Notification: 'permission_prompt',
    PreToolUse: '^mcp__.*$',
    PostToolUse: '^mcp__.*$',
    PostToolUseFailure: '^mcp__.*$',
    PermissionRequest: '^mcp__.*$',
    PermissionDenied: '^mcp__.*$',
    SubagentStart: 'Explore',
    SubagentStop: 'Explore',
    PreCompact: 'auto',
    PostCompact: 'auto',
    Elicitation: 'test_v2',
    ElicitationResult: 'test_v2',
    ConfigChange: 'skills',
    InstructionsLoaded: 'session_start',
    FileChanged: '.env',
  };
  return values[eventName] ? { value: values[eventName] } : {};
}

function baseHook(eventName, kind, overrides = {}) {
  return {
    name: `${PREFIX} ${eventName} · ${kind}`,
    description: '由 npm run seed:hook-test-configs 生成。已发布但未启动，仅用于在管理页面检查全量配置。',
    eventName,
    matcher: matcherFor(eventName),
    extensionLogic: null,
    postActions: [],
    claudeResponse: { bindings: {} },
    ...overrides,
  };
}

function main() {
  requireExplicitDatabasePath();
  const admin = db.prepare(`
    SELECT id FROM users ORDER BY is_system_admin DESC, id LIMIT 1
  `).get();
  if (!admin) throw new Error('No CCUI user exists for Hook ownership');
  const tenant = db.prepare(`
    SELECT id FROM tenants WHERE status = 'active' ORDER BY CASE code WHEN 'default' THEN 0 ELSE 1 END, id LIMIT 1
  `).get();
  if (!tenant) throw new Error('No active tenant exists for Hook test resources');

  ensureTestSkill({ adminUserId: admin.id, tenantId: tenant.id });
  const service = createHookConfigService({ database: db, configStore: appConfigDb });
  const mcpTool = service.getResources().mcpTools[0];
  if (!mcpTool) throw new Error('At least one published healthy MCP tool is required to seed Hook test configurations');

  const oldRows = db.prepare('SELECT id FROM hooks WHERE name LIKE ?').all(`${PREFIX}%`);
  const removeOld = db.transaction(() => {
    for (const row of oldRows) service.deleteHook(row.id);
  });
  removeOld();

  let published = 0;
  const createAndPublish = (input) => {
    const created = service.createHook({ input, userId: admin.id });
    const result = service.publishHook({ hookId: created.id, userId: admin.id });
    if (result.activationScope !== 'manual') throw new Error(`Generated Hook ${result.name} unexpectedly started`);
    published += 1;
  };

  for (const eventName of HOOK_EVENTS) {
    for (const language of ['javascript', 'python']) {
      createAndPublish(baseHook(eventName, `脚本 · ${language}`, {
        extensionLogic: {
          language,
          code: language === 'python' ? PYTHON_SCRIPT : JAVASCRIPT_SCRIPT,
          outputs: SCRIPT_OUTPUTS,
        },
        claudeResponse: eventName === 'StopFailure'
          ? { bindings: {} }
          : {
              bindings: {
                systemMessage: {
                  source: 'template',
                  template: '脚本事件：{{script.output.eventName}}，用户：{{script.output.userId}}',
                },
              },
            },
      }));
    }

    for (const actionType of allowedPostActions(eventName)) {
      if (actionType === 'call_mcp_tool') {
        createAndPublish(baseHook(eventName, `行为 · 调用 MCP · ${mcpTool.name}`, {
          postActions: [{
            id: 'call-mcp',
            type: 'call_mcp_tool',
            position: 0,
            config: { toolName: mcpTool.name, inputs: buildToolInputs(mcpTool) },
          }],
          claudeResponse: eventName === 'StopFailure'
            ? { bindings: {} }
            : {
                bindings: {
                  systemMessage: {
                    source: 'template',
                    template: 'MCP 调用结果：{{actions.call-mcp.output}}',
                  },
                },
              },
        }));
      } else if (actionType === 'invoke_skill') {
        const errorText = eventName === 'StopFailure' ? '，错误：{{event.error}}' : '';
        createAndPublish(baseHook(eventName, '行为 · 调用 Skill', {
          postActions: [{
            id: 'invoke-skill',
            type: 'invoke_skill',
            position: 0,
            config: {
              skillName: TEST_SKILL_NAME,
              argumentsTemplate: `事件：{{event.hook_event_name}}${errorText}，用户：{{ccui.env.userId}}`,
              maxTurns: 2,
            },
          }],
        }));
      }
    }

    for (const outputPath of allowedClaudeOutputs(eventName)) {
      if (!Object.prototype.hasOwnProperty.call(OUTPUT_VALUES, outputPath)) {
        throw new Error(`Missing test value for Claude output ${eventName}/${outputPath}`);
      }
      createAndPublish(baseHook(eventName, `返回 · ${outputPath}`, {
        claudeResponse: {
          bindings: { [outputPath]: { source: 'literal', value: OUTPUT_VALUES[outputPath] } },
        },
      }));
    }
  }

  const summary = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN activation_scope = 'manual' THEN 1 ELSE 0 END) AS stopped
    FROM hooks WHERE name LIKE ?
  `).get(`${PREFIX}%`);
  console.log(JSON.stringify({
    databasePath: process.env.DATABASE_PATH,
    generated: published,
    persisted: summary,
    mcpTool: mcpTool.name,
    skill: TEST_SKILL_NAME,
  }, null, 2));
}

try {
  main();
} finally {
  db.close();
}
