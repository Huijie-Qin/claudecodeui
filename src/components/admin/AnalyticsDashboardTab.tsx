import { useCallback, useEffect, useMemo, useState, type ComponentType, type FormEvent } from 'react';
import {
  Activity,
  BarChart3,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  MessageSquare,
  RefreshCw,
  Search,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';

import { Button } from '../../shared/view/ui';
import { api } from '../../utils/api';

type AnalyticsMetrics = {
  totalUsers: number;
  activeUsers: number;
  newUsersToday: number;
  dau: number;
  mau: number;
  totalSessions: number;
  newSessionsToday: number;
};

type DailyNewUsers = {
  day: string;
  count: number;
};

type TenantSessionRanking = {
  tenantId: number;
  tenantCode: string;
  tenantName: string;
  status: string;
  userCount: number;
  sessionCount: number;
  lastActivityAt: string | null;
};

type AnalyticsSummary = {
  range: {
    days: number;
    since: string;
    generatedAt: string;
    timeZone: string;
  };
  metrics: AnalyticsMetrics;
  dailyNewUsers: DailyNewUsers[];
  tenantSessionRanking: TenantSessionRanking[];
};

type AnalyticsUser = {
  userId: number;
  username: string;
  isActive: boolean;
  userCreatedAt: string | null;
  lastLoginAt: string | null;
  sessionCount: number;
  firstSessionAt: string | null;
  lastSessionAt: string | null;
  lastActivityAt: string | null;
  tenantNames: string | null;
};

type AnalyticsUsersPayload = {
  range: {
    scope: 'all_time';
    generatedAt: string;
    timeZone: string;
  };
  users: AnalyticsUser[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    sortBy: 'sessionCount';
    sortDirection: 'desc';
    search: string;
  };
};

type ErrorPayload = {
  error?: string;
  message?: string;
};

const RANGE_OPTIONS = [7, 30, 90] as const;
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const numberFormatter = new Intl.NumberFormat('zh-CN');
function formatNumber(value: number | null | undefined): string {
  return numberFormatter.format(Number(value || 0));
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value.endsWith('Z') || value.includes('+') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatShortDay(value: string): string {
  const parsed = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
  });
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as ErrorPayload));
  return payload.error || payload.message || fallback;
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold text-foreground">{value}</div>
        </div>
        <div className="rounded-md bg-primary/10 p-2 text-primary">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      {detail ? <div className="mt-2 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function DailyNewUsersChart({ rows }: { rows: DailyNewUsers[] }) {
  const maxValue = Math.max(1, ...rows.map((row) => row.count));
  const tickEvery = rows.length <= 10 ? 1 : rows.length <= 30 ? 5 : 15;
  const minWidth = Math.max(640, rows.length * 24);

  return (
    <div className="overflow-x-auto pb-2">
      <div style={{ minWidth }}>
        <div className="flex h-52 items-end gap-1 border-b border-border px-1 pt-4">
          {rows.map((row) => {
            const height = row.count > 0 ? Math.max(4, (row.count / maxValue) * 100) : 0;
            return (
              <div
                key={row.day}
                className="group relative flex h-full min-w-0 flex-1 items-end"
                title={`${row.day}：${formatNumber(row.count)} 位新增用户`}
              >
                <div
                  className="w-full rounded-t bg-primary/75 transition-colors group-hover:bg-primary"
                  style={{ height: `${height}%` }}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-1 px-1 text-[10px] text-muted-foreground">
          {rows.map((row, index) => (
            <div key={row.day} className="min-w-0 flex-1 text-center">
              {index === 0 || index === rows.length - 1 || index % tickEvery === 0
                ? formatShortDay(row.day)
                : ''}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TenantRanking({ rows }: { rows: TenantSessionRanking[] }) {
  const maxSessions = Math.max(1, ...rows.map((row) => row.sessionCount));

  return (
    <section className="rounded-lg border border-border bg-background">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">租户会话数排行</h3>
        <p className="mt-1 text-xs text-muted-foreground">按历史会话总数降序排列</p>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无租户会话数据</div>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((row, index) => (
            <div key={row.tenantId} className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">{row.tenantName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {formatNumber(row.userCount)} 位成员 · 最后活动 {formatDate(row.lastActivityAt)}
                    </div>
                  </div>
                </div>
                <div className="shrink-0 text-sm font-semibold text-foreground">
                  {formatNumber(row.sessionCount)}
                </div>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: `${Math.max(2, (row.sessionCount / maxSessions) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function UserRanking({
  refreshVersion,
}: {
  refreshVersion: number;
}) {
  const [payload, setPayload] = useState<AnalyticsUsersPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.analyticsUsers({
        page,
        pageSize,
        search,
      });
      if (!response.ok) {
        setError(await readError(response, '加载用户会话排行失败'));
        return;
      }
      const nextPayload = await response.json() as AnalyticsUsersPayload;
      setPayload(nextPayload);
      if (nextPayload.pagination.page !== page) {
        setPage(nextPayload.pagination.page);
      }
    } catch (caughtError) {
      console.error('[AnalyticsDashboardTab] Failed to load user session ranking:', caughtError);
      setError('加载用户会话排行失败');
    } finally {
      setIsLoading(false);
    }
  }, [page, pageSize, search]);

  useEffect(() => {
    void refreshVersion;
    void loadUsers();
  }, [loadUsers, refreshVersion]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setSearch(searchDraft.trim());
  };

  const clearSearch = () => {
    setSearchDraft('');
    setSearch('');
    setPage(1);
  };

  return (
    <section className="rounded-lg border border-border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">用户会话数排行</h3>
          <p className="mt-1 text-xs text-muted-foreground">按历史会话总数和最后会话活动时间排序</p>
        </div>
        <form className="flex items-center gap-2" onSubmit={submitSearch}>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="搜索用户或租户"
              className="h-8 w-48 rounded-md border border-border bg-background pl-8 pr-2 text-xs text-foreground outline-none focus:border-primary"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">搜索</Button>
          {search ? <Button type="button" variant="ghost" size="sm" onClick={clearSearch}>清除</Button> : null}
        </form>
      </div>

      {error ? (
        <div className="px-4 py-8 text-center text-sm text-destructive">{error}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">排名</th>
                <th className="px-4 py-3 font-medium">用户</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">所属租户</th>
                <th className="px-4 py-3 text-right font-medium">会话数</th>
                <th className="px-4 py-3 font-medium">首次创建会话</th>
                <th className="px-4 py-3 font-medium">最后创建会话</th>
                <th className="px-4 py-3 font-medium">最后会话活动</th>
                <th className="px-4 py-3 font-medium">最后登录</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && !payload ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">正在加载...</td>
                </tr>
              ) : payload?.users.length ? payload.users.map((user, index) => (
                <tr key={user.userId} className="hover:bg-muted/30">
                  <td className="px-4 py-3 text-muted-foreground">
                    {(payload.pagination.page - 1) * payload.pagination.pageSize + index + 1}
                  </td>
                  <td className="px-4 py-3 font-medium text-foreground">{user.username}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-1 text-xs ${
                      user.isActive
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'bg-muted text-muted-foreground'
                    }`}
                    >
                      {user.isActive ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="max-w-56 truncate px-4 py-3 text-muted-foreground">{user.tenantNames || '-'}</td>
                  <td className="px-4 py-3 text-right font-semibold text-foreground">
                    {formatNumber(user.sessionCount)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(user.firstSessionAt)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(user.lastSessionAt)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(user.lastActivityAt)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(user.lastLoginAt)}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">暂无匹配用户</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
        <div className="text-xs text-muted-foreground">
          共 {formatNumber(payload?.pagination.total)} 位用户
          {isLoading ? ' · 正在刷新' : ''}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            aria-label="每页用户数"
          >
            {PAGE_SIZE_OPTIONS.map((value) => (
              <option key={value} value={value}>每页 {value}</option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={!payload || payload.pagination.page <= 1 || isLoading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            aria-label="上一页"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-20 text-center text-xs text-muted-foreground">
            {payload?.pagination.page || 1} / {payload?.pagination.totalPages || 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!payload || payload.pagination.page >= payload.pagination.totalPages || isLoading}
            onClick={() => setPage((current) => current + 1)}
            aria-label="下一页"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function AnalyticsDashboardTab() {
  const [rangeDays, setRangeDays] = useState<(typeof RANGE_OPTIONS)[number]>(30);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const loadSummary = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.analyticsSummary(rangeDays);
      if (!response.ok) {
        setError(await readError(response, '加载统计面板失败'));
        return;
      }
      setSummary(await response.json() as AnalyticsSummary);
    } catch (caughtError) {
      console.error('[AnalyticsDashboardTab] Failed to load analytics summary:', caughtError);
      setError('加载统计面板失败');
    } finally {
      setIsLoading(false);
    }
  }, [rangeDays]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const refresh = () => {
    setRefreshVersion((current) => current + 1);
    void loadSummary();
  };

  const metrics = summary?.metrics;
  const chartTotal = useMemo(
    () => summary?.dailyNewUsers.reduce((sum, row) => sum + row.count, 0) || 0,
    [summary],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">统计面板</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            用户增长、会话活跃度和会话数量排行
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            更新于 {formatDate(summary?.range.generatedAt)}
          </span>
          <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Users} label="用户总数" value={formatNumber(metrics?.totalUsers)} />
        <MetricCard icon={UserCheck} label="启用用户数" value={formatNumber(metrics?.activeUsers)} />
        <MetricCard icon={UserPlus} label="今日新增用户" value={formatNumber(metrics?.newUsersToday)} />
        <MetricCard icon={Activity} label="DAU" value={formatNumber(metrics?.dau)} detail="今日有会话活动的用户数" />
        <MetricCard icon={CalendarDays} label="MAU" value={formatNumber(metrics?.mau)} detail="近 30 天有会话活动的用户数" />
        <MetricCard icon={MessageSquare} label="会话总数" value={formatNumber(metrics?.totalSessions)} />
        <MetricCard icon={Clock} label="今日新建会话数" value={formatNumber(metrics?.newSessionsToday)} />
      </div>

      <section className="rounded-lg border border-border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">每日新增用户数</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              最近 {rangeDays} 天共新增 {formatNumber(chartTotal)} 位用户
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-md bg-muted p-1">
            {RANGE_OPTIONS.map((value) => (
              <Button
                key={value}
                variant={rangeDays === value ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => setRangeDays(value)}
              >
                {value} 天
              </Button>
            ))}
          </div>
        </div>
        <div className="px-4 py-3">
          {summary?.dailyNewUsers.length ? (
            <DailyNewUsersChart rows={summary.dailyNewUsers} />
          ) : (
            <div className="py-16 text-center text-sm text-muted-foreground">暂无新增用户数据</div>
          )}
        </div>
      </section>

      <UserRanking refreshVersion={refreshVersion} />
      <TenantRanking rows={summary?.tenantSessionRanking || []} />

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <BarChart3 className="h-3.5 w-3.5" />
        <span>本面板仅使用用户、租户和会话索引数据，不读取聊天 JSONL。</span>
        <Building2 className="ml-auto h-3.5 w-3.5" />
      </div>
    </div>
  );
}
