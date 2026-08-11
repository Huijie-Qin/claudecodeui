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

export type HookActionType =
  | 'record_data'
  | 'call_tool'
  | 'append_context'
  | 'invoke_skill_recovery'
  | 'decision'
  | 'update_input'
  | 'update_output';

export type HookConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'matches_regex'
  | 'greater_than'
  | 'less_than'
  | 'is_true'
  | 'is_false'
  | 'is_empty'
  | 'is_not_empty';

export type HookCondition = {
  id: string;
  field: string;
  operator: HookConditionOperator;
  value?: string | number | boolean;
};

export type HookGate = {
  mode: 'all' | 'any';
  conditions: HookCondition[];
};

export type HookScriptOutput = {
  name: string;
  type: FieldType;
  description: string;
};

export type HookAdvancedScript = {
  enabled: true;
  language: 'javascript';
  code: string;
  outputs: HookScriptOutput[];
};

export type HookAction = {
  id: string;
  type: HookActionType;
  position?: number;
  config: Record<string, unknown>;
};

export type HookConfigDraft = {
  name: string;
  description: string;
  eventName: HookEventName;
  matcher: HookMatcher;
  gate: HookGate;
  advancedScript: HookAdvancedScript | null;
  actions: HookAction[];
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
  globalEnabled: boolean;
  boundUserCount: number;
  actionCount?: number;
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
  name: string;
  displayName: string;
  description: string;
  tenantCodes: string[];
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
  gateAllowed?: boolean;
  group: 'event' | 'environment' | 'script' | 'action';
};

export type HookEventDefinition = {
  name: HookEventName;
  group: string;
  matcherField?: string;
  fields: Array<{
    key: string;
    type: FieldType;
    options?: string[];
  }>;
};
