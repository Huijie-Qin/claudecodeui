import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  LoaderCircle,
  PauseCircle,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { AskUserQuestionPanel } from '../tools/components/InteractiveRenderers';
import type { PendingPermissionRequest } from '../types/types';

import { SubagentActivityItem } from './SubagentActivityItem';
import type { SubagentTrace, SubagentTraceStatus } from './types';

export interface SubagentPanelProps {
  traces: SubagentTrace[];
  selectedTraceId: string | null;
  onSelectTrace: (id: string) => void;
  onClose: () => void;
  mode: 'docked' | 'drawer';
  permissionRequests?: PendingPermissionRequest[];
  onPermissionDecision?: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; updatedInput?: unknown },
  ) => void;
}

const STATUS_STYLES: Record<SubagentTraceStatus, {
  icon: LucideIcon;
  className: string;
  dotClassName: string;
  iconClassName: string;
}> = {
  running: {
    icon: LoaderCircle,
    className: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300',
    dotClassName: 'bg-blue-500',
    iconClassName: 'text-blue-600 dark:text-blue-400',
  },
  waiting: {
    icon: PauseCircle,
    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
    dotClassName: 'bg-amber-500',
    iconClassName: 'text-amber-600 dark:text-amber-400',
  },
  completed: {
    icon: CheckCircle2,
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300',
    dotClassName: 'bg-emerald-500',
    iconClassName: 'text-emerald-600 dark:text-emerald-400',
  },
  error: {
    icon: CircleAlert,
    className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300',
    dotClassName: 'bg-red-500',
    iconClassName: 'text-red-600 dark:text-red-400',
  },
};

const BOTTOM_THRESHOLD_PX = 48;
const DRAWER_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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

type ContentRevisionEntry = {
  value: unknown;
  revision: number;
};

type ContentRevisionCache = Map<string, ContentRevisionEntry>;

function observeContentRevision(
  cache: ContentRevisionCache,
  key: string,
  value: unknown,
): number {
  const current = cache.get(key);
  if (!current) {
    cache.set(key, { value, revision: 0 });
    return 0;
  }
  if (Object.is(current.value, value)) return current.revision;
  current.value = value;
  current.revision += 1;
  return current.revision;
}

function getContentVersion(
  trace: SubagentTrace | null,
  selectionKey: string | undefined,
  revisionCache: ContentRevisionCache,
): string {
  if (!trace) return 'empty';
  const traceKey = selectionKey || trace.id;

  const activityVersion = trace.activities.map((activity) => (
    [
      activity.id,
      activity.toolName,
      activity.status,
      activity.summary,
      activity.timestamp.getTime(),
      observeContentRevision(
        revisionCache,
        `${traceKey}:${activity.id}:input`,
        activity.toolInput,
      ),
      observeContentRevision(
        revisionCache,
        `${traceKey}:${activity.id}:result`,
        activity.toolResult?.content
        ?? activity.toolResult?.toolUseResult
        ?? (activity.toolResult ? activity.status : null),
      ),
    ].join(':')
  )).join('|');
  const usageVersion = Object.entries(trace.usage)
    .map(([name, value]) => `${name}:${String(value)}`)
    .join('|');

  return [
    trace.status,
    activityVersion,
    observeContentRevision(revisionCache, `${traceKey}:final-result`, trace.result),
    usageVersion,
  ].join('::');
}

function formatUsageName(name: string): string {
  const normalized = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : name;
}

function getStatusDefaultLabel(status: SubagentTraceStatus): string {
  switch (status) {
    case 'running': return 'Running';
    case 'waiting': return 'Waiting';
    case 'completed': return 'Completed';
    case 'error': return 'Failed';
  }
}

