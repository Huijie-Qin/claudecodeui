import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clipboard,
  Clock3,
  Database,
  Loader2,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';

export type UserHookDataRecord = {
  id: string;
  type: string;
  data: unknown;
  createdAt: string;
};

export type UserHookStandaloneRecord = UserHookDataRecord & {
  sessionId: string | null;
};

export type UserHookExecution = {
  id: string;
  eventName: string;
  sessionId: string | null;
  status: 'running' | 'succeeded' | 'failed';
  durationMs: number | null;
  startedAtMs: number | null;
  startedAt: string | null;
  records: UserHookDataRecord[];
};

type RecordsHook = {
  id: string;
  name: string;
};

type HookExecutionRecordsDrawerProps = {
  hook: RecordsHook;
  executions: UserHookExecution[];
  standaloneRecords: UserHookStandaloneRecord[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
};

function formatExecutionTime(execution: UserHookExecution) {
  const timestamp = execution.startedAtMs || Date.parse(execution.startedAt || '');
  if (!Number.isFinite(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatRecordTime(createdAt: string) {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatDuration(durationMs: number | null) {
  if (durationMs == null || !Number.isFinite(Number(durationMs))) return null;
  const normalized = Math.max(0, Number(durationMs));
  if (normalized < 1000) return `${Math.round(normalized)} ms`;
  return `${(normalized / 1000).toFixed(normalized < 10000 ? 1 : 0)} s`;
}

function shortSessionId(sessionId: string) {
  if (sessionId.length <= 18) return sessionId;
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}`;
}

function formatRecordValue(value: unknown) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function recordEntries(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.entries(data as Record<string, unknown>).slice(0, 6);
}

export default function HookExecutionRecordsDrawer({
  hook,
  executions,
  standaloneRecords,
  total,
  loading,
  loadingMore,
  error,
  hasMore,
  onClose,
  onRefresh,
  onLoadMore,
}: HookExecutionRecordsDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [copiedRecordId, setCopiedRecordId] = useState<string | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [onClose]);

  const copyRecord = async (record: UserHookDataRecord) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(record.data, null, 2));
      setCopiedRecordId(record.id);
      window.setTimeout(() => setCopiedRecordId((current) => (current === record.id ? null : current)), 1500);
    } catch {
      setCopiedRecordId(null);
    }
  };

  const renderDataRecord = (record: UserHookDataRecord) => {
    const entries = recordEntries(record.data);
    return (
      <section key={record.id} className="rounded-lg bg-muted/40 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Database className="h-3.5 w-3.5 flex-shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
          <span className="truncate text-xs font-medium">{record.type}</span>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => void copyRecord(record)}
          >
            <Clipboard className="h-3 w-3" aria-hidden="true" />
            {copiedRecordId === record.id ? '已复制' : '复制 JSON'}
          </button>
        </div>
        {entries.length > 0 ? (
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {entries.map(([key, value]) => (
              <div key={key} className="min-w-0 rounded-md bg-background px-2.5 py-2">
                <span className="block truncate text-[10px] text-muted-foreground" title={key}>{key}</span>
                <span className="mt-0.5 block truncate text-xs font-medium" title={formatRecordValue(value)}>
                  {formatRecordValue(value)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2.5 text-[11px] leading-5">
            {JSON.stringify(record.data, null, 2)}
          </pre>
        )}
        <details className="mt-2 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none">查看原始数据</summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2.5 text-foreground">
            {JSON.stringify(record.data, null, 2)}
          </pre>
        </details>
      </section>
    );
  };

  return (
    <div className="fixed inset-0 z-[10000]" data-hook-execution-records>
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/35 backdrop-blur-[1px]"
        aria-label="关闭我的执行记录"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="hook-execution-records-title"
        className="absolute inset-y-0 right-0 z-[10001] flex w-full max-w-xl flex-col border-l border-border bg-background text-foreground shadow-2xl"
      >
        <header className="flex flex-shrink-0 items-start gap-3 border-b border-border px-5 py-4">
          <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
            <Clock3 className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="hook-execution-records-title" className="truncate text-base font-semibold">我的执行记录</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{hook.name} · 当前工作区</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="关闭我的执行记录"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-5 py-3">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            仅显示当前账号在当前工作区中的记录
          </p>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
            disabled={loading || loadingMore}
            onClick={onRefresh}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            刷新
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
              <p>{error}</p>
              <button type="button" className="mt-2 text-xs font-medium underline underline-offset-2" onClick={onRefresh}>
                重新加载
              </button>
            </div>
          ) : loading && executions.length === 0 && standaloneRecords.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              正在加载执行记录
            </div>
          ) : executions.length === 0 && standaloneRecords.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-14 text-center">
              <Clock3 className="mx-auto h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium">暂无你的执行记录</p>
              <p className="mt-1 text-xs text-muted-foreground">该 Hook 执行后会显示在这里。</p>
            </div>
          ) : (
            <div className="space-y-3">
              {standaloneRecords.length > 0 ? (
                <section className="overflow-hidden rounded-xl border border-violet-200 bg-violet-50/40 dark:border-violet-900 dark:bg-violet-950/20">
                  <div className="border-b border-violet-200 px-3 py-2.5 dark:border-violet-900">
                    <div className="flex items-center gap-2">
                      <Database className="h-3.5 w-3.5 text-violet-600 dark:text-violet-300" aria-hidden="true" />
                      <h3 className="text-xs font-semibold">历史数据记录</h3>
                      <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                        {standaloneRecords.length} 条
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                      这些数据由该 Hook 产生，但来自旧版本的执行链路，因此单独展示。
                    </p>
                  </div>
                  <div className="space-y-3 p-3">
                    {standaloneRecords.map((record) => (
                      <article key={record.id} className="space-y-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span>{formatRecordTime(record.createdAt)}</span>
                          {record.sessionId ? (
                            <code className="truncate" title={record.sessionId}>会话 {shortSessionId(record.sessionId)}</code>
                          ) : <span>无会话标识</span>}
                        </div>
                        {renderDataRecord(record)}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {executions.map((execution) => {
                const duration = formatDuration(execution.durationMs);
                const isSucceeded = execution.status === 'succeeded';
                const isFailed = execution.status === 'failed';
                return (
                  <article key={execution.id} className="overflow-hidden rounded-xl border border-border bg-background">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/20 px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${isFailed
                        ? 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                        : isSucceeded
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                          : 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300'
                        }`}
                      >
                        {isFailed ? <XCircle className="h-3 w-3" aria-hidden="true" /> : isSucceeded ? (
                          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                        ) : <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                        {isFailed ? '失败' : isSucceeded ? '已完成' : '执行中'}
                      </span>
                      <span className="text-xs text-muted-foreground">{execution.eventName}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">{formatExecutionTime(execution)}</span>
                    </div>
                    <div className="space-y-3 p-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {duration ? <span>耗时 {duration}</span> : null}
                        {execution.sessionId ? (
                          <code className="truncate" title={execution.sessionId}>会话 {shortSessionId(execution.sessionId)}</code>
                        ) : <span>无会话标识</span>}
                      </div>

                      {execution.records.map(renderDataRecord)}
                    </div>
                  </article>
                );
              })}

              {hasMore ? (
                <button
                  type="button"
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-input bg-background text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                >
                  {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                  {loadingMore ? '正在加载' : '加载更多'}
                </button>
              ) : null}
            </div>
          )}
        </div>

        <footer className="flex flex-shrink-0 items-center justify-between border-t border-border px-5 py-3 text-xs text-muted-foreground">
          <span>共 {total} 次执行</span>
          <span>
            已显示 {executions.length} 条
            {standaloneRecords.length > 0 ? ` · ${standaloneRecords.length} 条历史数据` : ''}
          </span>
        </footer>
      </aside>
    </div>
  );
}
