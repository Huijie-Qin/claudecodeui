import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { ProcessingSessions } from '../../../hooks/useSessionProtection';

export type Provider = LLMProvider;

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface ChatImage {
  data: string;
  name: string;
}

export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export interface ClaudeProcessDiagnostics {
  provider?: string | null;
  sessionId?: string | null;
  providerSessionId?: string | null;
  runtimeId?: string | null;
  runtimeMode?: string | null;
  containerName?: string | null;
  cwd?: string | null;
  projectPath?: string | null;
  hostWorkspacePath?: string | null;
  executable?: string | null;
  command?: string | null;
  args?: string[];
  startedAt?: string | null;
  endedAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  spawnError?: string | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  [key: string]: unknown;
}

export interface SubagentChildTool {
  toolId: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResult | null;
  timestamp: Date;
}

export type TaskNotificationUsageValue = string | number;

export interface TaskNotificationDetails {
  taskId?: string;
  toolUseId?: string;
  outputFile?: string;
  status: string;
  summary: string;
  result?: string;
  usage: Record<string, TaskNotificationUsageValue>;
  rawUsage?: string;
  extraFields: Record<string, string>;
  raw: string;
}

export type UserQueueStatus = 'queued' | 'processing' | 'failed';

export type HookActivityStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface HookActivityDetails {
  jobId?: string;
  hookId?: string;
  hookName?: string;
  activityKind?: 'execution' | 'followup';
  actionId?: string;
  actionType?: 'invoke_skill' | 'send_agent_message';
  eventName?: string;
  actionTypes?: Array<'call_mcp_tool' | 'write_record' | 'invoke_skill' | 'send_agent_message'>;
  hasScript?: boolean;
  skillName?: string;
  summary?: string;
  queuePosition?: number;
  status: HookActivityStatus;
  error?: string;
}

export interface ChatMessage {
  id?: string;
  type: string;
  content?: string;
  timestamp: string | number | Date;
  clientMessageId?: string;
  queueStatus?: UserQueueStatus;
  queuePosition?: number;
  images?: ChatImage[];
  reasoning?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isInteractivePrompt?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  diagnostics?: ClaudeProcessDiagnostics;
  toolId?: string;
  toolCallId?: string;
  toolCompletedAt?: string | number | Date;
  isSubagentContainer?: boolean;
  isTaskNotification?: boolean;
  isHookActivity?: boolean;
  hookActivity?: HookActivityDetails;
  taskStatus?: string;
  taskNotification?: TaskNotificationDetails;
  subagentState?: {
    agentId?: string;
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
    detailsOwnerToolId?: string;
  };
  [key: string]: unknown;
}

export interface ClaudeSettings {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

export interface ClaudePermissionSuggestion {
  toolName: string;
  entry: string;
  isAllowed: boolean;
}

export interface PermissionGrantResult {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: ClaudeSettings;
}

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface ChatInterfaceProps {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  latestMessage: any;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  processingSessions?: ProcessingSessions;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (targetSessionId: string) => void;
  onShowSettings?: () => void;
  autoExpandTools?: boolean;
  hideToolMessages?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  autoScrollToBottom?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  initialUserMessage?: {
    sessionId: string;
    provider: LLMProvider;
    content: string;
    timestamp: number;
  };
  onOpenCapabilities?: () => void;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
  workspaceTerminology?: 'workspace' | 'expert';
}
