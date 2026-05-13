import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';

import {
  buildRuntimeQueryString,
  formatBytes,
  formatRuntimeAge,
  type RuntimeMonitorFilters,
} from './runtimeMonitorUtils';

type RuntimeRow = {
  runtimeId: string;
  tenant: { id: number; code: string; name: string };
  user: { id: number; username: string };
  workspace: { id: number; displayName: string; slug?: string };
  provider: string;
  providerSessionId: string | null;
  businessStatus: string;
  dockerState: string;
  staleActive?: boolean;
  containerName: string;
  image: string;
  lastUsedAt: string | null;
  updatedAt: string | null;
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  idleAgeSeconds: number | null;
  canStop: boolean;
};

type RuntimeSummary = {
  total: number;
  active: number;
  idleRunning: number;
  failedOrUnknown: number;
  missing: number;
  staleActive: number;
  totalLiveMemoryBytes: number;
};

type RuntimePayload = {
  rows?: RuntimeRow[];
  total?: number;
  summary?: RuntimeSummary;
  error?: string;
  message?: string;
};

type RuntimeErrorPayload = {
  error?: string;
  message?: string;
};

const SELECT_CLASS_NAME =
  'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function statusClassName(status: string): string {
  if (status === 'active' || status === 'running') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  }
  if (status === 'idle' || status === 'exited') {
    return 'border-slate-200 bg-slate-50 text-slate-700';
  }
  if (status === 'failed' || status === 'unknown' || status === 'missing') {
    return 'border-rose-200 bg-rose-50 text-rose-700';
  }
  return 'border-amber-200 bg-amber-50 text-amber-700';
}

function StatusChip({ value }: { value: string }) {
  const { t } = useTranslation('admin');
  const statusKey = value === 'active stale' ? 'activeStale' : value;

  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${statusClassName(value)}`}>
      {t(`statuses.${statusKey}`, { defaultValue: value })}
    </span>
  );
}

function SummaryTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold text-foreground">{value}</div>
    </div>
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as RuntimeErrorPayload));
  return payload.error || payload.message || fallback;
}

function formatCpu(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(1)}%`;
}

