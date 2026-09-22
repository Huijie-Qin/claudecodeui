import type { ChatMessage } from '../types/types';
import type { SubagentTrace } from '../subagent/types';
import { decodeHtmlEntities } from '../utils/chatFormatting';

import type { ExecutionTask, ExecutionTaskEvent, ExecutionTaskStatus } from './types';

export function normalizeExecutionStatus(value: unknown): ExecutionTaskStatus {
  const status = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (['running', 'in_progress', 'async_launched', 'started'].includes(status)) return 'running';
  if (['waiting', 'pending', 'queued', 'waiting_for_input', 'waiting_for_permission'].includes(status)) return 'waiting';
  if (['completed', 'complete', 'success', 'succeeded', 'done'].includes(status)) return 'completed';
  if (['failed', 'error', 'timeout', 'timed_out'].includes(status)) return 'failed';
  if (['stopped', 'cancelled', 'canceled', 'killed', 'aborted', 'interrupted'].includes(status)) return 'stopped';
  return 'unknown';
}

function date(value: unknown): Date | undefined {
  if (!(value instanceof Date) && typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)); } catch { return undefined; }
  }
  return undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function terminal(status: ExecutionTaskStatus): boolean {
  return ['completed', 'failed', 'stopped'].includes(status);
}

function notificationExitCode(summary: string | undefined): number | undefined {
  // These are explicit runtime notifications, not guesses from task titles,
  // generic numbers, failure statuses, or the command's stdout.
  const match = summary?.match(/\b(?:completed\s*\(\s*exit\s+code\s+(-?\d+)\s*\)|failed\s+with\s+exit\s+code\s+(-?\d+)(?!\d|\.\d))/i);
  if (!match) return undefined;
  const code = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(code) ? code : undefined;
}

function latestDate(...values: Array<Date | undefined>): Date | undefined {
  return values.filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0];
}

