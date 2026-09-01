import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';

type ScheduledTaskLogRow = {
  id: number;
  timestamp: string;
  processId?: number | null;
  taskId?: number | null;
  taskName?: string | null;
  tenantId?: number | null;
  tenantCode?: string | null;
  tenantName?: string | null;
  workspaceId?: number | null;
  workspaceName?: string | null;
  workspaceSlug?: string | null;
  userId?: number | null;
  username?: string | null;
  tickId?: string | null;
  runId?: string | null;
  details: Record<string, unknown>;
};

type LogPayload = {
  rows?: ScheduledTaskLogRow[];
  total?: number;
  limit?: number;
  offset?: number;
  retention?: { days: number; maxRows: number };
  error?: string;
  message?: string;
};

type LogFilters = {
  q: string;
  limit: number;
  offset: number;
};

const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const AUTO_REFRESH_MS = 10_000;
const SELECT_CLASS_NAME =
  'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function formatShanghaiTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function getErrorMessage(details: Record<string, unknown>): string | null {
  const error = details.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return null;
}

function formatDetailSummary(row: ScheduledTaskLogRow): string {
  const error = getErrorMessage(row.details);
  if (error) return error;
  const duration = Number(row.details.durationMs);
  if (Number.isFinite(duration)) return `${duration} ms`;
  const claimed = Number(row.details.claimedCount);
  if (Number.isFinite(claimed)) return `${claimed} task(s)`;
  const sessionId = row.details.sessionId;
  if (typeof sessionId === 'string' && sessionId) return sessionId;
  return '-';
}

function contextLabel(row: ScheduledTaskLogRow): string {
  const task = row.taskName || (row.taskId ? `#${row.taskId}` : '-');
  const workspace = row.workspaceName || row.workspaceSlug;
  return workspace ? `${task} · ${workspace}` : task;
}

function getVisibleDetails(details: Record<string, unknown>): Record<string, unknown> {
  const visibleDetails = { ...details };
  delete visibleDetails.event;
  delete visibleDetails.sourceEvent;
  delete visibleDetails.level;
  delete visibleDetails.provider;
  return visibleDetails;
}

export default function ScheduledTaskLogsTab() {
  const { t } = useTranslation('admin');
  const [filters, setFilters] = useState<LogFilters>({
    q: '',
    limit: DEFAULT_PAGE_SIZE,
    offset: 0,
  });
  const [rows, setRows] = useState<ScheduledTaskLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [retention, setRetention] = useState<{ days: number; maxRows: number } | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const queryKey = useMemo(() => JSON.stringify(filters), [filters]);
  const currentPage = Math.floor(filters.offset / filters.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / filters.limit));

  const updateFilters = useCallback((patch: Partial<LogFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const load = useCallback(async ({ background = false } = {}) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!background) setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.scheduledTaskLogs(filters);
      const payload = await response.json().catch(() => ({} as LogPayload)) as LogPayload;
      if (requestId !== requestIdRef.current) return;
      if (!response.ok) {
        setError(payload.error || payload.message || t('scheduledTaskLogs.errors.load'));
        return;
      }
      const nextTotal = payload.total || 0;
      if (nextTotal === 0 && filters.offset > 0) {
        updateFilters({ offset: 0 });
        return;
      }
      if (nextTotal > 0 && filters.offset >= nextTotal) {
        updateFilters({ offset: Math.floor((nextTotal - 1) / filters.limit) * filters.limit });
        return;
      }
      setRows(payload.rows || []);
      setTotal(nextTotal);
      setRetention(payload.retention || null);
    } catch (caughtError) {
      if (requestId !== requestIdRef.current) return;
      console.error('[ScheduledTaskLogsTab] Failed to load logs:', caughtError);
      setError(t('scheduledTaskLogs.errors.load'));
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [filters, t, updateFilters]);

  useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load, queryKey]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => void load({ background: true }), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const toggleExpanded = (id: number) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t('scheduledTaskLogs.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {retention
              ? t('scheduledTaskLogs.retention', { days: retention.days, maxRows: retention.maxRows.toLocaleString() })
              : t('scheduledTaskLogs.description')}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          {t('scheduledTaskLogs.autoRefresh')}
        </label>
      </div>

      <div className="grid gap-2 xl:grid-cols-[minmax(240px,1fr)_110px_auto]">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="h-9 pl-9"
            value={filters.q}
            onChange={(event) => updateFilters({ q: event.target.value, offset: 0 })}
            placeholder={t('scheduledTaskLogs.filters.searchPlaceholder')}
          />
        </label>
        <select
          className={SELECT_CLASS_NAME}
          value={filters.limit}
          onChange={(event) => updateFilters({ limit: Number(event.target.value), offset: 0 })}
          aria-label={t('scheduledTaskLogs.pagination.pageSize')}
        >
          {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load()}
          disabled={isLoading}
          aria-label={t('scheduledTaskLogs.refresh')}
          title={t('scheduledTaskLogs.refresh')}
        >
          <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border bg-background">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="w-9 px-3 py-2" />
                <th className="px-3 py-2 font-medium">{t('scheduledTaskLogs.table.time')}</th>
                <th className="px-3 py-2 font-medium">{t('scheduledTaskLogs.table.task')}</th>
                <th className="px-3 py-2 font-medium">{t('scheduledTaskLogs.table.scope')}</th>
                <th className="px-3 py-2 font-medium">{t('scheduledTaskLogs.table.result')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => {
                const expanded = expandedIds.has(row.id);
                return (
                  <tr key={row.id} className="align-top hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => toggleExpanded(row.id)}
                        aria-label={expanded ? t('scheduledTaskLogs.collapse') : t('scheduledTaskLogs.expand')}
                      >
                        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatShanghaiTime(row.timestamp)}</td>
                    <td className="max-w-[240px] px-3 py-2">
                      <div className="truncate text-foreground" title={contextLabel(row)}>{contextLabel(row)}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{row.runId || row.tickId || '-'}</div>
                    </td>
                    <td className="max-w-[200px] px-3 py-2 text-muted-foreground">
                      <div className="truncate">{row.tenantName || row.tenantCode || '-'}</div>
                      <div className="truncate">{row.username || (row.userId ? `#${row.userId}` : '-')}</div>
                    </td>
                    <td className="max-w-[280px] px-3 py-2">
                      <div className={getErrorMessage(row.details) ? 'truncate text-destructive' : 'truncate text-muted-foreground'} title={formatDetailSummary(row)}>
                        {formatDetailSummary(row)}
                      </div>
                      {expanded ? (
                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 text-[11px] leading-5 text-foreground">
                          {JSON.stringify(getVisibleDetails(row.details), null, 2)}
                        </pre>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!isLoading && rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t('scheduledTaskLogs.empty')}</div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{t('scheduledTaskLogs.pagination.total', { count: total })}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={filters.offset <= 0 || isLoading}
            onClick={() => updateFilters({ offset: Math.max(0, filters.offset - filters.limit) })}
          >
            <ChevronLeft className="h-4 w-4" />
            {t('scheduledTaskLogs.pagination.previous')}
          </Button>
          <span>{t('scheduledTaskLogs.pagination.page', { page: currentPage, totalPages })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={filters.offset + filters.limit >= total || isLoading}
            onClick={() => updateFilters({ offset: filters.offset + filters.limit })}
          >
            {t('scheduledTaskLogs.pagination.next')}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