export default function RuntimeMonitorTab() {
  const { t } = useTranslation('admin');
  const [filters, setFilters] = useState<RuntimeMonitorFilters>({ status: '', dockerState: '', q: '', limit: 100 });
  const [rows, setRows] = useState<RuntimeRow[]>([]);
  const [summary, setSummary] = useState<RuntimeSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [stoppingRuntimeIds, setStoppingRuntimeIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const filtersRef = useRef(filters);
  const currentQueryKeyRef = useRef(buildRuntimeQueryString(filters));
  const isMountedRef = useRef(true);
  const latestLoadRequestIdRef = useRef(0);
  const stoppingRuntimeIdsRef = useRef<Set<string>>(new Set());

  const queryKey = useMemo(() => buildRuntimeQueryString(filters), [filters]);
  filtersRef.current = filters;
  currentQueryKeyRef.current = queryKey;

  const isLatestLoad = useCallback((requestId: number, requestQueryKey: string) => (
    isMountedRef.current &&
    latestLoadRequestIdRef.current === requestId &&
    currentQueryKeyRef.current === requestQueryKey
  ), []);

  const updateFilters = useCallback((getNextFilters: (currentFilters: RuntimeMonitorFilters) => RuntimeMonitorFilters) => {
    const nextFilters = getNextFilters(filtersRef.current);
    const nextQueryKey = buildRuntimeQueryString(nextFilters);

    if (nextQueryKey !== currentQueryKeyRef.current) {
      latestLoadRequestIdRef.current += 1;
    }

    filtersRef.current = nextFilters;
    currentQueryKeyRef.current = nextQueryKey;
    setFilters(nextFilters);
  }, []);

  const setRuntimeStopping = useCallback((runtimeId: string, isStopping: boolean) => {
    const nextStoppingRuntimeIds = new Set(stoppingRuntimeIdsRef.current);

    if (isStopping) {
      nextStoppingRuntimeIds.add(runtimeId);
    } else {
      nextStoppingRuntimeIds.delete(runtimeId);
    }

    stoppingRuntimeIdsRef.current = nextStoppingRuntimeIds;

    if (isMountedRef.current) {
      setStoppingRuntimeIds(nextStoppingRuntimeIds);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      latestLoadRequestIdRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = latestLoadRequestIdRef.current + 1;
    latestLoadRequestIdRef.current = requestId;

    if (!isMountedRef.current) return;

    const requestFilters = filtersRef.current;
    const requestQueryKey = buildRuntimeQueryString(requestFilters);

    setIsLoading(true);
    setError(null);

    try {
      const response = await api.admin.runtimes(requestFilters);
      if (!isLatestLoad(requestId, requestQueryKey)) return;

      if (!response.ok) {
        const errorMessage = await readError(response, t('runtimes.errors.load'));
        if (isLatestLoad(requestId, requestQueryKey)) {
          setError(errorMessage);
        }
        return;
      }

      const payload = await response.json() as RuntimePayload;
      if (!isLatestLoad(requestId, requestQueryKey)) return;

      setRows(payload.rows || []);
      setSummary(payload.summary || null);
      setTotal(payload.total || 0);
    } catch (caughtError) {
      if (!isLatestLoad(requestId, requestQueryKey)) return;

      console.error('[RuntimeMonitorTab] Failed to load runtimes:', { queryKey: requestQueryKey, error: caughtError });
      setError(t('runtimes.errors.load'));
    } finally {
      if (isLatestLoad(requestId, requestQueryKey)) {
        setIsLoading(false);
      }
    }
  }, [isLatestLoad, t]);

  useEffect(() => {
    void load();
  }, [load, queryKey]);

  const stopRuntime = async (runtimeId: string) => {
    if (stoppingRuntimeIdsRef.current.has(runtimeId)) return;

    setRuntimeStopping(runtimeId, true);
    setError(null);

    try {
      const response = await api.admin.stopRuntime(runtimeId);
      if (!response.ok) {
        const errorMessage = await readError(response, t('runtimes.errors.stop'));
        if (isMountedRef.current) {
          setError(errorMessage);
        }
        return;
      }
      await load();
    } catch (caughtError) {
      console.error('[RuntimeMonitorTab] Failed to stop runtime:', caughtError);
      if (isMountedRef.current) {
        setError(t('runtimes.errors.stop'));
      }
    } finally {
      setRuntimeStopping(runtimeId, false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-5">
        <SummaryTile label={t('runtimes.summary.total')} value={summary?.total ?? total} />
        <SummaryTile label={t('runtimes.summary.active')} value={summary?.active ?? 0} />
        <SummaryTile label={t('runtimes.summary.idleRunning')} value={summary?.idleRunning ?? 0} />
        <SummaryTile label={t('runtimes.summary.failedUnknown')} value={summary?.failedOrUnknown ?? 0} />
        <SummaryTile label={t('runtimes.summary.liveMemory')} value={formatBytes(summary?.totalLiveMemoryBytes)} />
      </div>

      <div className="grid gap-2 lg:grid-cols-[150px_150px_minmax(280px,1fr)_auto]">
        <select
          className={SELECT_CLASS_NAME}
          value={filters.status || ''}
          onChange={(event) => updateFilters((current) => ({ ...current, status: event.target.value }))}
        >
          <option value="">{t('runtimes.filters.allStatuses')}</option>
          <option value="active">{t('statuses.active')}</option>
          <option value="idle">{t('statuses.idle')}</option>
          <option value="failed">{t('statuses.failed')}</option>
          <option value="pending">{t('statuses.pending')}</option>
        </select>
        <select
          className={SELECT_CLASS_NAME}
          value={filters.dockerState || ''}
          onChange={(event) => updateFilters((current) => ({ ...current, dockerState: event.target.value }))}
        >
          <option value="">{t('runtimes.filters.allDocker')}</option>
          <option value="running">{t('statuses.running')}</option>
          <option value="exited">{t('statuses.exited')}</option>
          <option value="missing">{t('statuses.missing')}</option>
          <option value="unknown">{t('statuses.unknown')}</option>
        </select>
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="h-9 pl-9"
            value={filters.q || ''}
            onChange={(event) => updateFilters((current) => ({ ...current, q: event.target.value }))}
            placeholder={t('runtimes.filters.searchPlaceholder')}
          />
        </label>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load()}
          disabled={isLoading}
          aria-label={t('runtimes.refresh')}
          title={t('runtimes.refresh')}
        >
          <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[1080px] text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.runtime')}</th>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.tenant')}</th>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.user')}</th>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.workspace')}</th>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.business')}</th>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.docker')}</th>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.cpu')}</th>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.memory')}</th>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.idleAge')}</th>
              <th className="px-3 py-2 font-medium">{t('runtimes.table.action')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-muted-foreground" colSpan={10}>
                  {isLoading ? t('runtimes.loading') : t('runtimes.empty')}
                </td>
              </tr>
            ) : rows.map((row) => {
              const isStoppingRuntime = stoppingRuntimeIds.has(row.runtimeId);

              return (
                <tr key={row.runtimeId} className="border-b border-border last:border-b-0">
                  <td className="max-w-60 px-3 py-2">
                    <div className="truncate font-medium text-foreground">{row.providerSessionId || row.runtimeId}</div>
                    <div className="truncate text-xs text-muted-foreground">{row.provider} - {row.containerName}</div>
                  </td>
                  <td className="max-w-44 px-3 py-2">
                    <div className="truncate font-medium text-foreground">{row.tenant.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{row.tenant.code}</div>
                  </td>
                  <td className="max-w-32 truncate px-3 py-2">{row.user.username}</td>
                  <td className="max-w-44 truncate px-3 py-2">{row.workspace.displayName}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <StatusChip value={row.businessStatus} />
                      {row.staleActive ? <StatusChip value="active stale" /> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2"><StatusChip value={row.dockerState} /></td>
                  <td className="whitespace-nowrap px-3 py-2">{formatCpu(row.cpuPercent)}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {formatBytes(row.memoryUsageBytes)}
                    {row.memoryLimitBytes ? (
                      <span className="text-muted-foreground"> / {formatBytes(row.memoryLimitBytes)}</span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{formatRuntimeAge(row.idleAgeSeconds)}</td>
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!row.canStop || isStoppingRuntime}
                      onClick={() => void stopRuntime(row.runtimeId)}
                    >
                      <Square className="h-3.5 w-3.5" />
                      {isStoppingRuntime ? t('runtimes.stopping') : t('runtimes.stop')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
