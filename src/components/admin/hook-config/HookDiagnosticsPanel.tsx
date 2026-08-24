import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  RefreshCw,
  Search,
  ShieldAlert,
  Timer,
  X,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { Badge, Button, Card, Dialog, DialogContent, DialogTitle, Input } from '../../../shared/view/ui';
import { api } from '../../../utils/api';

import { groupHookExecutions, likelyWinningUpdatedInput, paginationWindow } from './diagnostics';
import type { HookConfig, HookExecution, HookExecutionOutcome, HookExecutionPage } from './types';

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

function formatTimestamp(value: number | null, language: string) {
  if (!value) return '—';
  const date = new Date(value);
  const formatted = new Intl.DateTimeFormat(language, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
  return `${formatted}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

function outcomeVariant(outcome: HookExecutionOutcome) {
  if (outcome === 'failed' || outcome === 'denied' || outcome === 'stopped') return 'destructive' as const;
  if (outcome === 'succeeded') return 'outline' as const;
  return 'secondary' as const;
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  const { t } = useTranslation('admin');
  const text = formatJson(value);
  return (
    <section className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-2">
        <h4 className="min-w-0 flex-1 text-xs font-semibold text-foreground">{title}</h4>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => void navigator.clipboard?.writeText(text)}
        >
          <Copy className="h-3.5 w-3.5" />
          {t('hooks.diagnostics.copy')}
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-muted/10 p-3 text-[11px] leading-5 text-foreground">
        {text}
      </pre>
    </section>
  );
}

function HookExecutionDetail({
  execution,
  loading,
  onClose,
}: {
  execution: HookExecution | null;
  loading: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('admin');
  return (
    <Dialog open={Boolean(execution)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden p-0">
        <DialogTitle className="sr-only">{t('hooks.diagnostics.detailTitle')}</DialogTitle>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-3 top-3 z-20 h-8 w-8 rounded-full bg-background/90 shadow-sm"
          onClick={onClose}
          aria-label={t('hooks.close')}
        >
          <X className="h-4 w-4" />
        </Button>
        {execution ? (
          <>
            <div className="border-b border-border bg-gradient-to-br from-primary/10 via-background to-background px-5 py-4 pr-14">
              <div className="flex flex-wrap items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <Activity className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{execution.hookName || execution.hookId}</h3>
                    {execution.bindingController === 'sql_check' ? (
                      <Badge variant="outline">{t('hooks.builtin')}</Badge>
                    ) : null}
                    <Badge variant={outcomeVariant(execution.diagnostics.outcome)}>
                      {t(`hooks.diagnostics.outcomes.${execution.diagnostics.outcome}`)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {execution.eventName}{execution.toolName ? ` · ${execution.toolName}` : ''} · v{execution.hookVersion}
                  </p>
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                <span>{t('hooks.diagnostics.startedAt')}: {formatTimestamp(execution.startedAtMs, i18n.language)}</span>
                <span>{t('hooks.diagnostics.duration')}: {execution.durationMs == null ? '—' : `${execution.durationMs}ms`}</span>
                <span>{t('hooks.diagnostics.user')}: {execution.username || execution.userId || '—'}</span>
                <span className="truncate" title={execution.sessionId || ''}>{t('hooks.diagnostics.session')}: {execution.sessionId || '—'}</span>
              </div>
            </div>

            {loading ? (
              <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                {t('hooks.diagnostics.loadingDetail')}
              </div>
            ) : (
            <div className="max-h-[calc(90vh-150px)] space-y-3 overflow-y-auto p-4 sm:p-5">
              {execution.diagnostics.failOpen ? (
                <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t('hooks.diagnostics.failOpenWarning')}</span>
                </div>
              ) : null}
              {execution.errorMessage ? (
                <section className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                  <h4 className="text-xs font-semibold text-destructive">{t('hooks.diagnostics.error')}</h4>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-destructive">
                    {execution.errorMessage}
                  </pre>
                </section>
              ) : null}
              <JsonSection title={t('hooks.diagnostics.input')} value={execution.input} />
              <JsonSection title={t('hooks.diagnostics.scriptOutput')} value={execution.scriptOutput} />
              <JsonSection title={t('hooks.diagnostics.actions')} value={execution.actions} />
              <JsonSection title={t('hooks.diagnostics.response')} value={execution.response} />
              <JsonSection title={t('hooks.diagnostics.logs')} value={execution.logs} />
            </div>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default function HookDiagnosticsPanel({
  hook,
  hooks = [],
}: {
  hook?: HookConfig | null;
  hooks?: HookConfig[];
}) {
  const { t, i18n } = useTranslation('admin');
  const requestSequence = useRef(0);
  const [executions, setExecutions] = useState<HookExecution[]>([]);
  const [totalGroups, setTotalGroups] = useState(0);
  const [executionTotal, setExecutionTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<HookExecution | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [hookId, setHookId] = useState('');
  const [hookKind, setHookKind] = useState('');
  const [outcome, setOutcome] = useState('');
  const [eventName, setEventName] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const filters = {
        hookId: hook ? undefined : hookId || undefined,
        eventName: eventName || undefined,
        status: status || undefined,
        q: searchQuery || undefined,
        bindingController: hook ? undefined : hookKind || undefined,
        outcome: outcome || undefined,
        limit: pageSize,
        offset: page * pageSize,
      };
      const response = hook
        ? await api.admin.hookExecutions(hook.id, filters)
        : await api.admin.allHookExecutions(filters);
      if (!response.ok) throw new Error(t('hooks.diagnostics.loadError'));
      const payload = await response.json() as Partial<HookExecutionPage>;
      if (requestId !== requestSequence.current) return;
      setExecutions(payload.executions || []);
      setTotalGroups(Number(payload.total || 0));
      setExecutionTotal(Number(payload.executionTotal || 0));
    } catch (caughtError) {
      if (requestId !== requestSequence.current) return;
      setError(caughtError instanceof Error ? caughtError.message : t('hooks.diagnostics.loadError'));
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [eventName, hook, hookId, hookKind, outcome, page, pageSize, searchQuery, status, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(query.trim());
      setPage(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const groups = useMemo(() => groupHookExecutions(executions), [executions]);
  const eventNames = useMemo(() => [...new Set([
    ...(hook ? [hook.eventName] : []),
    ...hooks.map((item) => item.eventName),
    ...executions.map((item) => item.eventName),
  ])].sort(), [executions, hook, hooks]);
  const totalPages = Math.max(1, Math.ceil(totalGroups / pageSize));
  const pageNumbers = useMemo(() => paginationWindow(page + 1, totalPages), [page, totalPages]);

  useEffect(() => {
    if (page >= totalPages) setPage(totalPages - 1);
  }, [page, totalPages]);
  const openExecution = async (execution: HookExecution) => {
    setSelected(execution);
    setDetailLoading(true);
    try {
      const response = await api.admin.hookExecution(execution.id);
      if (!response.ok) throw new Error(t('hooks.diagnostics.loadDetailError'));
      const payload = await response.json() as { execution?: HookExecution };
      if (payload.execution) setSelected(payload.execution);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('hooks.diagnostics.loadDetailError'));
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Activity className="h-4 w-4 text-primary" />
            {hook ? t('hooks.diagnostics.hookTitle', { name: hook.name }) : t('hooks.diagnostics.title')}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('hooks.diagnostics.description')}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          {t('common.refresh')}
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('hooks.diagnostics.search')}
            className="h-10 pl-9"
          />
        </div>
        {!hook ? (
          <select
            value={hookId}
            onChange={(event) => {
              setHookId(event.target.value);
              setPage(0);
            }}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="">{t('hooks.diagnostics.allHooks')}</option>
            {hooks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        ) : null}
        <select
          value={eventName}
          onChange={(event) => {
            setEventName(event.target.value);
            setPage(0);
          }}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
        >
          <option value="">{t('hooks.diagnostics.allEvents')}</option>
          {eventNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(0);
          }}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
        >
          <option value="">{t('hooks.diagnostics.allStatuses')}</option>
          <option value="succeeded">{t('hooks.diagnostics.statuses.succeeded')}</option>
          <option value="failed">{t('hooks.diagnostics.statuses.failed')}</option>
          <option value="running">{t('hooks.diagnostics.statuses.running')}</option>
        </select>
        <select
          value={outcome}
          onChange={(event) => {
            setOutcome(event.target.value);
            setPage(0);
          }}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
        >
          <option value="">{t('hooks.diagnostics.allOutcomes')}</option>
          {([
            'failed',
            'denied',
            'stopped',
            'ask',
            'defer',
            'modified_input',
            'modified_output',
            'post_action',
            'additional_context',
            'succeeded',
          ] as HookExecutionOutcome[]).map((value) => (
            <option key={value} value={value}>{t(`hooks.diagnostics.outcomes.${value}`)}</option>
          ))}
        </select>
        {!hook ? (
          <select
            value={hookKind}
            onChange={(event) => {
              setHookKind(event.target.value);
              setPage(0);
            }}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="">{t('hooks.diagnostics.allKinds')}</option>
            <option value="sql_check">{t('hooks.builtin')}</option>
            <option value="admin">{t('hooks.diagnostics.customHook')}</option>
          </select>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>
      ) : loading && executions.length === 0 ? (
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" />
          {t('hooks.diagnostics.loading')}
        </div>
      ) : groups.length === 0 ? (
        <Card className="flex min-h-48 items-center justify-center border-dashed text-sm text-muted-foreground shadow-none">
          {t('hooks.diagnostics.empty')}
        </Card>
      ) : (
        <div className={cn('space-y-3 transition-opacity', loading && 'opacity-60')}>
          {groups.map((group) => {
            const updatedInputWinner = likelyWinningUpdatedInput(group);
            const latestTime = Math.max(...group.executions.map((item) => item.startedAtMs || 0));
            return (
              <Card key={group.key} className="overflow-hidden shadow-none">
                <div className="flex flex-wrap items-start gap-3 border-b border-border bg-muted/10 px-4 py-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Activity className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-xs font-semibold text-foreground">{group.eventName}</h4>
                      {group.toolName ? <Badge variant="outline">{group.toolName}</Badge> : null}
                      {group.exact && group.executions.length > 1 ? (
                        <Badge variant="secondary">{t('hooks.diagnostics.parallelCount', { count: group.executions.length })}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      {formatTimestamp(latestTime, i18n.language)} · {group.sessionId || t('hooks.diagnostics.noSession')}
                      {group.toolUseId ? ` · ${group.toolUseId}` : ''}
                    </p>
                  </div>
                </div>

                {group.conflicts.length > 0 ? (
                  <div className="space-y-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-800 dark:text-amber-300">
                    {group.conflicts.includes('updated_input') ? (
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          {t('hooks.diagnostics.updatedInputConflict', {
                            name: updatedInputWinner?.hookName || updatedInputWinner?.hookId || '—',
                          })}
                        </span>
                      </div>
                    ) : null}
                    {group.conflicts.includes('permission_decision') ? (
                      <div className="flex items-start gap-2">
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{t('hooks.diagnostics.permissionConflict')}</span>
                      </div>
                    ) : null}
                    {group.conflicts.includes('fail_open_side_effect') ? (
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{t('hooks.diagnostics.failOpenSideEffect')}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="divide-y divide-border">
                  {group.executions.map((execution) => (
                    <button
                      key={execution.id}
                      type="button"
                      onClick={() => void openExecution(execution)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/20"
                    >
                      {execution.status === 'failed' ? (
                        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                      ) : execution.diagnostics.outcome === 'denied' || execution.diagnostics.outcome === 'stopped' ? (
                        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-xs font-medium text-foreground">{execution.hookName || execution.hookId}</span>
                          {execution.bindingController === 'sql_check' ? <Badge variant="outline">{t('hooks.builtin')}</Badge> : null}
                          <Badge variant={outcomeVariant(execution.diagnostics.outcome)}>
                            {t(`hooks.diagnostics.outcomes.${execution.diagnostics.outcome}`)}
                          </Badge>
                        </div>
                        <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                          {execution.username || execution.userId || '—'} · v{execution.hookVersion}
                        </span>
                      </div>
                      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                        <Timer className="h-3.5 w-3.5" />
                        {execution.durationMs == null ? '—' : `${execution.durationMs}ms`}
                      </span>
                      <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground md:flex">
                        <Clock3 className="h-3.5 w-3.5" />
                        {formatTimestamp(execution.completedAtMs, i18n.language)}
                      </span>
                    </button>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {!error && totalGroups > 0 ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {t('hooks.diagnostics.pagination.summary', {
              groups: totalGroups,
              executions: executionTotal,
            })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('hooks.diagnostics.pagination.pageSize')}</span>
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value) as (typeof PAGE_SIZE_OPTIONS)[number]);
                  setPage(0);
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                aria-label={t('hooks.diagnostics.pagination.pageSize')}
              >
                {PAGE_SIZE_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <span className="min-w-20 text-center text-xs text-muted-foreground">
              {t('hooks.diagnostics.pagination.pageOf', { page: page + 1, total: totalPages })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              aria-label={t('hooks.diagnostics.pagination.previous')}
              disabled={loading || page === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="hidden items-center gap-1 md:flex">
              {pageNumbers.map((pageNumber) => (
                <Button
                  key={pageNumber}
                  type="button"
                  variant={pageNumber === page + 1 ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 min-w-8 px-2"
                  aria-label={t('hooks.diagnostics.pagination.goToPage', { page: pageNumber })}
                  disabled={loading}
                  onClick={() => setPage(pageNumber - 1)}
                >
                  {pageNumber}
                </Button>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              aria-label={t('hooks.diagnostics.pagination.next')}
              disabled={loading || page + 1 >= totalPages}
              onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}

      <HookExecutionDetail
        execution={selected}
        loading={detailLoading}
        onClose={() => {
          setSelected(null);
          setDetailLoading(false);
        }}
      />
    </div>
  );
}
