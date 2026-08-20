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
  description: string;
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
