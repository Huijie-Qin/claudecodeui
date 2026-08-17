import { useId, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Braces,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  FileOutput,
  FileText,
  Globe2,
  LoaderCircle,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';

import type { SubagentActivity, SubagentActivityStatus } from './types';

export interface SubagentActivityItemProps {
  activity: SubagentActivity;
  isLast?: boolean;
}

const STATUS_STYLES: Record<SubagentActivityStatus, {
  icon: LucideIcon;
  iconClassName: string;
  markerClassName: string;
}> = {
  running: {
    icon: LoaderCircle,
    iconClassName: 'animate-spin text-blue-600 dark:text-blue-400',
    markerClassName: 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/70',
  },
  completed: {
    icon: CheckCircle2,
    iconClassName: 'text-emerald-600 dark:text-emerald-400',
    markerClassName: 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/70',
  },
  error: {
    icon: CircleAlert,
    iconClassName: 'text-red-600 dark:text-red-400',
    markerClassName: 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/70',
  },
};

function getToolIcon(toolName: string): LucideIcon {
  const normalizedName = toolName.trim().toLowerCase();

  if (normalizedName === 'bash' || normalizedName.includes('shell')) return Terminal;
  if (normalizedName === 'read') return FileText;
  if (['write', 'edit', 'applypatch'].includes(normalizedName)) return Pencil;
  if (['grep', 'glob', 'search'].some((name) => normalizedName.includes(name))) return Search;
  if (normalizedName.includes('web')) return Globe2;
  if (normalizedName === 'task' || normalizedName === 'agent') return Bot;
  return Wrench;
}

function formatDisplayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';

  try {
    return JSON.stringify(
      value,
      (_key, nestedValue) => (
        typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
      ),
      2,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

function getActivityTime(timestamp: Date): { dateTime?: string; label: string } {
  if (!Number.isFinite(timestamp.getTime())) return { label: '' };

  return {
    dateTime: timestamp.toISOString(),
    label: new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(timestamp),
  };
}

function getActivitySummary(activity: SubagentActivity): string {
  const summary = activity.summary.trim();
  const toolName = activity.toolName.trim();
  const normalizedSummary = summary.toLowerCase();
  const normalizedToolName = toolName.toLowerCase();

  if (normalizedSummary === normalizedToolName) return '';
  if (normalizedSummary.startsWith(`${normalizedToolName} `)) {
    return summary.slice(toolName.length).trim();
  }
  return summary;
}

export function SubagentActivityItem({
  activity,
  isLast = false,
}: SubagentActivityItemProps) {
  const { t } = useTranslation('chat');
  const [isInputOpen, setIsInputOpen] = useState(false);
  const [isResultOpen, setIsResultOpen] = useState(false);
  const inputContentId = useId();
  const resultContentId = useId();

  const statusStyle = STATUS_STYLES[activity.status];
  const StatusIcon = statusStyle.icon;
  const ToolIcon = getToolIcon(activity.toolName);
  const activityTime = useMemo(
    () => getActivityTime(activity.timestamp),
    [activity.timestamp],
  );
  const inputText = useMemo(
    () => formatDisplayValue(activity.toolInput),
    [activity.toolInput],
  );
  const resultText = useMemo(
    () => formatDisplayValue(
      activity.toolResult?.content
      ?? activity.toolResult?.toolUseResult
      ?? activity.toolResult,
    ),
    [activity.toolResult],
  );
  const activitySummary = getActivitySummary(activity);
  const hasInput = activity.toolInput !== undefined && activity.toolInput !== null;
  const hasResult = activity.toolResult !== null;

  const statusLabel = t(`subagentPanel.status.${activity.status}`, {
    defaultValue: activity.status === 'running'
      ? 'Running'
      : activity.status === 'completed'
        ? 'Completed'
        : 'Failed',
  });

  return (
    <li className="relative pl-10">
      {!isLast && (
        <span
          aria-hidden="true"
          className="absolute -bottom-5 left-[17px] top-9 w-px bg-border"
        />
      )}

      <div
        className={cn(
          'absolute left-1 top-0 flex h-7 w-7 items-center justify-center rounded-full border',
          statusStyle.markerClassName,
        )}
      >
        <ToolIcon aria-hidden="true" className="h-3.5 w-3.5 text-foreground/75" />
      </div>

      <article
        aria-label={t('subagentPanel.activity.ariaLabel', {
          defaultValue: '{{toolName}} tool activity',
          toolName: activity.toolName,
        })}
        className="min-w-0 rounded-lg border border-border/70 bg-card/40 p-3 shadow-sm"
      >
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-semibold text-foreground">
                {activity.toolName}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <StatusIcon aria-hidden="true" className={cn('h-3 w-3', statusStyle.iconClassName)} />
                <span className="sr-only">{statusLabel}</span>
              </span>
              {activityTime.label && (
                <time
                  className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
                  dateTime={activityTime.dateTime}
                >
                  {activityTime.label}
                </time>
              )}
            </div>

            {activitySummary && (
              <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                {activitySummary}
              </p>
            )}
          </div>
        </div>

        {(hasInput || hasResult) && (
          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/50 pt-2">
            {hasInput && (
              <button
                type="button"
                aria-controls={inputContentId}
                aria-expanded={isInputOpen}
                onClick={() => setIsInputOpen((isOpen) => !isOpen)}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Braces aria-hidden="true" className="h-3 w-3" />
                {t('subagentPanel.activity.parameters', { defaultValue: 'Parameters' })}
                <ChevronDown
                  aria-hidden="true"
                  className={cn('h-3 w-3 transition-transform', isInputOpen && 'rotate-180')}
                />
              </button>
            )}

            {hasResult && (
              <button
                type="button"
                aria-controls={resultContentId}
                aria-expanded={isResultOpen}
                onClick={() => setIsResultOpen((isOpen) => !isOpen)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  activity.status === 'error' && 'text-red-600 dark:text-red-400',
                )}
              >
                <FileOutput aria-hidden="true" className="h-3 w-3" />
                {t('subagentPanel.activity.result', { defaultValue: 'Result' })}
                <ChevronDown
                  aria-hidden="true"
                  className={cn('h-3 w-3 transition-transform', isResultOpen && 'rotate-180')}
                />
              </button>
            )}
          </div>
        )}

        {hasInput && isInputOpen && (
          <div id={inputContentId} className="mt-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {t('subagentPanel.activity.parameters', { defaultValue: 'Parameters' })}
            </div>
            <pre
              tabIndex={0}
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/50 p-2 font-mono text-[11px] leading-5 text-foreground/85"
            >
              {inputText}
            </pre>
          </div>
        )}

        {hasResult && isResultOpen && (
          <div id={resultContentId} className="mt-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {t('subagentPanel.activity.result', { defaultValue: 'Result' })}
            </div>
            <pre
              tabIndex={0}
              className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/50 p-2 font-mono text-[11px] leading-5 text-foreground/85',
                activity.status === 'error' && 'border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30',
              )}
            >
              {resultText}
            </pre>
          </div>
        )}
      </article>
    </li>
  );
}
