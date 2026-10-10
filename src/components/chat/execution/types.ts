export type ExecutionTaskStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'unknown';

export interface ExecutionTaskEvent {
  id: string;
  timestamp: Date;
  status: string;
  summary: string;
  result?: unknown;
  exitCode?: number;
}

export interface ExecutionTask {
  id: string;
  kind: 'background' | 'subagent' | 'loop';
  title: string;
  status: ExecutionTaskStatus;
  summary?: string;
  taskId?: string;
  toolUseId?: string;
  sourceMessageId?: string;
  traceId?: string;
  parentAgentId?: string;
  parentToolUseId?: string;
  startedAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
  command?: string;
  input?: unknown;
  result?: unknown;
  exitCode?: number;
  outputFile?: string;
  usage?: Record<string, string | number>;
  events: ExecutionTaskEvent[];
  loopJobId?: string;
}
