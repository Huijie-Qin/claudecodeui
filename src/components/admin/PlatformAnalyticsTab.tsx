import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import {
  Activity,
  BarChart3,
  Building2,
  Clock,
  Download,
  MessageSquare,
  RefreshCw,
  Search,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';
import { api } from '../../utils/api';

type AnalyticsOverview = {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  systemAdmins: number;
  usersWithLogin: number;
  activeUsers7d: number;
  activeUsers30d: number;
  pendingInvites: number;
  expiredInvites: number;
  totalTenants: number;
  activeTenants: number;
  activeMemberships: number;
  activeWorkspaces: number;
  totalWorkspaces: number;
  totalSessions: number;
  sessions7d: number;
  sessions30d: number;
  sessionsInWindow: number;
  totalMessages: number;
  messages7d: number;
  messages30d: number;
  messagesInWindow: number;
  userMessagesInWindow: number;
  assistantMessagesInWindow: number;
  systemMessagesInWindow: number;
  tokenCountInWindow: number;
  activeDaysInWindow: number;
  totalRuntimes: number;
  liveRuntimes: number;
  failedRuntimes: number;
  lastActivityAt: string | null;
  activationRate: number;
};

type DailyActivity = {
  day: string;
  newUsers: number;
  sessions: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  systemMessages: number;
  tokenCount: number;
  activeUsers: number;
};

type TopUser = {
  userId: number;
  username: string;
  isActive: number;
  lastLogin: string | null;
  tenants: number;
  ownedWorkspaces: number;
  sessions: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  systemMessages: number;
  tokenCount: number;
  activeDays: number;
  lastActivityAt: string | null;
};

type TenantOption = {
  tenantId: number;
  code: string;
  name: string;
  status: string;
};

type TenantUsage = {
  tenantId: number;
  code: string;
  name: string;
  status: string;
  users: number;
  workspaces: number;
  sessions: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  systemMessages: number;
  tokenCount: number;
  activeDays: number;
  liveRuntimes: number;
  lastActivityAt: string | null;
};

type PlatformAnalytics = {
  days: number;
  selectedTenantIds: number[];
  generatedAt: string;
  overview: AnalyticsOverview;
  tenantOptions: TenantOption[];
  dailyActivity: DailyActivity[];
  topUsers: TopUser[];
  tenantUsage: TenantUsage[];
};

type AnalyticsPayload = {
  analytics?: PlatformAnalytics;
  error?: string;
  message?: string;
};

type MetricTileProps = {
  label: string;
  value: string;
  helper?: string;
  icon: ComponentType<{ className?: string }>;
};

const DAY_OPTIONS = [7, 30, 90];
const numberFormatter = new Intl.NumberFormat();

function formatNumber(value: number | null | undefined): string {
  return numberFormatter.format(Number(value || 0));
}

function formatPercent(value: number | null | undefined): string {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function maxOf<T>(rows: T[], getValue: (row: T) => number): number {
  return Math.max(1, ...rows.map((row) => getValue(row)));
}

function matchesQuery(value: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return value.toLowerCase().includes(normalized);
}

function MetricTile({ label, value, helper, icon: Icon }: MetricTileProps) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
        </div>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      {helper ? <div className="mt-2 truncate text-xs text-muted-foreground">{helper}</div> : null}
    </div>
  );
}

function HorizontalBar({ value, max }: { value: number; max: number }) {
  const width = max <= 0 ? 0 : Math.max(4, Math.round((value / max) * 100));

  return (
    <div className="h-2 overflow-hidden rounded bg-muted">
      <div className="h-full rounded bg-primary" style={{ width: `${width}%` }} />
    </div>
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as AnalyticsPayload));
  return payload.error || payload.message || fallback;
}

