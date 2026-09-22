import type { ChatMessage } from '../types/types';

import type { ExecutionTask } from './types';

export function indexExecutionTaskMessages(tasks: ExecutionTask[]): Map<string, ExecutionTask> {
  const index = new Map<string, ExecutionTask>();
  for (const task of tasks) {
    if (task.kind !== 'background') continue;
    if (task.sourceMessageId) index.set(`message:${task.sourceMessageId}`, task);
    if (task.taskId) index.set(`task:${task.taskId}`, task);
  }
  return index;
}

export function executionTaskForMessage(index: Map<string, ExecutionTask>, message: ChatMessage): ExecutionTask | undefined {
  // SDK versions without a standalone start notification still expose the
  // task from its actual Bash row. Once a notification exists, it owns the link.
  if (!message.isTaskNotification) {
    return message.isToolUse && message.toolName?.toLowerCase() === 'bash' && message.id
      ? index.get(`message:${message.id}`) : undefined;
  }
  return (message.id ? index.get(`message:${message.id}`) : undefined)
    || (message.taskNotification?.taskId ? index.get(`task:${message.taskNotification.taskId}`) : undefined);
}
