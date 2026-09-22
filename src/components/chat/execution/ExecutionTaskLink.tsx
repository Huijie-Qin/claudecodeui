import {
  CheckCircle2, CircleAlert, CircleHelp, CircleStop,
  LoaderCircle, PanelRightOpen, PauseCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';

import { redactVisibleSecretText } from './display';
import type { ExecutionTask, ExecutionTaskStatus } from './types';

const STATUS_PRESENTATION = {
  running: { label: 'Running', icon: LoaderCircle, classes: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300' },
  waiting: { label: 'Needs attention', icon: PauseCircle, classes: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300' },
  completed: { label: 'Completed', icon: CheckCircle2, classes: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300' },
  failed: { label: 'Failed', icon: CircleAlert, classes: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300' },
  stopped: { label: 'Stopped', icon: CircleStop, classes: 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300' },
  unknown: { label: 'Status unavailable', icon: CircleHelp, classes: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400' },
} as const;

export function ExecutionTaskStatusBadge({ status }: { status: ExecutionTaskStatus }) {
  const { t } = useTranslation('chat');
  const presentation = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.unknown;
  const Icon = presentation.icon;

  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4', presentation.classes)}>
      <Icon aria-hidden="true" className={cn('h-3 w-3', status === 'running' && 'motion-safe:animate-spin')} />
      {t(`execution.status.${status}`, { defaultValue: presentation.label })}
    </span>
  );
}

export function ExecutionTaskLink({
  task,
  onOpen,
}: {
  task: ExecutionTask;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation('chat');
  const title = redactVisibleSecretText(task.title);
  const presentation = STATUS_PRESENTATION[task.status] ?? STATUS_PRESENTATION.unknown;
  const Icon = presentation.icon;
  const statusLabel = t(`execution.status.${task.status}`, {
    defaultValue: presentation.label,
  });
  const kindLabel = t('execution.kind.background', { defaultValue: 'Background task' });

  return (
    <button
      type="button"
      data-execution-task-id={task.id}
      onClick={() => onOpen(task.id)}
      aria-label={`${title} · ${statusLabel}`}
      title={`${kindLabel} / ${title} · ${statusLabel}`}
      className="group flex min-h-6 w-full min-w-0 items-center gap-1.5 py-0.5 text-left text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon aria-hidden="true" className={cn(
        'h-3 w-3 shrink-0',
        task.status === 'running' && 'text-blue-600 motion-safe:animate-spin dark:text-blue-400',
        task.status === 'waiting' && 'text-amber-600 dark:text-amber-400',
        task.status === 'completed' && 'text-emerald-600 dark:text-emerald-400',
        task.status === 'failed' && 'text-red-600 dark:text-red-400',
      )} />
      <span className="shrink-0 font-medium">{kindLabel}</span>
      <span aria-hidden="true" className="shrink-0 text-[10px] text-muted-foreground/40">/</span>
      <span className="min-w-0 flex-1 truncate font-mono text-primary transition-colors group-hover:text-primary/80 group-hover:underline">{title}</span>
      <span className="shrink-0 text-[10px]">{statusLabel}</span>
      <PanelRightOpen aria-hidden="true" className="ml-1 h-3.5 w-3.5 shrink-0 transition-colors group-hover:text-foreground" />
    </button>
  );
}
