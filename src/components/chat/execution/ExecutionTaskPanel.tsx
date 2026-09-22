import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowUpRight, Bot, Clock3, FileText, ListChecks, Terminal, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';

import { ExecutionTaskStatusBadge } from './ExecutionTaskLink';
import { formatExecutionValue, redactVisibleSecretText } from './display';
import type { ExecutionTask, ExecutionTaskStatus } from './types';

export interface ExecutionTaskPanelProps {
  task: ExecutionTask;
  mode: 'docked' | 'drawer';
  onClose: () => void;
  onLocateTask?: (task: ExecutionTask) => void;
  onOpenParent?: (task: ExecutionTask) => void;
  onFileOpen?: (path: string) => void;
  outputFileUnavailableReason?: string;
}

type PanelTab = 'overview' | 'activity' | 'result';
const TABS: PanelTab[] = ['overview', 'activity', 'result'];
const TAB_DEFAULTS = { overview: 'Overview', activity: 'Activity', result: 'Result' };
const FOCUSABLE = 'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const ACTION_CLASSES = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function isKnownStatus(status: string): status is ExecutionTaskStatus {
  return ['running', 'waiting', 'completed', 'failed', 'stopped', 'unknown'].includes(status);
}

function initialTab(task: ExecutionTask): PanelTab {
  return task.status === 'completed' && formatExecutionValue(task.result) ? 'result' : 'overview';
}

function Payload({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-5 text-foreground [overflow-wrap:anywhere]">
      {formatExecutionValue(value)}
    </pre>
  );
}