function payloadField(value: unknown, names: string[], depth = 0): unknown {
  if (depth > 4 || value == null) return undefined;
  if (typeof value === 'string' && !object(value)) {
    for (const name of names) {
      const match = value.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'));
      if (match) return decodeHtmlEntities(match[1]);
    }
    return undefined;
  }
  const record = object(value);
  if (!record) return undefined;
  for (const name of names) if (record[name] !== undefined && record[name] !== null) return record[name];
  // TaskOutput wraps its business payload in `task`; tool results can also
  // carry the original structured payload alongside their display content.
  for (const name of ['task', 'toolUseResult', 'content']) {
    const found = payloadField(record[name], names, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function toolTaskId(message: ChatMessage): string | undefined {
  return string(payloadField(message.toolResult, ['backgroundTaskId', 'task_id', 'taskId', 'bash_id']))
    || (typeof message.toolResult?.content === 'string'
      ? message.toolResult.content.match(/Command running in background with ID:\s*([^\s.]+)/i)?.[1] : undefined);
}

function taskOutput(message: ChatMessage): { status: ExecutionTaskStatus; result?: unknown; exitCode?: number; outputFile?: string } {
  const value = message.toolResult;
  const rawCode = payloadField(value, ['exit_code', 'exitCode']);
  const exitCode = typeof rawCode === 'number' ? rawCode
    : typeof rawCode === 'string' && /^-?\d+$/.test(rawCode.trim()) ? Number(rawCode) : undefined;
  const rawStatus = normalizeExecutionStatus(payloadField(value, ['status']));
  const status = rawStatus === 'completed' && exitCode !== undefined && exitCode !== 0 ? 'failed' : rawStatus;
  const output = payloadField(value, ['output', 'stdout']);
  const stderr = payloadField(value, ['stderr']);
  const result = typeof stderr === 'string' && stderr.trim()
    ? { ...(output !== undefined ? { stdout: output } : {}), stderr }
    : output ?? payloadField(value, ['result', 'last_assistant_message']);
  return { status, result, exitCode, outputFile: string(payloadField(value, ['output_file', 'outputFile'])) };
}

function mergeTask(previous: ExecutionTask, incoming: ExecutionTask): ExecutionTask {
  const useIncoming = (!terminal(previous.status) || terminal(incoming.status)) && (
    (incoming.updatedAt?.getTime() ?? 0) >= (previous.updatedAt?.getTime() ?? 0)
    || (terminal(incoming.status) && !terminal(previous.status))
  );
  const newest = useIncoming ? incoming : previous;
  const earlier = useIncoming ? previous : incoming;
  const events = [...new Map([...previous.events, ...incoming.events].map((event) => [event.id, event])).values()]
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const starts = [previous.startedAt, incoming.startedAt].filter((value): value is Date => Boolean(value));
  return {
    ...earlier, ...newest,
    id: previous.id,
    sourceMessageId: previous.sourceMessageId || incoming.sourceMessageId,
    title: previous.title || incoming.title,
    taskId: newest.taskId || earlier.taskId,
    toolUseId: newest.toolUseId || earlier.toolUseId,
    traceId: newest.traceId || earlier.traceId,
    parentAgentId: newest.parentAgentId || earlier.parentAgentId,
    parentToolUseId: newest.parentToolUseId || earlier.parentToolUseId,
    input: newest.input ?? earlier.input,
    command: newest.command || earlier.command,
    outputFile: newest.outputFile || earlier.outputFile,
    result: newest.result ?? earlier.result,
    exitCode: newest.exitCode ?? earlier.exitCode,
    startedAt: starts.sort((a, b) => a.getTime() - b.getTime())[0],
    usage: { ...earlier.usage, ...newest.usage },
    events,
  };
}

type ScopedMessage = { message: ChatMessage; trace?: SubagentTrace; identity: string };

/** Inspectable background work in one session, including child transcripts.
 * Traces supply ownership only; their existing UI remains the source of Agent
 * and Loop presentation. Every event is backed by a message or tool record. */
export function buildExecutionTasks(messages: ChatMessage[], traces: SubagentTrace[]): ExecutionTask[] {
  const traceByTool = new Map(traces.flatMap((trace) => trace.sourceToolIds.map((id) => [id, trace] as const)));
  const traceByAgent = new Map(traces.filter((trace) => trace.agentId).map((trace) => [trace.agentId!, trace]));
  const scoped = new Map<string, ScopedMessage>();
  const visit = (items: ChatMessage[], parent?: SubagentTrace, path = 'root') => {
    items.forEach((message, index) => {
      const identity = message.id || `${path}:${index}`;
      const existing = scoped.get(identity);
      if (!existing || (!existing.trace && parent)) scoped.set(identity, { message, trace: parent, identity });
      const owner = message.toolId ? traceByTool.get(message.toolId) : undefined;
      if (message.subagentState?.messages) visit(message.subagentState.messages, owner || parent, identity);
      message.hookActivity?.followups?.forEach((followup, followupIndex) => {
        if (followup.messages) visit(followup.messages, parent, `${identity}:followup:${followupIndex}`);
      });
    });
  };
  visit(messages);
  traces.forEach((trace) => visit(trace.messages, trace, trace.id));
  const toolById = new Map<string, ScopedMessage>();
  const toolsByTask = new Map<string, ScopedMessage[]>();
  for (const entry of scoped.values()) {
    if (!entry.message.isToolUse) continue;
    if (entry.message.toolId) toolById.set(entry.message.toolId, entry);
    const taskId = entry.message.toolName?.trim().toLowerCase() === 'taskoutput' ? undefined : toolTaskId(entry.message);
    if (taskId) toolsByTask.set(taskId, [...(toolsByTask.get(taskId) || []), entry]);
  }

  const tasks = new Map<string, ExecutionTask>();
  const put = (task: ExecutionTask) => {
    const previous = tasks.get(task.id);
    tasks.set(task.id, previous ? mergeTask(previous, task) : task);
  };
  const notificationTaskIdsByTool = new Map<string, Set<string>>();
  for (const { message } of scoped.values()) {
    const details = message.isTaskNotification ? message.taskNotification : undefined;
    if (details?.toolUseId && details.taskId) {
      const ids = notificationTaskIdsByTool.get(details.toolUseId) || new Set<string>();
      ids.add(details.taskId);
      notificationTaskIdsByTool.set(details.toolUseId, ids);
    }
  }

  for (const entry of scoped.values()) {
    const { message, identity } = entry;
    if (!message.isTaskNotification) continue;
    const details = message.taskNotification;
    // Agent lifecycle is already represented by its trace, not a second
    // background task. A child's Bash notification remains a separate task.
    if (details?.toolUseId && traceByTool.has(details.toolUseId)) continue;
    if (details?.taskId && !details.toolUseId && traceByAgent.has(details.taskId)) continue;
    const linkedIds = details?.toolUseId ? notificationTaskIdsByTool.get(details.toolUseId) : undefined;
    const taskId = details?.taskId || (linkedIds?.size === 1 ? [...linkedIds][0] : undefined);
    const candidates = taskId ? toolsByTask.get(taskId) : undefined;
    const source = details?.toolUseId ? toolById.get(details.toolUseId)
      : candidates?.length === 1 ? candidates[0] : undefined;
    const parent = entry.trace || source?.trace || (details?.parentAgentId ? traceByAgent.get(details.parentAgentId) : undefined);
    const input = source?.message.toolInput ?? message.toolInput;
    const command = string(object(input)?.command);
    const status = normalizeExecutionStatus(details?.status || message.taskStatus);
    const updatedAt = date(details?.updatedAt) || date(message.timestamp);
    const events = (details?.events || [{ id: identity, timestamp: message.timestamp,
      status: details?.status || message.taskStatus || 'unknown', summary: details?.summary || message.content || '',
      result: details?.result }]).flatMap((event): ExecutionTaskEvent[] => {
      const timestamp = date(event.timestamp);
      return timestamp ? [{ ...event, timestamp, status: normalizeExecutionStatus(event.status) }] : [];
    });
    put({
      id: `background:${taskId ? `task:${taskId}` : details?.toolUseId ? `tool:${details.toolUseId}` : `message:${identity}`}`,
      kind: 'background', title: string(object(input)?.description) || details?.title || details?.summary || message.content || 'Background task',
      status, summary: details?.summary || message.content, taskId,
      toolUseId: details?.toolUseId || source?.message.toolId, sourceMessageId: message.id,
      parentAgentId: details?.parentAgentId || parent?.agentId,
      parentToolUseId: details?.parentToolUseId || parent?.sourceToolIds[0], traceId: parent?.id,
      startedAt: date(source?.message.timestamp) || date(details?.startedAt) || date(message.timestamp),
      updatedAt, completedAt: terminal(status) ? date(details?.completedAt) || updatedAt : undefined,
      command, input, result: details?.result, outputFile: details?.outputFile, usage: details?.usage, events,
    });
  }

  // A Bash launch is itself real evidence of background work, even on SDK
  // versions that omit task_started. Link it to a notification when available.
  for (const entry of scoped.values()) {
    const { message, trace, identity } = entry;
    if (!message.isToolUse || message.toolName?.trim().toLowerCase() !== 'bash') continue;
    const input = object(message.toolInput);
    const taskId = toolTaskId(message);
    const asynchronousId = string(payloadField(message.toolResult, ['backgroundTaskId', 'bash_id']))
      || (typeof message.toolResult?.content === 'string'
        ? message.toolResult.content.match(/Command running in background with ID:\s*([^\s.]+)/i)?.[1] : undefined);
    if (input?.run_in_background !== true && !asynchronousId) continue;
    const existing = [...tasks.values()].find((task) => task.kind === 'background' && (
      (message.toolId && task.toolUseId === message.toolId) || (taskId && task.taskId === taskId)
    ));
    const startedAt = date(message.timestamp);
    const resultAt = date(message.toolCompletedAt) || date(message.toolResult?.timestamp);
    const output = taskOutput(message);
    const status = message.toolResult?.isError ? 'failed'
      : output.status !== 'unknown' ? output.status
        : taskId || !message.toolResult ? 'running' : 'completed';
    const command = string(input?.command);
    const id = existing?.id || `background:${taskId ? `task:${taskId}` : message.toolId ? `tool:${message.toolId}` : `message:${identity}`}`;
    const invocation: ExecutionTask = {
      id, kind: 'background', title: existing?.title || string(input?.description) || command || 'Background task',
      status, taskId, toolUseId: message.toolId, sourceMessageId: existing?.sourceMessageId || message.id,
      traceId: trace?.id, parentAgentId: trace?.agentId, parentToolUseId: trace?.sourceToolIds[0],
      startedAt, updatedAt: resultAt || startedAt, completedAt: terminal(status) ? resultAt : undefined,
      input: message.toolInput, command,
      result: output.result ?? (terminal(status) ? message.toolResult?.content : undefined),
      exitCode: output.exitCode, outputFile: output.outputFile,
      events: [
        ...(startedAt ? [{ id: `invocation:${identity}`, timestamp: startedAt, status: 'running',
          summary: string(input?.description) || command || message.toolName }] : []),
        ...(resultAt && message.toolResult ? [{ id: `result:${identity}`, timestamp: resultAt, status,
          summary: message.toolName, result: output.result ?? message.toolResult.content, exitCode: output.exitCode }] : []),
      ],
    };
    put(invocation);
  }

  // TaskOutput is an explicit read of a known background task. Its output and
  // exit code fill gaps in completion notifications, without treating a failed
  // retrieval or a delayed running snapshot as a new task failure/start.
  for (const entry of scoped.values()) {
    const { message, identity } = entry;
    if (!message.isToolUse || message.toolName?.trim().toLowerCase() !== 'taskoutput' || !message.toolResult) continue;
    const taskId = string(object(message.toolInput)?.task_id) || string(object(message.toolInput)?.taskId);
    if (!taskId) continue;
    const existing = [...tasks.values()].find((task) => task.kind === 'background' && task.taskId === taskId);
    if (!existing) continue;
    const output = taskOutput(message);
    const timestamp = date(message.toolCompletedAt) || date(message.toolResult.timestamp) || date(message.timestamp);
    const outputIsCurrent = !terminal(existing.status) || (terminal(output.status)
      && (timestamp?.getTime() ?? 0) >= (existing.updatedAt?.getTime() ?? 0));
    const status = outputIsCurrent && output.status !== 'unknown' ? output.status : existing.status;
    const statusChanged = status !== existing.status;
    const result = outputIsCurrent ? output.result ?? existing.result
      : existing.result ?? (terminal(output.status) ? output.result : undefined);
    tasks.set(existing.id, {
      ...existing,
      status, result,
      exitCode: outputIsCurrent ? output.exitCode ?? existing.exitCode : existing.exitCode ?? output.exitCode,
      outputFile: existing.outputFile || output.outputFile,
      updatedAt: outputIsCurrent ? latestDate(existing.updatedAt, timestamp) : existing.updatedAt,
      completedAt: terminal(status) ? existing.completedAt || (statusChanged ? timestamp : undefined) : undefined,
      events: [...existing.events, ...(timestamp ? [{ id: `task-output:${identity}`, timestamp,
        status: output.status, summary: message.toolName, result: output.result ?? message.toolResult.content,
        exitCode: output.exitCode }] : [])].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
    });
  }

  // A completed process may already have been reaped when TaskOutput runs.
  // If the agent has actually read the exact notification output file, expose
  // that captured text. Do not read files here or infer identity from titles.
  const outputReadTimes = new Map<string, number>();
  for (const entry of scoped.values()) {
    const { message, identity } = entry;
    if (!message.isToolUse || message.toolName?.trim().toLowerCase() !== 'read'
      || !message.toolResult || message.toolResult.isError) continue;
    const filePath = object(message.toolInput)?.file_path;
    if (typeof filePath !== 'string' || !filePath) continue;
    const matches = [...tasks.values()].filter((task) => task.kind === 'background' && task.outputFile === filePath);
    if (matches.length !== 1) continue;
    const existing = matches[0];
    const requestedAt = date(message.timestamp);
    const timestamp = date(message.toolCompletedAt) || date(message.toolResult.timestamp) || date(message.timestamp);
    if (existing.startedAt && (requestedAt || timestamp)
      && (requestedAt || timestamp)!.getTime() < existing.startedAt.getTime()) continue;
    const result = message.toolResult.content;
    if (result === undefined || result === null) continue;
    const readTime = timestamp?.getTime() ?? 0;
    const previousReadTime = outputReadTimes.get(existing.id);
    const canFillResult = previousReadTime !== undefined ? readTime >= previousReadTime
      : existing.result === undefined || existing.result === null || existing.result === '';
    if (canFillResult) outputReadTimes.set(existing.id, readTime);
    tasks.set(existing.id, {
      ...existing,
      result: canFillResult ? result : existing.result,
      events: [...existing.events, ...(timestamp ? [{ id: `output-read:${identity}`, timestamp,
        status: 'completed', summary: `Read ${filePath}`, result }] : [])]
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
    });
  }

  // Structured Bash/TaskOutput exit codes always win. Summary extraction only
  // fills the field after all observed structured results have been linked.
  for (const [id, task] of tasks) {
    if (task.kind !== 'background' || task.exitCode !== undefined) continue;
    const exitCode = notificationExitCode(task.summary);
    if (exitCode !== undefined) tasks.set(id, { ...task, exitCode });
  }

  return [...tasks.values()].sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
}
