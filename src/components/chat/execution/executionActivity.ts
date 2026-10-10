import { normalizeExecutionStatus } from './buildExecutionTasks';
import type { ExecutionTask, ExecutionTaskEvent } from './types';

export type ExecutionActivityKind = 'started' | 'progress' | 'waiting' | 'completed'
  | 'failed' | 'stopped' | 'unknown' | 'result' | 'output';
export type ExecutionActivityItem = ExecutionTaskEvent & { kind: ExecutionActivityKind };

const terminal = (status: string) => ['completed', 'failed', 'stopped'].includes(status);
const genericUpdate = (summary: string) => /^Background task updated\.?$/i.test(summary.trim());
const hasResult = (event: ExecutionTaskEvent) => event.result !== undefined && event.result !== null;
const hasOutput = (event: ExecutionTaskEvent) => event.result !== undefined && event.result !== null
  && event.result !== '';
const terminalReceiptKey = (event: ExecutionActivityItem) => JSON.stringify([
  event.kind, event.summary.trim(), event.exitCode ?? null,
]);

/** Display one execution timeline, rather than treating each lifecycle receipt
 * as another current task. Keep the source events intact for history recovery. */
export function buildExecutionActivity(task: ExecutionTask): ExecutionActivityItem[] {
  const ordered = [...task.events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const items = ordered.flatMap((event): ExecutionActivityItem[] => {
    if (event.id.startsWith('task-output:')) return [{ ...event, kind: 'result' }];
    if (event.id.startsWith('output-read:')) return [{ ...event, kind: 'output' }];
    const status = normalizeExecutionStatus(event.status);
    if (event.id.startsWith('invocation:')) return [{ ...event, kind: 'started' }];
    if (event.id.startsWith('result:') && !terminal(status)) {
      // An empty Bash launch receipt (or its display text) is not a second start
      // or a progress update. Partial stdout remains an inspectable output event.
      if (!hasOutput(event) || (typeof event.result === 'string'
        && /^Command running in background with ID:/i.test(event.result.trim()))) return [];
      return [{ ...event, kind: 'output' }];
    }
    if (status === 'running') {
      const summary = event.summary.trim();
      const startReceipt = !hasOutput(event) && (summary === task.title.trim()
        || (task.command && summary === task.command.trim())
        || /^Background task started\.?$/i.test(summary));
      return [{ ...event, kind: startReceipt ? 'started' : 'progress' }];
    }
    return [{ ...event, kind: status }];
  });

  const start = items.find((item) => item.kind === 'started');
  const informativeTerminal = new Set(items.filter((item) => terminal(item.kind)
    && !genericUpdate(item.summary)).map((item) => item.kind));
  const latestTerminalByReceipt = new Map<string, ExecutionActivityItem>();
  for (const item of items) {
    if (terminal(item.kind) && !hasResult(item)) {
      latestTerminalByReceipt.set(terminalReceiptKey(item), item);
    }
  }

  return items.filter((item) => {
    if (item.kind === 'started' && item !== start && !hasOutput(item)) return false;
    if (!terminal(item.kind) || hasResult(item)) return true;
    if (genericUpdate(item.summary) && informativeTerminal.has(item.kind)) return false;
    return latestTerminalByReceipt.get(terminalReceiptKey(item)) === item;
  });
}