export function ExecutionTaskPanel({
  task, mode, onClose, onLocateTask, onOpenParent, onFileOpen, outputFileUnavailableReason,
}: ExecutionTaskPanelProps) {
  const { t, i18n } = useTranslation('chat');
  const titleId = useId();
  const tabId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [tab, setTab] = useState<PanelTab>(() => initialTab(task));
  const selectedTaskId = useRef(task.id);
  const result = formatExecutionValue(task.result);
  const summary = redactVisibleSecretText(task.summary || task.events[task.events.length - 1]?.summary);
  const hasParent = Boolean(task.parentAgentId || task.parentToolUseId);
  const dateLabel = (date?: Date) => date && Number.isFinite(date.getTime())
    ? date.toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  useEffect(() => {
    if (selectedTaskId.current !== task.id) {
      selectedTaskId.current = task.id;
      setTab(initialTab(task));
      panelRef.current?.querySelector('[data-execution-scroll]')?.scrollTo({ top: 0 });
    }
  }, [task]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusInside = panel.contains(document.activeElement);
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !event.repeat && (mode === 'drawer' || focusInside)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (mode !== 'drawer' || event.key !== 'Tab') return;
      const elements = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) {
        event.preventDefault();
        closeButtonRef.current?.focus();
      } else if (event.shiftKey && (!focusInside || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!focusInside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [mode]);

  const outputFile = task.outputFile ? (
    <div data-execution-output-file className="rounded-lg border border-border bg-background p-3">
      <p className="mb-2 text-[11px] font-medium text-muted-foreground">{t('execution.outputFile', { defaultValue: 'Output file' })}</p>
      {onFileOpen && !outputFileUnavailableReason ? (
        <button type="button" onClick={() => onFileOpen(task.outputFile!)} className="flex w-full items-start gap-2 rounded text-left text-xs text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-400">
          <FileText aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-all">{redactVisibleSecretText(task.outputFile)}</span>
          <ArrowUpRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        </button>
      ) : <p className="break-all font-mono text-[11px]">{redactVisibleSecretText(task.outputFile)}</p>}
      {outputFileUnavailableReason && <p data-execution-output-unavailable className="mt-2 text-[11px] leading-5 text-muted-foreground">{redactVisibleSecretText(outputFileUnavailableReason)}</p>}
    </div>
  ) : null;

  return (
    <>
      {mode === 'drawer' && <button type="button" tabIndex={-1} aria-label={t('execution.close', { defaultValue: 'Close task details' })} onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-[1px]" />}
      <aside
        ref={panelRef}
        id="execution-task-panel"
        data-execution-task-panel={task.id}
        role={mode === 'drawer' ? 'dialog' : 'complementary'}
        aria-modal={mode === 'drawer' ? true : undefined}
        aria-labelledby={titleId}
        className={cn('flex min-h-0 flex-col overflow-hidden border-l border-border bg-background text-foreground', mode === 'drawer' ? 'fixed inset-y-0 right-0 z-50 w-full shadow-2xl sm:max-w-md' : 'relative h-full w-full')}
      >
        <header className="shrink-0 border-b border-border px-4 pb-3 pt-3">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300"><Terminal aria-hidden="true" className="h-4 w-4" /></span>
            <h2 id={titleId} className="min-w-0 flex-1 text-sm font-semibold">{t('execution.details', { defaultValue: 'Task details' })}</h2>
            <button ref={closeButtonRef} type="button" onClick={onClose} aria-label={t('execution.close', { defaultValue: 'Close task details' })} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X aria-hidden="true" className="h-4 w-4" /></button>
          </div>
          <p className="mt-3 break-words text-sm font-medium leading-6">{redactVisibleSecretText(task.title)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ExecutionTaskStatusBadge status={task.status} />
            <span className="text-[11px] text-muted-foreground">{t('execution.kind.background', { defaultValue: 'Background task' })}</span>
            {typeof task.exitCode === 'number' && Number.isFinite(task.exitCode) && <span data-execution-exit-code={task.exitCode} className="text-[11px] tabular-nums text-muted-foreground">{t('execution.exitCode', { code: task.exitCode, defaultValue: 'Exit code: {{code}}' })}</span>}
          </div>
          {((task.sourceMessageId && onLocateTask) || (hasParent && onOpenParent)) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {task.sourceMessageId && onLocateTask && <button type="button" onClick={() => onLocateTask(task)} className={ACTION_CLASSES}><ArrowUpRight aria-hidden="true" className="h-3 w-3" />{t('execution.locateSource', { defaultValue: 'Locate in conversation' })}</button>}
              {hasParent && onOpenParent && <button type="button" onClick={() => onOpenParent(task)} className={ACTION_CLASSES}><Bot aria-hidden="true" className="h-3 w-3" />{t('execution.openParent', { defaultValue: 'Open parent subagent' })}</button>}
            </div>
          )}
        </header>

        <div role="tablist" aria-label={t('execution.detailSections', { defaultValue: 'Task detail sections' })} className="flex shrink-0 border-b border-border px-4">
          {TABS.map((item) => (
            <button
              key={item}
              ref={(element) => { tabRefs.current[item] = element; }}
              id={`${tabId}-${item}`}
              type="button"
              role="tab"
              data-execution-tab={item}
              aria-selected={tab === item}
              aria-controls={`${tabId}-content`}
              tabIndex={tab === item ? 0 : -1}
              onClick={() => setTab(item)}
              onKeyDown={(event) => {
                const index = TABS.indexOf(item);
                const next = event.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length]
                  : event.key === 'ArrowLeft' ? TABS[(index + TABS.length - 1) % TABS.length]
                    : event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[TABS.length - 1] : null;
                if (next) { event.preventDefault(); setTab(next); tabRefs.current[next]?.focus(); }
              }}
              className={cn('flex min-h-10 flex-1 items-center justify-center gap-1.5 border-b-2 px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', tab === item ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {t(`execution.tabs.${item}`, { defaultValue: TAB_DEFAULTS[item] })}
              {item === 'activity' && task.events.length > 0 && <span className="rounded bg-muted px-1 text-[10px] tabular-nums">{task.events.length}</span>}
            </button>
          ))}
        </div>

        <div id={`${tabId}-content`} role="tabpanel" tabIndex={0} aria-labelledby={`${tabId}-${tab}`} data-execution-view={tab} data-execution-scroll className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          {tab === 'overview' && (
            <>
              <section className="rounded-lg border border-border bg-muted/20 p-3">
                <h3 className="mb-1.5 text-xs font-medium">{t('execution.latestProgress', { defaultValue: 'Latest progress' })}</h3>
                <p className="whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">{summary || t('execution.noProgress', { defaultValue: 'The runtime has not reported progress details yet.' })}</p>
              </section>
              {(task.startedAt || task.updatedAt || task.completedAt) && (
                <dl className="space-y-2 text-[11px]">
                  {([['startedAt', task.startedAt, 'Started'], ['updatedAt', task.updatedAt, 'Last update'], ['completedAt', task.completedAt, 'Finished']] as const).map(([key, value, label]) => value && (
                    <div key={key} className="flex flex-wrap items-center justify-between gap-2"><dt className="flex items-center gap-1.5 text-muted-foreground"><Clock3 aria-hidden="true" className="h-3 w-3" />{t(`execution.${key}`, { defaultValue: label })}</dt><dd className="tabular-nums">{dateLabel(value)}</dd></div>
                  ))}
                </dl>
              )}
              {task.command && <section><h3 className="mb-2 text-xs font-medium">{t('execution.command', { defaultValue: 'Command' })}</h3><Payload value={task.command} /></section>}
              {task.input !== undefined && task.input !== null && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('execution.input', { defaultValue: 'Task input' })}</summary><div className="mt-3"><Payload value={task.input} /></div></details>}
              {outputFile}
              {Object.keys(task.usage ?? {}).length > 0 && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">{t('execution.usage', { defaultValue: 'Usage reported by runtime' })}</summary><div className="mt-3"><Payload value={task.usage} /></div></details>}
              {(task.taskId || task.toolUseId) && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">{t('execution.identifiers', { defaultValue: 'Task identifiers' })}</summary><dl className="mt-3 space-y-2 text-[11px]">{task.taskId && <div><dt className="text-muted-foreground">{t('execution.taskId', { defaultValue: 'Task ID' })}</dt><dd className="mt-1 break-all font-mono">{redactVisibleSecretText(task.taskId)}</dd></div>}{task.toolUseId && <div><dt className="text-muted-foreground">{t('execution.toolId', { defaultValue: 'Tool call ID' })}</dt><dd className="mt-1 break-all font-mono">{redactVisibleSecretText(task.toolUseId)}</dd></div>}</dl></details>}
            </>
          )}

          {tab === 'activity' && (
            <>
              <p className="rounded-md bg-blue-50 px-3 py-2 text-[11px] leading-5 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">{t('execution.activityNotice', { defaultValue: 'These are events reported by the runtime. Open the output file, when available, to inspect additional logs.' })}</p>
              {task.events.length === 0 ? <div className="py-8 text-center"><ListChecks aria-hidden="true" className="mx-auto mb-3 h-6 w-6 text-muted-foreground" /><p className="text-xs leading-6 text-muted-foreground">{t('execution.noEvents', { defaultValue: 'No execution events have been recorded for this task.' })}</p></div> : (
                <ol className="space-y-3">
                  {task.events.map((event) => (
                    <li key={event.id} className="rounded-lg border border-border p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><ExecutionTaskStatusBadge status={isKnownStatus(event.status) ? event.status : 'unknown'} /><time dateTime={Number.isFinite(event.timestamp.getTime()) ? event.timestamp.toISOString() : undefined} className="text-[10px] tabular-nums text-muted-foreground">{dateLabel(event.timestamp)}</time></div>
                      <p className="whitespace-pre-wrap break-words text-xs leading-6">{redactVisibleSecretText(event.summary)}</p>
                      {event.result !== undefined && event.result !== null && <details className="mt-2"><summary className="cursor-pointer text-[11px] font-medium text-blue-600 dark:text-blue-400">{t('execution.eventOutput', { defaultValue: 'View reported output' })}</summary><div className="mt-2"><Payload value={event.result} /></div></details>}
                    </li>
                  ))}
                </ol>
              )}
              {outputFile}
            </>
          )}

          {tab === 'result' && (
            <>
              <section>
                <h3 className="mb-2 text-xs font-medium">{t('execution.reportedResult', { defaultValue: 'Reported result' })}</h3>
                {result ? <Payload value={task.result} /> : <p className="rounded-lg border border-dashed border-border px-3 py-5 text-xs leading-6 text-muted-foreground">{t('execution.noResult', { defaultValue: 'No result body has been reported. Check the activity records or output file for available details.' })}</p>}
              </section>
              {outputFile}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