export function SubagentPanel({
  traces,
  selectedTraceId,
  onSelectTrace,
  onClose,
  mode,
  permissionRequests = [],
  onPermissionDecision,
}: SubagentPanelProps) {
  const { t } = useTranslation('chat');
  const panelTitleId = useId();
  const promptContentId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const isAtBottomRef = useRef(true);
  const previousSnapshotRef = useRef({ traceId: '', count: 0, version: '' });
  const contentRevisionCacheRef = useRef<ContentRevisionCache>(new Map());
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [newUpdateCount, setNewUpdateCount] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const selectedTrace = useMemo(
    () => traces.find((trace) => trace.id === selectedTraceId)
      ?? traces.find((trace) => (
        selectedTraceId !== null && trace.sourceToolIds.includes(selectedTraceId)
      ))
      ?? traces[0]
      ?? null,
    [selectedTraceId, traces],
  );
  const activeTraceId = selectedTrace && selectedTraceId
    && selectedTrace.sourceToolIds.includes(selectedTraceId)
    ? selectedTraceId
    : selectedTrace?.id;
  const activeTraceStatus = selectedTrace?.status;
  const contentVersion = useMemo(
    () => getContentVersion(
      selectedTrace,
      activeTraceId,
      contentRevisionCacheRef.current,
    ),
    [activeTraceId, selectedTrace],
  );
  const usageEntries = useMemo(
    () => Object.entries(selectedTrace?.usage ?? {}),
    [selectedTrace?.usage],
  );
  const finalResultText = useMemo(
    () => formatDisplayValue(selectedTrace?.result),
    [selectedTrace?.result],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const node = scrollContainerRef.current;
    if (!node) return;

    node.scrollTo({ top: node.scrollHeight, behavior });
    isAtBottomRef.current = true;
    setNewUpdateCount(0);
  }, []);

  useEffect(() => {
    if (!activeTraceStatus || !['running', 'waiting'].includes(activeTraceStatus)) return undefined;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeTraceId, activeTraceStatus]);

  useEffect(() => {
    setIsPromptOpen(false);
  }, [activeTraceId]);

  useEffect(() => {
    if (mode !== 'drawer') return undefined;

    const handleDrawerKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) return;
        const focusableElements = [...panel.querySelectorAll<HTMLElement>(
          DRAWER_FOCUSABLE_SELECTOR,
        )].filter((element) => element.offsetParent !== null);
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (!firstElement || !lastElement) {
          event.preventDefault();
          closeButtonRef.current?.focus();
          return;
        }

        const activeElement = document.activeElement;
        if (
          event.shiftKey &&
          (activeElement === firstElement || !panel.contains(activeElement))
        ) {
          event.preventDefault();
          lastElement.focus();
        } else if (
          !event.shiftKey &&
          (activeElement === lastElement || !panel.contains(activeElement))
        ) {
          event.preventDefault();
          firstElement.focus();
        }
        return;
      }

      if (
        event.key !== 'Escape' ||
        event.repeat ||
        event.defaultPrevented ||
        event.isComposing
      ) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[data-subagent-question-panel]')
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };

    window.addEventListener('keydown', handleDrawerKeyDown, true);
    return () => window.removeEventListener('keydown', handleDrawerKeyDown, true);
  }, [mode, onClose]);

  useEffect(() => {
    if (permissionRequests.length > 0) return undefined;
    const animationFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [mode, permissionRequests.length]);

  useLayoutEffect(() => {
    const traceId = activeTraceId ?? '';
    const activityCount = selectedTrace?.activities.length ?? 0;
    const previousSnapshot = previousSnapshotRef.current;
    const isNewSelection = previousSnapshot.traceId !== traceId;

    previousSnapshotRef.current = {
      traceId,
      count: activityCount,
      version: contentVersion,
    };

    if (isNewSelection) {
      isAtBottomRef.current = true;
      setNewUpdateCount(0);
      const animationFrame = window.requestAnimationFrame(() => scrollToBottom());
      return () => window.cancelAnimationFrame(animationFrame);
    }

    if (previousSnapshot.version === contentVersion) return undefined;

    if (isAtBottomRef.current) {
      const animationFrame = window.requestAnimationFrame(() => scrollToBottom());
      return () => window.cancelAnimationFrame(animationFrame);
    }

    const addedActivities = Math.max(0, activityCount - previousSnapshot.count);
    setNewUpdateCount((count) => count + Math.max(1, addedActivities));
    return undefined;
  }, [activeTraceId, contentVersion, scrollToBottom, selectedTrace?.activities.length]);

  const handleTimelineScroll = useCallback(() => {
    const node = scrollContainerRef.current;
    if (!node) return;

    const isAtBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD_PX;
    isAtBottomRef.current = isAtBottom;
    if (isAtBottom) setNewUpdateCount(0);
  }, []);

  const status = selectedTrace?.status ?? 'waiting';
  const statusStyle = STATUS_STYLES[status];
  const StatusIcon = statusStyle.icon;
  const statusLabel = t(`subagentPanel.status.${status}`, {
    defaultValue: getStatusDefaultLabel(status),
  });
  const startedAt = selectedTrace?.startedAt.getTime();
  const endedAt = selectedTrace?.completedAt?.getTime() ?? now;
  const durationMilliseconds = startedAt !== undefined
    && Number.isFinite(startedAt)
    && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt)
    : 0;
  const totalSeconds = Math.floor(durationMilliseconds / 1000);
  const durationLabel = totalSeconds < 60
    ? t('subagentPanel.duration.seconds', {
        count: totalSeconds,
        defaultValue: '{{count}}s',
      })
    : t('subagentPanel.duration.minutesSeconds', {
        minutes: Math.floor(totalSeconds / 60),
        seconds: totalSeconds % 60,
        defaultValue: '{{minutes}}m {{seconds}}s',
      });
  const hasFinalResult = Boolean(
    selectedTrace &&
    (selectedTrace.status === 'completed' || selectedTrace.status === 'error') &&
    selectedTrace.result !== undefined &&
    selectedTrace.result !== null,
  );

  return (
    <>
      {mode === 'drawer' && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('subagentPanel.close', { defaultValue: 'Close subagent panel' })}
          onClick={onClose}
          className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-[1px]"
        />
      )}

      <aside
        ref={panelRef}
        id="subagent-activity-panel"
        role={mode === 'drawer' ? 'dialog' : 'complementary'}
        aria-modal={mode === 'drawer' ? true : undefined}
        aria-labelledby={panelTitleId}
        data-subagent-panel="true"
        className={cn(
          'flex min-h-0 flex-col overflow-hidden border-l border-border bg-background text-foreground',
          mode === 'drawer'
            ? 'fixed inset-y-0 right-0 z-50 w-full shadow-2xl sm:max-w-md'
            : 'relative h-full w-full',
        )}
      >
        <header className="shrink-0 border-b border-border bg-background/95 px-4 pb-3 pt-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-100 text-purple-700 dark:bg-purple-950/70 dark:text-purple-300">
              <Bot aria-hidden="true" className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id={panelTitleId} className="truncate text-sm font-semibold">
                {t('subagentPanel.title', { defaultValue: 'Subagent activity' })}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {t('subagentPanel.agentCount', {
                  count: traces.length,
                  defaultValue: traces.length === 1 ? '{{count}} agent' : '{{count}} agents',
                })}
              </p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label={t('subagentPanel.close', { defaultValue: 'Close subagent panel' })}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>

          <div className="relative mt-3">
            <label htmlFor={`${panelTitleId}-agent-select`} className="sr-only">
              {t('subagentPanel.selectAgent', { defaultValue: 'Select subagent' })}
            </label>
            <select
              id={`${panelTitleId}-agent-select`}
              value={selectedTrace?.id ?? ''}
              disabled={traces.length === 0}
              onChange={(event) => {
                if (event.target.value) onSelectTrace(event.target.value);
              }}
              className="h-9 w-full appearance-none truncate rounded-md border border-border bg-background py-1 pl-3 pr-9 text-xs font-medium shadow-sm outline-none transition-colors hover:bg-muted/40 focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {traces.length === 0 && (
                <option value="">
                  {t('subagentPanel.noAgents', { defaultValue: 'No subagents' })}
                </option>
              )}
              {traces.map((trace) => (
                <option key={trace.id} value={trace.id}>
                  {trace.agentType}: {trace.description || trace.title}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
          </div>

          {selectedTrace && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span
                aria-live="polite"
                aria-atomic="true"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                  statusStyle.className,
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    statusStyle.dotClassName,
                    status === 'running' && 'animate-pulse',
                  )}
                />
                {statusLabel}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                <Clock3 aria-hidden="true" className="h-3 w-3" />
                {durationLabel}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Wrench aria-hidden="true" className="h-3 w-3" />
                {t('subagentPanel.toolCount', {
                  count: selectedTrace.activities.length,
                  defaultValue: selectedTrace.activities.length === 1
                    ? '{{count}} tool'
                    : '{{count}} tools',
                })}
              </span>
            </div>
          )}
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollContainerRef}
            onScroll={handleTimelineScroll}
            className="h-full overflow-y-auto overscroll-contain px-4 py-4"
            aria-label={t('subagentPanel.timeline.ariaLabel', {
              defaultValue: 'Subagent execution timeline',
            })}
          >
            {!selectedTrace ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center text-muted-foreground">
                <Bot aria-hidden="true" className="mb-3 h-8 w-8 opacity-40" />
                <p className="text-sm font-medium text-foreground">
                  {t('subagentPanel.empty.title', { defaultValue: 'No subagent activity' })}
                </p>
                <p className="mt-1 text-xs">
                  {t('subagentPanel.empty.description', {
                    defaultValue: 'Subagent calls will appear here as they run.',
                  })}
                </p>
              </div>
            ) : (
              <>
                {selectedTrace.prompt && (
                  <section className="mb-5 rounded-lg border border-border/70 bg-muted/25">
                    <button
                      type="button"
                      aria-controls={promptContentId}
                      aria-expanded={isPromptOpen}
                      onClick={() => setIsPromptOpen((isOpen) => !isOpen)}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <Sparkles aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-purple-500" />
                      <span className="min-w-0 flex-1 text-xs font-semibold">
                        {t('subagentPanel.prompt.title', { defaultValue: 'Task prompt' })}
                      </span>
                      <ChevronDown
                        aria-hidden="true"
                        className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isPromptOpen && 'rotate-180')}
                      />
                    </button>
                    {isPromptOpen && (
                      <div
                        id={promptContentId}
                        className="border-t border-border/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground"
                      >
                        <p className="whitespace-pre-wrap break-words">{selectedTrace.prompt}</p>
                      </div>
                    )}
                  </section>
                )}

                <section aria-labelledby={`${panelTitleId}-timeline-heading`}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3
                      id={`${panelTitleId}-timeline-heading`}
                      className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {t('subagentPanel.timeline.title', { defaultValue: 'Activity' })}
                    </h3>
                    <span className="text-[10px] tabular-nums text-muted-foreground/70">
                      {selectedTrace.activities.length}
                    </span>
                  </div>

                  {selectedTrace.activities.length > 0 ? (
                    <ol className="space-y-5">
                      {selectedTrace.activities.map((activity, index) => (
                        <SubagentActivityItem
                          key={activity.id}
                          activity={activity}
                          isLast={index === selectedTrace.activities.length - 1}
                        />
                      ))}
                    </ol>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
                      {['running', 'waiting'].includes(selectedTrace.status) && (
                        <StatusIcon
                          aria-hidden="true"
                          className={cn(
                            'mx-auto mb-2 h-5 w-5',
                            status === 'running' && 'animate-spin',
                            statusStyle.iconClassName,
                          )}
                        />
                      )}
                      <p className="text-xs text-muted-foreground">
                        {['running', 'waiting'].includes(selectedTrace.status)
                          ? t('subagentPanel.timeline.waiting', {
                              defaultValue: 'Waiting for the first tool call…',
                            })
                          : t('subagentPanel.timeline.noActivity', {
                              defaultValue: 'No tool activity was recorded.',
                            })}
                      </p>
                    </div>
                  )}
                </section>

                {(hasFinalResult || usageEntries.length > 0) && (
                  <section className="mt-6 border-t border-border pt-5">
                    {hasFinalResult && (
                      <div>
                        <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <StatusIcon
                            aria-hidden="true"
                            className={cn('h-3.5 w-3.5', statusStyle.iconClassName)}
                          />
                          {t('subagentPanel.finalResult', { defaultValue: 'Final result' })}
                        </h3>
                        <pre
                          tabIndex={0}
                          className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-xs leading-5 text-foreground/85"
                        >
                          {finalResultText}
                        </pre>
                      </div>
                    )}

                    {usageEntries.length > 0 && (
                      <div className={cn(hasFinalResult && 'mt-5')}>
                        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {t('subagentPanel.usage', { defaultValue: 'Usage' })}
                        </h3>
                        <dl className="grid grid-cols-2 gap-2">
                          {usageEntries.map(([name, value]) => (
                            <div key={name} className="min-w-0 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
                              <dt className="truncate text-[10px] text-muted-foreground" title={formatUsageName(name)}>
                                {formatUsageName(name)}
                              </dt>
                              <dd className="mt-0.5 truncate text-xs font-semibold tabular-nums text-foreground" title={String(value)}>
                                {String(value)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </div>

          {newUpdateCount > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4" aria-live="polite">
              <button
                type="button"
                onClick={() => scrollToBottom('smooth')}
                className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-lg transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                {t('subagentPanel.newUpdates', {
                  count: newUpdateCount,
                  defaultValue: newUpdateCount === 1
                    ? '{{count}} new update · Back to latest'
                    : '{{count}} new updates · Back to latest',
                })}
              </button>
            </div>
          )}
        </div>

        {permissionRequests.length > 0 && onPermissionDecision && (
          <section
            data-subagent-question-panel
            aria-label={t('subagentPanel.pendingQuestion', {
              defaultValue: 'Subagent question awaiting your answer',
            })}
            className="max-h-[60%] shrink-0 space-y-3 overflow-y-auto border-t border-border bg-background px-3 py-3 shadow-[0_-8px_24px_-20px_rgba(0,0,0,0.45)]"
          >
            {permissionRequests.map((request) => (
              <AskUserQuestionPanel
                key={request.requestId}
                request={request}
                onDecision={onPermissionDecision}
              />
            ))}
          </section>
        )}
      </aside>
    </>
  );
}
