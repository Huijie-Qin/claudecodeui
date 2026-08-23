import type {
  FieldChoice,
  FieldType,
  HookConfig,
  HookConfigDraft,
  HookEventDefinition,
  HookEventName,
  HookOutputField,
  HookResources,
  HookScriptLanguage,
  HookScriptOutput,
  HookToolResource,
} from './types';

const COMMON_EVENT_FIELDS: HookEventDefinition['fields'] = [
  { key: 'session_id', type: 'string' },
  { key: 'transcript_path', type: 'string' },
  { key: 'cwd', type: 'string' },
  { key: 'permission_mode', type: 'string' },
  { key: 'agent_id', type: 'string' },
  { key: 'agent_type', type: 'string' },
  { key: 'hook_event_name', type: 'string' },
];

function defineEvent(
  event: Omit<HookEventDefinition, 'fields'> & {
    fields?: HookEventDefinition['fields'];
  },
): HookEventDefinition {
  return {
    ...event,
    fields: [...COMMON_EVENT_FIELDS, ...(event.fields || [])],
  };
}

// Keep this catalog aligned with HookInput in the installed @anthropic-ai/claude-agent-sdk.
export const EVENT_DEFINITIONS: HookEventDefinition[] = [
  defineEvent({
    name: 'Setup',
    group: 'session',
    matcherField: 'trigger',
    fields: [{ key: 'trigger', type: 'string', options: ['init', 'maintenance'] }],
  }),
  defineEvent({
    name: 'SessionStart',
    group: 'session',
    matcherField: 'source',
    fields: [
      {
        key: 'source',
        type: 'string',
        options: ['startup', 'resume', 'clear', 'compact'],
      },
      { key: 'model', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'Stop',
    group: 'session',
    fields: [
      { key: 'stop_hook_active', type: 'boolean' },
      { key: 'last_assistant_message', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'StopFailure',
    group: 'session',
    matcherField: 'error',
    fields: [
      {
        key: 'error',
        type: 'string',
        options: [
          'authentication_failed',
          'billing_error',
          'rate_limit',
          'invalid_request',
          'server_error',
          'unknown',
          'max_output_tokens',
        ],
      },
      { key: 'error_details', type: 'string' },
      { key: 'last_assistant_message', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'SessionEnd',
    group: 'session',
    matcherField: 'reason',
    fields: [
      {
        key: 'reason',
        type: 'string',
        options: ['clear', 'resume', 'logout', 'prompt_input_exit', 'other', 'bypass_permissions_disabled'],
      },
    ],
  }),
  defineEvent({
    name: 'UserPromptSubmit',
    group: 'prompt',
    fields: [
      { key: 'prompt', type: 'string' },
      { key: 'session_title', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'UserPromptExpansion',
    group: 'prompt',
    matcherField: 'command_name',
    fields: [
      {
        key: 'expansion_type',
        type: 'string',
        options: ['slash_command', 'mcp_prompt'],
      },
      { key: 'command_name', type: 'string' },
      { key: 'command_args', type: 'string' },
      { key: 'command_source', type: 'string' },
      { key: 'prompt', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'Notification',
    group: 'prompt',
    matcherField: 'notification_type',
    fields: [
      { key: 'title', type: 'string' },
      { key: 'message', type: 'string' },
      { key: 'notification_type', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'PreToolUse',
    group: 'tool',
    matcherField: 'tool_name',
    fields: [
      { key: 'tool_name', type: 'string' },
      { key: 'tool_input', type: 'object' },
      { key: 'tool_use_id', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'PostToolUse',
    group: 'tool',
    matcherField: 'tool_name',
    fields: [
      { key: 'tool_name', type: 'string' },
      { key: 'tool_input', type: 'object' },
      { key: 'tool_response', type: 'object' },
      { key: 'tool_use_id', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'PostToolUseFailure',
    group: 'tool',
    matcherField: 'tool_name',
    fields: [
      { key: 'tool_name', type: 'string' },
      { key: 'tool_input', type: 'object' },
      { key: 'tool_use_id', type: 'string' },
      { key: 'error', type: 'string' },
      { key: 'is_interrupt', type: 'boolean' },
    ],
  }),
  defineEvent({
    name: 'PermissionRequest',
    group: 'tool',
    matcherField: 'tool_name',
    fields: [
      { key: 'tool_name', type: 'string' },
      { key: 'tool_input', type: 'object' },
      { key: 'permission_suggestions', type: 'array' },
    ],
  }),
  defineEvent({
    name: 'PermissionDenied',
    group: 'tool',
    matcherField: 'tool_name',
    fields: [
      { key: 'tool_name', type: 'string' },
      { key: 'tool_input', type: 'object' },
      { key: 'tool_use_id', type: 'string' },
      { key: 'reason', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'SubagentStart',
    group: 'agent',
    matcherField: 'agent_type',
  }),
  defineEvent({
    name: 'SubagentStop',
    group: 'agent',
    matcherField: 'agent_type',
    fields: [
      { key: 'stop_hook_active', type: 'boolean' },
      { key: 'agent_transcript_path', type: 'string' },
      { key: 'last_assistant_message', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'TeammateIdle',
    group: 'agent',
    fields: [
      { key: 'teammate_name', type: 'string' },
      { key: 'team_name', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'TaskCreated',
    group: 'agent',
    fields: [
      { key: 'task_id', type: 'string' },
      { key: 'task_subject', type: 'string' },
      { key: 'task_description', type: 'string' },
      { key: 'teammate_name', type: 'string' },
      { key: 'team_name', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'TaskCompleted',
    group: 'agent',
    fields: [
      { key: 'task_id', type: 'string' },
      { key: 'task_subject', type: 'string' },
      { key: 'task_description', type: 'string' },
      { key: 'teammate_name', type: 'string' },
      { key: 'team_name', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'PreCompact',
    group: 'context',
    matcherField: 'trigger',
    fields: [
      { key: 'trigger', type: 'string', options: ['manual', 'auto'] },
      { key: 'custom_instructions', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'PostCompact',
    group: 'context',
    matcherField: 'trigger',
    fields: [
      { key: 'trigger', type: 'string', options: ['manual', 'auto'] },
      { key: 'compact_summary', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'Elicitation',
    group: 'mcp',
    matcherField: 'mcp_server_name',
    fields: [
      { key: 'mcp_server_name', type: 'string' },
      { key: 'message', type: 'string' },
      { key: 'mode', type: 'string', options: ['form', 'url'] },
      { key: 'url', type: 'string' },
      { key: 'elicitation_id', type: 'string' },
      { key: 'requested_schema', type: 'object' },
    ],
  }),
  defineEvent({
    name: 'ElicitationResult',
    group: 'mcp',
    matcherField: 'mcp_server_name',
    fields: [
      { key: 'mcp_server_name', type: 'string' },
      { key: 'elicitation_id', type: 'string' },
      { key: 'mode', type: 'string', options: ['form', 'url'] },
      {
        key: 'action',
        type: 'string',
        options: ['accept', 'decline', 'cancel'],
      },
      { key: 'content', type: 'object' },
    ],
  }),
  defineEvent({
    name: 'ConfigChange',
    group: 'workspace',
    matcherField: 'source',
    fields: [
      {
        key: 'source',
        type: 'string',
        options: ['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills'],
      },
      { key: 'file_path', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'InstructionsLoaded',
    group: 'workspace',
    matcherField: 'load_reason',
    fields: [
      { key: 'file_path', type: 'string' },
      {
        key: 'memory_type',
        type: 'string',
        options: ['User', 'Project', 'Local', 'Managed'],
      },
      {
        key: 'load_reason',
        type: 'string',
        options: ['session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact'],
      },
      { key: 'globs', type: 'array' },
      { key: 'trigger_file_path', type: 'string' },
      { key: 'parent_file_path', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'CwdChanged',
    group: 'workspace',
    fields: [
      { key: 'old_cwd', type: 'string' },
      { key: 'new_cwd', type: 'string' },
    ],
  }),
  defineEvent({
    name: 'FileChanged',
    group: 'workspace',
    matcherField: 'file_path',
    matcherKind: 'fileNames',
    fields: [
      { key: 'file_path', type: 'string' },
      { key: 'event', type: 'string', options: ['change', 'add', 'unlink'] },
    ],
  }),
  defineEvent({
    name: 'WorktreeCreate',
    group: 'workspace',
    fields: [{ key: 'name', type: 'string' }],
  }),
  defineEvent({
    name: 'WorktreeRemove',
    group: 'workspace',
    fields: [{ key: 'worktree_path', type: 'string' }],
  }),
];

export const EVENT_BY_NAME = new Map(EVENT_DEFINITIONS.map((event) => [event.name, event]));

const COMMON_CLAUDE_OUTPUTS: HookOutputField[] = [
  {
    path: 'continue',
    type: 'boolean',
    description: 'false 时立即停止 Claude 后续处理',
  },
  {
    path: 'stopReason',
    type: 'string',
    description: 'continue 为 false 时展示给用户的停止原因',
  },
  {
    path: 'suppressOutput',
    type: 'boolean',
    description: '隐藏 Hook 标准输出，不写入会话转录',
  },
  {
    path: 'systemMessage',
    type: 'string',
    description: '向当前用户展示系统提示',
  },
];

const DECISION_EVENTS = new Set<HookEventName>([
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStop',
  'ConfigChange',
  'PreCompact',
]);

const EVENT_CLAUDE_OUTPUTS: Partial<Record<HookEventName, HookOutputField[]>> = {
  Setup: [
    {
      path: 'hookSpecificOutput.additionalContext',
      type: 'string',
      description: '追加到 Claude 上下文',
    },
  ],
  SessionStart: [
    {
      path: 'hookSpecificOutput.additionalContext',
      type: 'string',
      description: '追加到 Claude 上下文',
    },
    {
      path: 'hookSpecificOutput.initialUserMessage',
      type: 'string',
      description: '设置会话开始时的首条用户消息',
    },
    {
      path: 'hookSpecificOutput.watchPaths',
      type: 'array',
      description: '添加文件监听路径',
    },
  ],
  UserPromptSubmit: [
    {
      path: 'hookSpecificOutput.additionalContext',
      type: 'string',
      description: '在问题旁追加 Claude 可见上下文',
    },
    {
      path: 'hookSpecificOutput.sessionTitle',
      type: 'string',
      description: '更新 Claude 会话标题',
    },
  ],
  UserPromptExpansion: [
    {
      path: 'hookSpecificOutput.additionalContext',
      type: 'string',
      description: '在展开后的命令旁追加上下文',
    },
  ],
  Notification: [
    {
      path: 'hookSpecificOutput.additionalContext',
      type: 'string',
      description: '追加 Claude 可见上下文',
    },
  ],
  PreToolUse: [
    {
      path: 'hookSpecificOutput.permissionDecision',
      type: 'string',
      description: 'allow、deny、ask 或 defer',
    },
    {
      path: 'hookSpecificOutput.permissionDecisionReason',
      type: 'string',
      description: '权限决定原因',
    },
    {
      path: 'hookSpecificOutput.updatedInput',
      type: 'object',
      description: '替换即将执行的完整工具输入',
    },
    {
      path: 'hookSpecificOutput.additionalContext',
      type: 'string',
      description: '追加到 Claude 后续推理上下文',
    },
  ],
  PostToolUse: [
    {
      path: 'hookSpecificOutput.additionalContext',
      type: 'string',
      description: '在工具结果旁追加上下文',
    },
    {
      path: 'hookSpecificOutput.updatedMCPToolOutput',
      type: 'object',
      description: '替换 MCP 工具输出',
    },
  ],
  PostToolUseFailure: [
    {
      path: 'hookSpecificOutput.additionalContext',
      type: 'string',
      description: '在失败结果旁追加上下文',
    },
  ],
  PermissionRequest: [
    {
      path: 'hookSpecificOutput.decision',
      type: 'object',
      description: '允许或拒绝权限请求，并可携带 updatedInput',
    },
  ],
  PermissionDenied: [
    {
      path: 'hookSpecificOutput.retry',
      type: 'boolean',
      description: '允许模型重试已被拒绝的工具调用',
    },
  ],
  SubagentStart: [
    {
      path: 'hookSpecificOutput.additionalContext',
      type: 'string',
      description: '追加到子 Agent 的初始上下文',
    },
  ],
  Elicitation: [
    {
      path: 'hookSpecificOutput.action',
      type: 'string',
      description: 'accept、decline 或 cancel',
    },
    {
      path: 'hookSpecificOutput.content',
      type: 'object',
      description: '接受 MCP 询问时返回的表单内容',
    },
  ],
  ElicitationResult: [
    {
      path: 'hookSpecificOutput.action',
      type: 'string',
      description: '覆盖用户原始操作',
    },
    {
      path: 'hookSpecificOutput.content',
      type: 'object',
      description: '覆盖发送给 MCP Server 的内容',
    },
  ],
  CwdChanged: [
    {
      path: 'hookSpecificOutput.watchPaths',
      type: 'array',
      description: '切换目录后添加文件监听路径',
    },
  ],
  FileChanged: [
    {
      path: 'hookSpecificOutput.watchPaths',
      type: 'array',
      description: '更新后续文件监听路径',
    },
  ],
  WorktreeCreate: [
    {
      path: 'hookSpecificOutput.worktreePath',
      type: 'string',
      description: '返回已创建的 worktree 绝对路径',
    },
  ],
};

const OUTPUT_IGNORED_EVENTS = new Set<HookEventName>(['StopFailure']);

export function getClaudeOutputFields(eventName: HookEventName): HookOutputField[] {
  if (OUTPUT_IGNORED_EVENTS.has(eventName)) return [];
  const decisionOutputs: HookOutputField[] = DECISION_EVENTS.has(eventName)
    ? [
        {
          path: 'decision',
          type: 'string',
          description: '设置为 block 以阻止当前操作或让 Agent 继续',
        },
        {
          path: 'reason',
          type: 'string',
          description: 'decision 为 block 时的原因',
        },
      ]
    : [];
  const specific = EVENT_CLAUDE_OUTPUTS[eventName] || [];
  return [...COMMON_CLAUDE_OUTPUTS, ...decisionOutputs, ...specific];
}

export const CCUI_SCRIPT_APIS = [
  {
    javascript: 'ccui.workspace.readText(path)',
    python: 'ccui.workspace.read_text(path)',
    description: '读取工作空间内的 UTF-8 文本文件',
  },
  {
    javascript: 'ccui.workspace.writeText(path, content)',
    python: 'ccui.workspace.write_text(path, content)',
    description: '写入工作空间内的文本文件',
  },
  {
    javascript: 'ccui.workspace.readJson(path)',
    python: 'ccui.workspace.read_json(path)',
    description: '读取并解析工作空间内的 JSON 文件',
  },
  {
    javascript: 'ccui.workspace.writeJson(path, value)',
    python: 'ccui.workspace.write_json(path, value)',
    description: '序列化并写入工作空间内的 JSON 文件',
  },
  {
    javascript: 'ccui.workspace.list(path)',
    python: 'ccui.workspace.list(path)',
    description: '列出工作空间相对目录中的文件',
  },
  {
    javascript: 'ccui.workspace.exists(path)',
    python: 'ccui.workspace.exists(path)',
    description: '判断工作空间相对路径是否存在',
  },
  {
    javascript: 'ccui.env',
    python: 'ccui.env',
    description: '只读的当前用户、租户、工作空间和会话环境',
  },
  {
    javascript: 'ccui.records.write(type, data)',
    python: 'ccui.records.write(type, data)',
    description: '写入一条结构化 Hook 业务数据',
  },
  {
    javascript: 'ccui.log.info(message, data)',
    python: 'ccui.log.info(message, data)',
    description: '写入当前 Hook 执行日志',
  },
] as const;

export function scriptApiName(api: (typeof CCUI_SCRIPT_APIS)[number], language: HookScriptLanguage) {
  return language === 'python' ? api.python : api.javascript;
}

export function inferNativeMatcherMode(eventName: HookEventName, value?: string): 'all' | 'exact' | 'regex' {
  const matcher = value?.trim() || '';
  if (!matcher || matcher === '*') return 'all';
  if (eventName === 'FileChanged') return 'exact';
  const exactPattern = eventName === 'StopFailure' ? /^[A-Za-z0-9_|]+$/ : /^[A-Za-z0-9_,| -]+$/;
  return exactPattern.test(matcher) ? 'exact' : 'regex';
}

export const EVENT_GROUPS = ['session', 'prompt', 'tool', 'agent', 'context', 'mcp', 'workspace'];

export function createEmptyHook(eventName: HookEventName): HookConfigDraft {
  return {
    name: '',
    description: '',
    eventName,
    matcher: {},
    extensionLogic: null,
    postActions: [],
    claudeResponse: { bindings: {} },
  };
}

export function createHookCopyDraft(hook: HookConfig, name: string): HookConfigDraft {
  return JSON.parse(JSON.stringify({
    name,
    description: hook.description,
    eventName: hook.eventName,
    matcher: hook.matcher,
    extensionLogic: hook.extensionLogic,
    postActions: hook.postActions,
    claudeResponse: hook.claudeResponse,
  }));
}

export function shouldShowBusinessData(
  hook: Pick<HookConfig, 'postActions' | 'hasDataRecords'>,
): boolean {
  return hook.hasDataRecords || hook.postActions.some((action) => action.type === 'write_record');
}

function normalizePropertyType(type?: string): FieldType {
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  return 'string';
}

export function findMatchedTool(
  resources: HookResources,
  matcherValue?: string,
  matcherMode: 'exact' | 'regex' = 'exact',
): HookToolResource | undefined {
  if (!matcherValue || matcherMode !== 'exact') return undefined;
  return [...resources.builtinTools, ...resources.mcpTools].find((tool) => tool.name === matcherValue);
}

export function buildFieldChoices(draft: HookConfigDraft, resources: HookResources): FieldChoice[] {
  const event = EVENT_BY_NAME.get(draft.eventName);
  const fields: FieldChoice[] = (event?.fields || []).map((field) => ({
    path: `event.${field.key}`,
    labelKey: `hooks.fields.${field.key}`,
    type: field.type,
    options: field.options?.map((value) => ({ value, label: value })),
    group: 'event',
  }));

  const matchedTool = findMatchedTool(resources, draft.matcher.value, draft.matcher.mode);
  const properties = matchedTool?.inputSchema?.properties || {};
  for (const [key, property] of Object.entries(properties)) {
    fields.push({
      path: `event.tool_input.${key}`,
      label: property.description || key,
      description: key,
      type: normalizePropertyType(property.type),
      options: property.enum?.map((value) => ({
        value: String(value),
        label: String(value),
      })),
      group: 'event',
    });
  }
  return fields;
}

export function buildReferenceChoices(draft: HookConfigDraft, resources: HookResources): FieldChoice[] {
  const fields = buildFieldChoices(draft, resources);
  for (const variable of resources.environmentVariables.filter((item) => item.path.startsWith('ccui.env.'))) {
    fields.push({
      path: variable.path,
      labelKey: `hooks.variables.${variable.path.replace('ccui.env.', '')}`,
      type: normalizePropertyType(variable.type),
      group: 'environment',
    });
  }
  for (const output of draft.extensionLogic?.outputs || []) {
    fields.push({
      path: `script.output.${output.name}`,
      label: output.name,
      type: output.type,
      group: 'script',
    });
  }
  for (const action of draft.postActions) {
    fields.push({
      path: `actions.${action.id}.output`,
      label: action.type === 'call_mcp_tool'
        ? 'MCP 工具调用结果'
        : action.type === 'write_record'
          ? '业务数据写入结果'
          : 'Skill 调用结果',
      type: 'object',
      group: 'action',
    });
  }
  return fields;
}

type ScriptTemplateInput = {
  path: string;
  label: string;
  type: FieldType;
};

function scriptCommentText(value: string) {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\*\//g, '* /')
    .trim();
}

function javascriptOutputLines(outputs: HookScriptOutput[]) {
  return outputs.map((output) => `    // ${output.name}: undefined, // ${output.type}`);
}

function pythonOutputLines(outputs: HookScriptOutput[]) {
  return outputs.map((output) => `        # "${output.name}": None,  # ${output.type}`);
}

export function buildScriptTemplate({
  eventName,
  eventLabel,
  eventDescription,
  inputs,
  outputs = [],
  language = 'javascript',
}: {
  eventName: HookEventName;
  eventLabel: string;
  eventDescription: string;
  inputs: ScriptTemplateInput[];
  outputs?: HookScriptOutput[];
  language?: HookScriptLanguage;
}) {
  const safeLabel = scriptCommentText(eventLabel);
  const safeDescription = scriptCommentText(eventDescription);
  const inputLines = inputs.map((input) => `${input.path} (${input.type}) - ${scriptCommentText(input.label)}`);
  const outputLines = outputs.map((output) => `script.output.${output.name} (${output.type})`);

  if (language === 'python') {
    const comments = [
      `# 扩展逻辑：${safeLabel}（${eventName}）`,
      `# 触发说明：${safeDescription}`,
      '#',
      '# Claude SDK 回调参数：',
      ...inputLines.map((line) => `# - ${line}`),
      '#',
      '# 脚本返回值只供后续行为和“返回给 Claude”配置引用，不会自动发送给 Claude。',
      ...(outputLines.length ? ['# 已声明输出：', ...outputLines.map((line) => `# - ${line}`)] : []),
      '#',
      '# CCUI API：ccui.workspace / ccui.env / ccui.records / ccui.log',
      '# 所有文件路径必须是工作空间相对路径。',
    ].join('\n');
    return `${comments}
async def run(event, ccui):
    # ===== 在这里编写扩展逻辑 =====
    # text = await ccui.workspace.read_text("README.md")
    # await ccui.workspace.write_text("hook-output.txt", text)
    # await ccui.records.write("analysis", {"length": len(text)})

    return {
        "output": {
${pythonOutputLines(outputs).join('\n')}
        }
    }
`;
  }

  const comments = [
    '/**',
    ` * 扩展逻辑：${safeLabel}（${eventName}）`,
    ` * 触发说明：${safeDescription}`,
    ' *',
    ' * Claude SDK 回调参数：',
    ...inputLines.map((line) => ` * - ${line}`),
    ' *',
    ' * 脚本返回值只供后续行为和“返回给 Claude”配置引用，不会自动发送给 Claude。',
    ...(outputLines.length ? [' * 已声明输出：', ...outputLines.map((line) => ` * - ${line}`)] : []),
    ' *',
    ' * CCUI API：ccui.workspace / ccui.env / ccui.records / ccui.log',
    ' * 所有文件路径必须是工作空间相对路径。',
    ' */',
  ].join('\n');
  return `${comments}
export async function run(event, ccui) {
  // ===== 在这里编写扩展逻辑 =====
  // const text = await ccui.workspace.readText('README.md');
  // await ccui.workspace.writeText('hook-output.txt', text);
  // await ccui.records.write('analysis', { length: text.length });

  return {
    output: {
${javascriptOutputLines(outputs).join('\n')}
    },
  };
}
`;
}
