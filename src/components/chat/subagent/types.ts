import type {
  ChatMessage,
  TaskNotificationDetails,
  ToolResult,
} from '../types/types';

export type SubagentTraceStatus = 'running' | 'waiting' | 'completed' | 'stopped' | 'error';

export type SubagentActivityStatus = 'running' | 'completed' | 'stopped' | 'error';

export interface SubagentActivity {
  id: string;
  toolId: string;
  toolName: string;
  toolInput: unknown;
  toolResult: ToolResult | null;
  timestamp: Date;
  status: SubagentActivityStatus;
  summary: string;
}

export interface SubagentTrace {
  id: string;
  agentId?: string;
  sourceToolIds: string[];
  title: string;
  description: string;
  agentType: string;
  prompt: string;
  status: SubagentTraceStatus;
  startedAt: Date;
  completedAt?: Date;
  activities: SubagentActivity[];
  messages: ChatMessage[];
  result?: unknown;
  usage: TaskNotificationDetails['usage'];
  taskStatus?: string;
}
