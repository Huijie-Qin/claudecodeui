export type HookEventName =
  | 'Setup'
  | 'SessionStart'
  | 'Stop'
  | 'StopFailure'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'UserPromptExpansion'
  | 'Notification'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'PreCompact'
  | 'PostCompact'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged'
  | 'WorktreeCreate'
  | 'WorktreeRemove';

export type HookStatus = 'draft' | 'published' | 'disabled';

export type HookMatcherMode = 'exact' | 'regex';

export type HookMatcher = {
  mode?: HookMatcherMode;
  value?: string;
};

export type HookScriptLanguage = 'javascript' | 'python';

export type HookScriptOutput = {
  name: string;
  type: FieldType;
};

export type HookExtensionLogic = {
  language: HookScriptLanguage;
  code: string;
  outputs: HookScriptOutput[];
};

export type HookValueBinding =
  | {
    source: 'literal';
    value: unknown;
  }
  | {
    source: 'reference';
    path: string;
  }
  | {
    source: 'template';
    template: string;
  };

export type HookPostAction = {
  id: string;
  type: 'call_mcp_tool' | 'write_record' | 'invoke_skill';
  position: number;
  config: Record<string, unknown>;
};

export type HookClaudeResponse = {
  bindings: Record<string, HookValueBinding>;
};

export type HookConfigDraft = {
  name: string;
  description: string;
  eventName: HookEventName;
  matcher: HookMatcher;
  extensionLogic: HookExtensionLogic | null;
  postActions: HookPostAction[];
  claudeResponse: HookClaudeResponse;
};

export type HookConfig = HookConfigDraft & {
  id: string;
  status: HookStatus;
  version: number;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  activationScope: 'manual' | 'all_users';
  bindingController: 'admin' | 'sql_check';
  boundUserCount: number;
  boundTenantCount: number;
  hasDataRecords: boolean;
};

export type HookExecutionOutcome =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'stopped'
  | 'ask'
  | 'defer'
  | 'modified_input'
  | 'modified_output'
  | 'post_action'
  | 'additional_context';

export type HookExecution = {
  id: string;
  hookId: string;
  hookName: string | null;
  hookVersion: number;
  bindingController: 'admin' | 'sql_check';
  userId: number | null;
  username: string | null;
  tenantId: number | null;
  workspaceId: number | null;
  sessionId: string | null;
  eventName: HookEventName;
  toolUseId: string | null;
  toolName: string | null;
  status: 'running' | 'succeeded' | 'failed';
  input: unknown;
  scriptOutput: unknown;
  actions: Record<string, unknown>;
  response: Record<string, unknown>;
  logs: Array<{ timestamp?: string; message?: string; data?: unknown }>;
  errorMessage: string | null;
  durationMs: number | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  diagnostics: {
    outcome: HookExecutionOutcome;
    effects: string[];
    permissionDecision: string | null;
    updatedInput: boolean;
    actionCount: number;
    failOpen: boolean;
  };
};

export type HookExecutionPage = {
  executions: HookExecution[];
  total: number;
  executionTotal: number;
  limit: number;
  offset: number;
};

export type JsonSchemaProperty = {
  type?: string;
  description?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
};

export type JsonObjectSchema = {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export type HookToolResource = {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
};

export type HookMcpToolResource = HookToolResource & {
  serverName: string;
  serverDisplayName: string;
  toolName: string;
  tenantCodes: string[];
};

export type HookSkillResource = {
  skillId: string;
  name: string;
  displayName: string;
  description: string;
  version: number;
};

export type HookSkillSource = {
  type: 'builtin';
  available: boolean;
  error?: string;
};

export type HookEnvironmentVariable = {
  path: string;
  type: string;
  protected?: boolean;
};

export type HookResources = {
  events: HookEventName[];
  builtinTools: HookToolResource[];
  mcpTools: HookMcpToolResource[];
  skills: HookSkillResource[];
  skillSource?: HookSkillSource;
  environmentVariables: HookEnvironmentVariable[];
};

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export type FieldChoice = {
  path: string;
  labelKey?: string;
  label?: string;
  description?: string;
  type: FieldType;
  options?: Array<{ value: string; label: string }>;
  group: 'event' | 'environment' | 'script' | 'action';
};

export type HookEventDefinition = {
  name: HookEventName;
  group: string;
  matcherField?: string;
  matcherKind?: 'standard' | 'fileNames';
  fields: Array<{
    key: string;
    type: FieldType;
    options?: string[];
  }>;
};

export type HookOutputField = {
  path: string;
  type: FieldType;
  description: string;
};
