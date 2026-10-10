import { ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatExecutionValue, redactVisibleSecretText } from './display';
import type { ExecutionActivityItem } from './executionActivity';

const ACTIVITY_LABELS = {
  started: 'Started',
  progress: 'Progress reported',
  waiting: 'Wait recorded',
  completed: 'Execution completed',
  failed: 'Execution failed',
  stopped: 'Execution stopped',
  unknown: 'Execution recorded',
  result: 'Result queried',
  output: 'Output reported',
} as const;

export function ExecutionTaskActivity({ items }: { items: ExecutionActivityItem[] }) {
  const { t, i18n } = useTranslation('chat');
  const dateLabel = (date: Date) => Number.isFinite(date.getTime())
    ? date.toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  return (
    <>
      <p className="rounded-md bg-blue-50 px-3 py-2 text-[11px] leading-5 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">{t('execution.activityNotice', { defaultValue: 'The status above shows the task’s current state. These records show its execution history.' })}</p>
      {items.length === 0 ? (
        <div className="py-8 text-center">
          <ListChecks aria-hidden="true" className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <p className="text-xs leading-6 text-muted-foreground">{t('execution.noEvents', { defaultValue: 'No execution events have been recorded for this task.' })}</p>
        </div>
      ) : (
        <ol className="space-y-3">
          {items.map((event) => (
            <li key={event.id} data-execution-event-kind={event.kind} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground">{t(`execution.activity.${event.kind}`, { defaultValue: ACTIVITY_LABELS[event.kind] })}</span>
                <time dateTime={Number.isFinite(event.timestamp.getTime()) ? event.timestamp.toISOString() : undefined} className="text-[10px] tabular-nums text-muted-foreground">{dateLabel(event.timestamp)}</time>
              </div>
              <p className="whitespace-pre-wrap break-words text-xs leading-6">{redactVisibleSecretText(event.summary)}</p>
              {event.result !== undefined && event.result !== null && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] font-medium text-blue-600 dark:text-blue-400">{t('execution.eventOutput', { defaultValue: 'View reported output' })}</summary>
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-5 text-foreground [overflow-wrap:anywhere]">{formatExecutionValue(event.result)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