function buildAnalyticsHtml(analytics: PlatformAnalytics, t: ReturnType<typeof useTranslation>['t']): string {
  const overview = analytics.overview;
  const metricRows = [
    [t('analytics.metrics.users'), formatNumber(overview.totalUsers), t('analytics.metrics.activeUsers', { count: overview.activeUsers, rate: formatPercent(overview.activationRate) })],
    [t('analytics.metrics.active30d'), formatNumber(overview.activeUsers30d), t('analytics.metrics.active7d', { count: overview.activeUsers7d })],
    [t('analytics.metrics.sessions'), formatNumber(overview.sessionsInWindow), t('analytics.metrics.totalSessions', { count: overview.totalSessions })],
    [t('analytics.metrics.messages'), formatNumber(overview.messagesInWindow), t('analytics.metrics.totalMessages', { count: overview.totalMessages })],
    [t('analytics.metrics.userMessages'), formatNumber(overview.userMessagesInWindow), t('analytics.metrics.assistantMessages', { count: overview.assistantMessagesInWindow })],
    [t('analytics.metrics.systemMessagesLabel'), formatNumber(overview.systemMessagesInWindow), t('analytics.metrics.systemMessagesHelp')],
    [t('analytics.metrics.tokens'), formatNumber(overview.tokenCountInWindow), t('analytics.metrics.activeDays', { count: overview.activeDaysInWindow })],
    [t('analytics.metrics.tenants'), formatNumber(overview.activeTenants), t('analytics.metrics.workspaces', { count: overview.activeWorkspaces })],
    [t('analytics.metrics.lastUsed'), formatDateTime(overview.lastActivityAt), t('analytics.metrics.reportWindow', { count: analytics.days })],
  ];
  const rowsToHtml = (rows: Array<Array<string | number | null | undefined>>) => rows.map((row) => (
    `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
  )).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(t('analytics.exportTitle', { days: analytics.days }))}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f8fafc; color: #0f172a; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 48px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.2; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    .meta { margin-top: 8px; color: #64748b; font-size: 13px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 24px; }
    .metric { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; }
    .metric-label { color: #64748b; font-size: 12px; }
    .metric-value { margin-top: 6px; font-size: 24px; font-weight: 700; }
    .metric-helper { margin-top: 6px; color: #64748b; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 13px; }
    th { background: #f1f5f9; color: #475569; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(t('analytics.exportTitle', { days: analytics.days }))}</h1>
    <div class="meta">${escapeHtml(t('analytics.generatedAt', { time: formatDateTime(analytics.generatedAt) }))}</div>
    <section class="metrics">
      ${metricRows.map(([label, value, helper]) => `
        <article class="metric">
          <div class="metric-label">${escapeHtml(label)}</div>
          <div class="metric-value">${escapeHtml(value)}</div>
          <div class="metric-helper">${escapeHtml(helper)}</div>
        </article>
      `).join('')}
    </section>

    <h2>${escapeHtml(t('analytics.dailyActivity'))}</h2>
    <table>
      <thead><tr><th>Day</th><th>New users</th><th>Active users</th><th>Sessions</th><th>Messages</th><th>User messages</th><th>Assistant messages</th><th>System messages</th><th>Tokens</th></tr></thead>
      <tbody>${rowsToHtml(analytics.dailyActivity.map((row) => [row.day, row.newUsers, row.activeUsers, row.sessions, row.messages, row.userMessages, row.assistantMessages, row.systemMessages, row.tokenCount]))}</tbody>
    </table>

    <h2>${escapeHtml(t('analytics.topUsers'))}</h2>
    <table>
      <thead><tr><th>User</th><th>Sessions</th><th>Total messages</th><th>User messages</th><th>Assistant messages</th><th>System messages</th><th>Tokens</th><th>Active days</th><th>Last activity</th></tr></thead>
      <tbody>${rowsToHtml(analytics.topUsers.map((row) => [row.username, row.sessions, row.messages, row.userMessages, row.assistantMessages, row.systemMessages, row.tokenCount, row.activeDays, formatDateTime(row.lastActivityAt)]))}</tbody>
    </table>

    <h2>${escapeHtml(t('analytics.tenantUsage'))}</h2>
    <table>
      <thead><tr><th>Tenant</th><th>Code</th><th>Users</th><th>Workspaces</th><th>Sessions</th><th>Total messages</th><th>User messages</th><th>Assistant messages</th><th>System messages</th><th>Tokens</th><th>Active days</th><th>Last activity</th></tr></thead>
      <tbody>${rowsToHtml(analytics.tenantUsage.map((row) => [row.name, row.code, row.users, row.workspaces, row.sessions, row.messages, row.userMessages, row.assistantMessages, row.systemMessages, row.tokenCount, row.activeDays, formatDateTime(row.lastActivityAt)]))}</tbody>
    </table>
  </main>
</body>
</html>`;
}

export default function PlatformAnalyticsTab() {
  const { t } = useTranslation('admin');
  const [days, setDays] = useState(30);
  const [selectedTenantIds, setSelectedTenantIds] = useState<number[]>([]);
  const [tenantSearch, setTenantSearch] = useState('');
  const [analytics, setAnalytics] = useState<PlatformAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await api.admin.analytics(days, selectedTenantIds);
      if (!response.ok) {
        setError(await readError(response, t('analytics.errors.load')));
        return;
      }

      const payload = await response.json() as AnalyticsPayload;
      setAnalytics(payload.analytics || null);
    } catch (caughtError) {
      console.error('[PlatformAnalyticsTab] Failed to load analytics:', caughtError);
      setError(t('analytics.errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [days, selectedTenantIds, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const userMax = useMemo(
    () => maxOf(analytics?.topUsers || [], (row) => row.tokenCount + row.messages + row.sessions),
    [analytics],
  );
  const dailyMax = useMemo(
    () => maxOf(analytics?.dailyActivity || [], (row) => row.messages + row.sessions),
    [analytics],
  );
  const filteredTenantOptions = useMemo(() => (
    (analytics?.tenantOptions || []).filter((tenant) => (
      matchesQuery(`${tenant.name} ${tenant.code}`, tenantSearch)
    ))
  ), [analytics, tenantSearch]);

  const overview = analytics?.overview;

  const toggleTenantId = useCallback((tenantId: number) => {
    setSelectedTenantIds((current) => (
      current.includes(tenantId)
        ? current.filter((id) => id !== tenantId)
        : [...current, tenantId]
    ));
  }, []);

  const exportHtml = useCallback(() => {
    if (!analytics) return;

    const html = buildAnalyticsHtml(analytics, t);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `platform-analytics-${analytics.days}d-${new Date().toISOString().slice(0, 10)}.html`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [analytics, t]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('analytics.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('analytics.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            {DAY_OPTIONS.map((option) => (
              <Button
                key={option}
                variant={days === option ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setDays(option)}
                className="h-8"
              >
                {t('analytics.days', { count: option })}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={isLoading}>
            <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {t('common.refresh')}
          </Button>
          <Button variant="outline" size="sm" onClick={exportHtml} disabled={!analytics}>
            <Download className="h-4 w-4" />
            {t('analytics.exportHtml')}
          </Button>
        </div>
      </div>

      {overview ? (
        <>
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">{t('analytics.tenantFilter.title')}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedTenantIds.length > 0
                    ? t('analytics.tenantFilter.selected', { count: selectedTenantIds.length })
                    : t('analytics.tenantFilter.all')}
                </p>
              </div>
              {selectedTenantIds.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={() => setSelectedTenantIds([])}>
                  {t('analytics.tenantFilter.clear')}
                </Button>
              ) : null}
            </div>
            <div className="space-y-2 rounded-md border border-border bg-background p-3">
              <div className="relative max-w-sm">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={tenantSearch}
                  onChange={(event) => setTenantSearch(event.target.value)}
                  placeholder={t('analytics.tenantFilter.search')}
                />
              </div>
              <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto">
                {filteredTenantOptions.length === 0 ? (
                  <span className="text-sm text-muted-foreground">{t('analytics.tenantFilter.empty')}</span>
                ) : filteredTenantOptions.map((tenant) => (
                  <label
                    key={tenant.tenantId}
                    className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-2 text-sm text-foreground hover:bg-muted/60"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input accent-primary"
                      checked={selectedTenantIds.includes(tenant.tenantId)}
                      onChange={() => toggleTenantId(tenant.tenantId)}
                    />
                    <span>{tenant.name}</span>
                    <span className="text-xs text-muted-foreground">{tenant.code}</span>
                  </label>
                ))}
              </div>
            </div>
          </section>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              icon={Users}
              label={t('analytics.metrics.users')}
              value={formatNumber(overview.totalUsers)}
              helper={t('analytics.metrics.activeUsers', {
                count: overview.activeUsers,
                rate: formatPercent(overview.activationRate),
              })}
            />
            <MetricTile
              icon={TrendingUp}
              label={t('analytics.metrics.active30d')}
              value={formatNumber(overview.activeUsers30d)}
              helper={t('analytics.metrics.active7d', { count: overview.activeUsers7d })}
            />
            <MetricTile
              icon={MessageSquare}
              label={t('analytics.metrics.sessions')}
              value={formatNumber(overview.sessionsInWindow)}
              helper={t('analytics.metrics.totalSessions', { count: overview.totalSessions })}
            />
            <MetricTile
              icon={BarChart3}
              label={t('analytics.metrics.messages')}
              value={formatNumber(overview.messagesInWindow)}
              helper={t('analytics.metrics.totalMessages', { count: overview.totalMessages })}
            />
            <MetricTile
              icon={Activity}
              label={t('analytics.metrics.userMessages')}
              value={formatNumber(overview.userMessagesInWindow)}
              helper={t('analytics.metrics.assistantMessages', { count: overview.assistantMessagesInWindow })}
            />
            <MetricTile
              icon={MessageSquare}
              label={t('analytics.metrics.systemMessagesLabel')}
              value={formatNumber(overview.systemMessagesInWindow)}
              helper={t('analytics.metrics.systemMessagesHelp')}
            />
            <MetricTile
              icon={Clock}
              label={t('analytics.metrics.tokens')}
              value={formatNumber(overview.tokenCountInWindow)}
              helper={t('analytics.metrics.activeDays', { count: overview.activeDaysInWindow })}
            />
            <MetricTile
              icon={Building2}
              label={t('analytics.metrics.tenants')}
              value={formatNumber(overview.activeTenants)}
              helper={t('analytics.metrics.workspaces', { count: overview.activeWorkspaces })}
            />
            <MetricTile
              icon={Clock}
              label={t('analytics.metrics.lastUsed')}
              value={formatDateTime(overview.lastActivityAt)}
              helper={t('analytics.metrics.reportWindow', { count: analytics?.days || days })}
            />
          </div>

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-foreground">{t('analytics.dailyActivity')}</h3>
            <div className="overflow-x-auto rounded-md border border-border bg-background px-3 py-3">
              <div className="flex min-w-max items-end gap-2">
                {(analytics?.dailyActivity || []).map((row) => {
                  const total = row.messages + row.sessions;
                  const height = dailyMax <= 0 ? 0 : Math.max(8, Math.round((total / dailyMax) * 96));
                  return (
                    <div
                      key={row.day}
                      className="flex min-h-32 w-12 shrink-0 flex-col justify-end gap-2"
                      title={`${row.day}: ${total}`}
                    >
                      <div className="text-center text-[10px] text-muted-foreground">{formatNumber(total)}</div>
                      <div className="rounded-t bg-primary/80" style={{ height }} />
                      <div className="truncate text-center text-[10px] text-muted-foreground">
                        {row.day.slice(5)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-1">
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-foreground">{t('analytics.topUsers')}</h3>
              <div className="max-h-80 overflow-auto rounded-md border border-border">
                {(analytics?.topUsers || []).map((row) => (
                  <div key={row.userId} className="grid gap-2 border-b border-border px-3 py-3 text-sm last:border-b-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-medium text-foreground">{row.username}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('analytics.table.sessionsMessages', {
                          sessions: row.sessions,
                          messages: row.messages,
                        })}
                      </span>
                    </div>
                    <HorizontalBar value={row.tokenCount + row.messages + row.sessions} max={userMax} />
                    <div className="truncate text-xs text-muted-foreground">
                      {t('analytics.table.userFootnote', {
                        userMessages: row.userMessages,
                        assistantMessages: row.assistantMessages,
                        systemMessages: row.systemMessages,
                        tokens: formatNumber(row.tokenCount),
                        activeDays: row.activeDays,
                        lastUsed: formatDateTime(row.lastActivityAt),
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-foreground">{t('analytics.tenantUsage')}</h3>
            <div className="overflow-auto rounded-md border border-border">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('fields.tenant')}</th>
                    <th className="px-3 py-2 font-medium">{t('analytics.table.sessions')}</th>
                    <th className="px-3 py-2 font-medium">{t('analytics.table.messages')}</th>
                    <th className="px-3 py-2 font-medium">{t('analytics.table.userMessages')}</th>
                    <th className="px-3 py-2 font-medium">{t('analytics.table.assistantMessages')}</th>
                    <th className="px-3 py-2 font-medium">{t('analytics.table.systemMessages')}</th>
                    <th className="px-3 py-2 font-medium">{t('analytics.table.tokens')}</th>
                    <th className="px-3 py-2 font-medium">{t('analytics.table.activeDays')}</th>
                    <th className="px-3 py-2 font-medium">{t('analytics.table.lastUsed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(analytics?.tenantUsage || []).map((row) => (
                    <tr key={row.tenantId} className="border-t border-border">
                      <td className="px-3 py-3">
                        <div className="font-medium text-foreground">{row.name}</div>
                        <div className="text-xs text-muted-foreground">{row.code}</div>
                      </td>
                      <td className="px-3 py-3">{formatNumber(row.sessions)}</td>
                      <td className="px-3 py-3">{formatNumber(row.messages)}</td>
                      <td className="px-3 py-3">{formatNumber(row.userMessages)}</td>
                      <td className="px-3 py-3">{formatNumber(row.assistantMessages)}</td>
                      <td className="px-3 py-3">{formatNumber(row.systemMessages)}</td>
                      <td className="px-3 py-3">{formatNumber(row.tokenCount)}</td>
                      <td className="px-3 py-3">{formatNumber(row.activeDays)}</td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">{formatDateTime(row.lastActivityAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <div className="rounded-md border border-border px-3 py-8 text-center text-sm text-muted-foreground">
          {isLoading ? t('analytics.loading') : t('analytics.empty')}
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
