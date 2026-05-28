import { useCallback, useEffect, useMemo, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Building2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  Gauge,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldAlert,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';
import { api } from '../../utils/api';

type NullableNumber = number | null;

type AnalyticsKpis = {
  totalUsers: number;
  activeUsers: number;
  totalTenants: number;
  activeTenants: number;
  loginDau: number;
  loginMau: number;
  questionDau: number;
  questionMau: number;
  newLoginUsers: number;
  newQuestionUsers: number;
  churnedQuestionUsers: number;
  questionCount: number;
  sessionCount: number;
  assistantReplyCount: number;
  answerReturnRate: NullableNumber;
  sqlGeneratedCount: number;
  sqlGenerationRate: NullableNumber;
  dataOpsSubmissionCount: NullableNumber;
  dataOpsExecutionSuccessRate: NullableNumber;
  endToEndSuccessRate: NullableNumber;
  failedRuntimeCount: number;
  noAssistantReplyCount: number;
  highRiskSqlCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  tokenTrackedMessages: number;
  tokenTrackingEnabled: boolean;
  retentionD1: NullableNumber;
  retentionD7: NullableNumber;
  retentionD30: NullableNumber;
};

type AnalyticsOverall = {
  totalUsers: number;
  activeUsers: number;
  everActiveUsers: number;
  totalTenants: number;
  activeTenants: number;
  totalWorkspaces: number;
  activeWorkspaces: number;
  totalSessionCount: number;
  totalMessageCount: number;
  userMessageCount: number;
  systemMessageCount: number;
  assistantMessageCount: number;
  totalTokens: number;
  tokenTrackedMessages: number;
  tokenTrackingEnabled: boolean;
  totalErrorCount: number;
  failedRuntimeCount: number;
  failedSessionCount: number;
  highRiskSqlCount: number;
  assistantReplyCount: number;
  answerReturnRate: NullableNumber;
  averageMessagesPerSession: NullableNumber;
  averageUserMessagesPerSession: NullableNumber;
  messageUserCount: number;
};

type FunnelItem = {
  key: string;
  label: string;
  count: number | null;
  rateFromPrevious: number | null;
  tracked: boolean;
};

type TenantMetric = {
  tenantId: number;
  tenantCode: string;
  tenantName: string;
  status: string;
  totalUsers: number;
  activeUsers: number;
  questionUsers: number;
  questionCount: number;
  sessionCount: number;
};

type AnalyticsUserSortBy = 'sessionCount' | 'userMessageCount';

type AnalyticsUser = {
  userId: number;
  username: string;
  tenantNames: string | null;
  sessionCount: number;
  totalMessageCount: number;
  userMessageCount: number;
  systemMessageCount: number;
  assistantMessageCount: number;
  tokenCount: number;
  tokenTrackedMessages: number;
  activeDays: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  lastLoginAt: string | null;
  userCreatedAt: string | null;
};

type AnalyticsUsersPayload = {
  range: {
    days: number;
    since: string;
    generatedAt: string;
  };
  users: AnalyticsUser[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    sortBy: AnalyticsUserSortBy;
    sortDirection: 'desc';
    search: string;
  };
};

type QueryMetric = {
  queryKey: string;
  query: string;
  count: number;
  users: number;
  lastAskedAt?: string | null;
  lastFailedAt?: string | null;
  reason?: string;
};

type FailureReason = {
  reason: string;
  label: string;
  count: number;
};

type RetentionMetric = {
  cohortSize: number;
  retained: number;
  rate: NullableNumber;
};

type DailyTrendPoint = {
  day: string;
  loginUsers: number;
  questionUsers: number;
  questionCount: number;
  sqlGeneratedCount: number;
  sessionCount: number;
};

type AnalyticsCoverage = {
  loginHistory: string;
  questionEvents: boolean;
  sqlDetection: string;
  dataOpsEvents: boolean;
  tokenUsage: boolean;
};

type AnalyticsSummary = {
  range: {
    days: number;
    since: string;
    generatedAt: string;
  };
  overall: AnalyticsOverall;
  kpis: AnalyticsKpis;
  funnel: FunnelItem[];
  tenantDistribution: TenantMetric[];
  activeTenants: TenantMetric[];
  highFrequencyQueries: QueryMetric[];
  highFailureQueries: QueryMetric[];
  failureReasons: FailureReason[];
  retention: {
    d1: RetentionMetric;
    d7: RetentionMetric;
    d30: RetentionMetric;
  };
  dailyTrend: DailyTrendPoint[];
  coverage: AnalyticsCoverage;
};

type ErrorPayload = {
  error?: string;
  message?: string;
};

const RANGE_OPTIONS = [7, 30, 90];
const USER_ANALYTICS_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const USER_ANALYTICS_SORT_OPTIONS: Array<{ value: AnalyticsUserSortBy; label: string }> = [
  { value: 'sessionCount', label: '会话数' },
  { value: 'userMessageCount', label: '用户消息数' },
];
const RANK_BAR_COLORS = [
  'bg-emerald-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-rose-500',
];

function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat().format(value);
}

function formatTokenCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatNumber(value);
}

function formatPercent(value: number | null | undefined, fallback = '-'): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  return `${value.toFixed(1)}%`;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatShortDay(value: string): string {
  const parts = value.split('-');
  if (parts.length !== 3) return value;
  return `${parts[1]}/${parts[2]}`;
}

function getMax(values: number[]): number {
  return Math.max(1, ...values.filter((value) => Number.isFinite(value)));
}

function roundTo(value: number, precision = 2): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function getTrendTickInterval(pointCount: number): number {
  if (pointCount <= 10) return 1;
  if (pointCount <= 45) return 5;
  if (pointCount <= 75) return 10;
  return 15;
}

function shouldShowTrendTick(index: number, pointCount: number): boolean {
  if (pointCount <= 0) return false;
  if (index === 0 || index === pointCount - 1) return true;
  return index % getTrendTickInterval(pointCount) === 0;
}

const TREND_CHART_WIDTH = 720;
const TREND_CHART_HEIGHT = 220;
const TREND_CHART_PADDING = {
  top: 16,
  right: 20,
  bottom: 34,
  left: 36,
};

function buildTrendPoints(
  data: DailyTrendPoint[],
  getValue: (point: DailyTrendPoint) => number,
  maxValue: number,
) {
  const plotWidth = TREND_CHART_WIDTH - TREND_CHART_PADDING.left - TREND_CHART_PADDING.right;
  const plotHeight = TREND_CHART_HEIGHT - TREND_CHART_PADDING.top - TREND_CHART_PADDING.bottom;
  const denominator = Math.max(1, data.length - 1);

  return data.map((point, index) => {
    const value = getValue(point);
    return {
      x: TREND_CHART_PADDING.left + (plotWidth * index) / denominator,
      y: TREND_CHART_PADDING.top + plotHeight - (plotHeight * value) / maxValue,
      value,
      point,
    };
  });
}

function buildTrendPath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => (
    `${index === 0 ? 'M' : 'L'} ${roundTo(point.x)} ${roundTo(point.y)}`
  )).join(' ');
}

function getReasonLabel(reason: string): string {
  if (reason === 'runtime_failed') return '运行时失败';
  if (reason === 'no_assistant_reply') return '未返回助手消息';
  return reason;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as ErrorPayload));
  return payload.error || payload.message || fallback;
}

function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'default',
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail?: string;
  tone?: 'default' | 'good' | 'warning' | 'danger';
}) {
  const toneClassName = {
    default: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    good: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    danger: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
  }[tone];

  return (
    <div className="rounded-md border border-border bg-background px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold leading-7 text-foreground">{value}</div>
        </div>
        <div className={`rounded-md p-2 ${toneClassName}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      {detail ? <div className="mt-2 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function OverallMetrics({ metrics }: { metrics: AnalyticsOverall }) {
  return (
    <Section title="平台总体">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={Users}
          label="总用户数"
          value={formatNumber(metrics.totalUsers)}
          detail={`使用过 ${formatNumber(metrics.everActiveUsers)} · 活跃账号 ${formatNumber(metrics.activeUsers)} · 活跃租户 ${formatNumber(metrics.activeTenants)}/${formatNumber(metrics.totalTenants)}`}
        />
        <MetricTile
          icon={BarChart3}
          label="总会话数"
          value={formatNumber(metrics.totalSessionCount)}
          detail={`工作区 ${formatNumber(metrics.activeWorkspaces)}/${formatNumber(metrics.totalWorkspaces)} · 平均 ${formatNumber(metrics.averageMessagesPerSession)} 消息/会话`}
          tone="good"
        />
        <MetricTile
          icon={MessageSquare}
          label="总消息数"
          value={formatNumber(metrics.totalMessageCount)}
          detail={`用户 ${formatNumber(metrics.userMessageCount)} · 系统 ${formatNumber(metrics.systemMessageCount)} · 助手 ${formatNumber(metrics.assistantMessageCount)}`}
        />
        <MetricTile
          icon={Gauge}
          label="总 Token 数"
          value={metrics.tokenTrackingEnabled ? formatTokenCount(metrics.totalTokens) : '待补充'}
          detail={metrics.tokenTrackingEnabled
            ? `已追踪消息 ${formatNumber(metrics.tokenTrackedMessages)}`
            : '新的会话产生 usage 后展示'}
        />
        <MetricTile
          icon={TrendingUp}
          label="总用户消息数"
          value={formatNumber(metrics.userMessageCount)}
          detail={`平均 ${formatNumber(metrics.averageUserMessagesPerSession)} 条/会话 · 问数用户 ${formatNumber(metrics.messageUserCount)}`}
          tone="good"
        />
        <MetricTile
          icon={Database}
          label="总系统消息数"
          value={formatNumber(metrics.systemMessageCount)}
          detail="包含历史未标注 role 的系统类消息"
        />
        <MetricTile
          icon={Activity}
          label="总助手消息数"
          value={formatNumber(metrics.assistantMessageCount)}
          detail={`助手返回 ${formatNumber(metrics.assistantReplyCount)} · 返回率 ${formatPercent(metrics.answerReturnRate)}`}
        />
        <MetricTile
          icon={ShieldAlert}
          label="总错误数"
          value={formatNumber(metrics.totalErrorCount)}
          detail={`运行时失败 ${formatNumber(metrics.failedRuntimeCount)} · 会话失败/中止 ${formatNumber(metrics.failedSessionCount)} · 高风险 SQL ${formatNumber(metrics.highRiskSqlCount)}`}
          tone={metrics.totalErrorCount > 0 || metrics.highRiskSqlCount > 0 ? 'danger' : 'default'}
        />
      </div>
    </Section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function TrendChart({ data }: { data: DailyTrendPoint[] }) {
  const [hoveredTrendIndex, setHoveredTrendIndex] = useState<number | null>(null);
  const maxValue = getMax(data.flatMap((item) => [item.questionCount, item.questionUsers]));
  const questionPoints = buildTrendPoints(data, (item) => item.questionCount, maxValue);
  const userPoints = buildTrendPoints(data, (item) => item.questionUsers, maxValue);
  const plotHeight = TREND_CHART_HEIGHT - TREND_CHART_PADDING.top - TREND_CHART_PADDING.bottom;
  const plotBottom = TREND_CHART_PADDING.top + plotHeight;
  const hoveredQuestionPoint = hoveredTrendIndex == null ? null : questionPoints[hoveredTrendIndex];
  const hoveredUserPoint = hoveredTrendIndex == null ? null : userPoints[hoveredTrendIndex];
  const yAxisTicks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => {
    return {
      y: TREND_CHART_PADDING.top + plotHeight * (1 - ratio),
      value: Math.round(maxValue * ratio),
    };
  });

  if (data.length === 0) {
    return <EmptyState label="暂无趋势数据" />;
  }

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-emerald-500" />
          问数次数
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-sky-500" />
          问数用户
        </span>
      </div>
      <div className="relative mt-3 h-56 overflow-visible" onPointerLeave={() => setHoveredTrendIndex(null)}>
        <svg
          className="h-full w-full"
          role="img"
          viewBox={`0 0 ${TREND_CHART_WIDTH} ${TREND_CHART_HEIGHT}`}
          preserveAspectRatio="none"
          aria-label="问数趋势折线图"
        >
          <rect width={TREND_CHART_WIDTH} height={TREND_CHART_HEIGHT} fill="transparent" />
          {yAxisTicks.map((tick) => (
            <g key={tick.y}>
              <line
                x1={TREND_CHART_PADDING.left}
                x2={TREND_CHART_WIDTH - TREND_CHART_PADDING.right}
                y1={tick.y}
                y2={tick.y}
                stroke="currentColor"
                className="text-border"
                strokeWidth="1"
              />
              <text
                x={TREND_CHART_PADDING.left - 8}
                y={tick.y + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {formatNumber(tick.value)}
              </text>
            </g>
          ))}
          <path
            d={buildTrendPath(questionPoints)}
            fill="none"
            stroke="rgb(16 185 129)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={buildTrendPath(userPoints)}
            fill="none"
            stroke="rgb(14 165 233)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
          {hoveredQuestionPoint && hoveredUserPoint ? (
            <g>
              <line
                x1={hoveredQuestionPoint.x}
                x2={hoveredQuestionPoint.x}
                y1={TREND_CHART_PADDING.top}
                y2={plotBottom}
                stroke="currentColor"
                className="text-muted-foreground/50"
                strokeDasharray="4 4"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={hoveredQuestionPoint.x}
                cy={hoveredQuestionPoint.y}
                r="4"
                fill="rgb(16 185 129)"
                stroke="hsl(var(--background))"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={hoveredUserPoint.x}
                cy={hoveredUserPoint.y}
                r="4"
                fill="rgb(14 165 233)"
                stroke="hsl(var(--background))"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null}
          {questionPoints.map((item, index) => {
            const showMarker = data.length <= 45 || shouldShowTrendTick(index, data.length);

            return showMarker ? (
              <circle
                key={`question-${item.point.day}`}
                cx={item.x}
                cy={item.y}
                r="3"
                fill="rgb(16 185 129)"
                stroke="hsl(var(--background))"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ) : null;
          })}
          {userPoints.map((item, index) => {
            const showMarker = data.length <= 45 || shouldShowTrendTick(index, data.length);

            return showMarker ? (
              <circle
                key={`users-${item.point.day}`}
                cx={item.x}
                cy={item.y}
                r="3"
                fill="rgb(14 165 233)"
                stroke="hsl(var(--background))"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ) : null;
          })}
          {data.map((point, index) => (
            shouldShowTrendTick(index, data.length) ? (
              <text
                key={point.day}
                x={questionPoints[index]?.x || TREND_CHART_PADDING.left}
                y={TREND_CHART_HEIGHT - 10}
                textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'}
                className="fill-muted-foreground text-[10px]"
              >
                {formatShortDay(point.day)}
              </text>
            ) : null
          ))}
          {data.map((point, index) => {
            const currentX = questionPoints[index]?.x ?? TREND_CHART_PADDING.left;
            const previousX = questionPoints[index - 1]?.x ?? TREND_CHART_PADDING.left;
            const nextX = questionPoints[index + 1]?.x ?? TREND_CHART_WIDTH - TREND_CHART_PADDING.right;
            const left = index === 0 ? TREND_CHART_PADDING.left : (previousX + currentX) / 2;
            const right = index === data.length - 1
              ? TREND_CHART_WIDTH - TREND_CHART_PADDING.right
              : (currentX + nextX) / 2;

            return (
              <rect
                key={`hit-${point.day}`}
                x={left}
                y={TREND_CHART_PADDING.top}
                width={Math.max(1, right - left)}
                height={plotHeight}
                fill="transparent"
                className="cursor-crosshair"
                onPointerEnter={() => setHoveredTrendIndex(index)}
                onPointerMove={() => setHoveredTrendIndex(index)}
                tabIndex={0}
                onFocus={() => setHoveredTrendIndex(index)}
                onBlur={() => setHoveredTrendIndex(null)}
              />
            );
          })}
        </svg>
        {hoveredQuestionPoint && hoveredUserPoint ? (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
            style={{
              left: `${(hoveredQuestionPoint.x / TREND_CHART_WIDTH) * 100}%`,
              transform: hoveredQuestionPoint.x < 120
                ? 'translateX(0)'
                : hoveredQuestionPoint.x > TREND_CHART_WIDTH - 120
                  ? 'translateX(-100%)'
                  : 'translateX(-50%)',
            }}
          >
            <div className="font-medium text-foreground">{hoveredQuestionPoint.point.day}</div>
            <div className="mt-1.5 space-y-1">
              <div className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  问数次数
                </span>
                <span className="font-medium text-foreground">{formatNumber(hoveredQuestionPoint.value)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-sky-500" />
                  问数用户
                </span>
                <span className="font-medium text-foreground">{formatNumber(hoveredUserPoint.value)}</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FunnelView({ items }: { items: FunnelItem[] }) {
  const firstCount = items.find((item) => item.count != null)?.count || 1;

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const width = item.count == null ? 18 : Math.max(8, Math.round((item.count / firstCount) * 100));

        return (
          <div key={item.key} className="rounded-md border border-border bg-background px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-foreground">
                {item.label}
              </div>
              <div className="text-sm text-muted-foreground">
                {item.tracked ? formatNumber(item.count) : '待埋点'}
                <span className="ml-2 text-xs">
                  {item.tracked ? formatPercent(item.rateFromPrevious) : 'DataOps 事件未接入'}
                </span>
              </div>
            </div>
            <div className="mt-2 h-2 rounded-full bg-muted">
              <div
                className={item.tracked ? 'h-2 rounded-full bg-emerald-500' : 'h-2 rounded-full bg-muted-foreground/30'}
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TenantRanking({ tenants }: { tenants: TenantMetric[] }) {
  const maxQuestions = getMax(tenants.map((tenant) => tenant.questionCount));

  if (tenants.length === 0) {
    return <EmptyState label="暂无租户数据" />;
  }

  return (
    <div className="space-y-2">
      {tenants.map((tenant, index) => (
        <div key={tenant.tenantId} className="rounded-md border border-border bg-background px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{tenant.tenantName}</div>
              <div className="text-xs text-muted-foreground">
                {tenant.tenantCode} · {formatNumber(tenant.questionUsers)} 问数用户 · {formatNumber(tenant.activeUsers)} 活跃成员
              </div>
            </div>
            <div className="text-right text-sm font-medium text-foreground">
              {formatNumber(tenant.questionCount)}
            </div>
          </div>
          <div className="mt-2 h-2 rounded-full bg-muted">
            <div
              className={`h-2 rounded-full ${RANK_BAR_COLORS[index % RANK_BAR_COLORS.length]}`}
              style={{ width: `${Math.max(4, Math.round((tenant.questionCount / maxQuestions) * 100))}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function UserAnalyticsPanel({ rangeDays }: { rangeDays: number }) {
  const [payload, setPayload] = useState<AnalyticsUsersPayload | null>(null);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<AnalyticsUserSortBy>('sessionCount');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');

  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true);
    setUserError(null);

    try {
      const response = await api.admin.analyticsUsers({
        rangeDays,
        page,
        pageSize,
        sortBy,
        search,
      });
      if (!response.ok) {
        setUserError(await readError(response, '加载用户统计失败'));
        return;
      }

      const nextPayload = await response.json() as AnalyticsUsersPayload;
      setPayload(nextPayload);
      if (nextPayload.pagination.page !== page) {
        setPage(nextPayload.pagination.page);
      }
    } catch (caughtError) {
      console.error('[AnalyticsDashboardTab] Failed to load analytics users:', caughtError);
      setUserError('加载用户统计失败');
    } finally {
      setIsLoadingUsers(false);
    }
  }, [page, pageSize, rangeDays, search, sortBy]);

  useEffect(() => {
    setPage(1);
  }, [rangeDays]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

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
  const currentPage = payload?.pagination.page ?? page;
  const totalPages = payload?.pagination.totalPages ?? 1;
  const totalUsers = payload?.pagination.total ?? 0;
  const users = payload?.users ?? [];
  const hasUsers = users.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <form className="flex min-w-[260px] flex-1 flex-wrap items-center gap-2" onSubmit={submitSearch}>
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
              placeholder="搜索工号"
              type="search"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            <Search className="h-4 w-4" />
            搜索
          </Button>
          {search ? (
            <Button type="button" variant="ghost" size="sm" onClick={clearSearch}>
              清除
            </Button>
          ) : null}
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-background p-1">
            {USER_ANALYTICS_SORT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`h-8 rounded px-3 text-sm transition-colors ${sortBy === option.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                onClick={() => {
                  setSortBy(option.value);
                  setPage(1);
                }}
              >
                {option.label} ↓
              </button>
            ))}
          </div>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {USER_ANALYTICS_PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>{option} / 页</option>
            ))}
          </select>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadUsers()} disabled={isLoadingUsers}>
            <RefreshCw className={isLoadingUsers ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            刷新
          </Button>
        </div>
      </div>

      {userError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {userError}
        </div>
      ) : null}

      {!payload && isLoadingUsers ? (
        <div className="h-56 animate-pulse rounded-md border border-border bg-muted/40" />
      ) : !hasUsers ? (
        <EmptyState label={search ? '未找到匹配工号' : '暂无用户使用数据'} />
      ) : (
        <div className={isLoadingUsers ? 'opacity-70 transition-opacity' : undefined}>
          <div className="overflow-auto rounded-md border border-border">
            <table className="w-full min-w-[1120px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">工号/用户</th>
                  <th className="px-3 py-2 font-medium">租户</th>
                  <th className="px-3 py-2 text-right font-medium">会话数</th>
                  <th className="px-3 py-2 text-right font-medium">总消息数</th>
                  <th className="px-3 py-2 text-right font-medium">用户消息数</th>
                  <th className="px-3 py-2 text-right font-medium">系统消息数</th>
                  <th className="px-3 py-2 text-right font-medium">助手消息数</th>
                  <th className="px-3 py-2 text-right font-medium">Token 数</th>
                  <th className="px-3 py-2 text-right font-medium">活跃天数</th>
                  <th className="px-3 py-2 font-medium">首次使用时间</th>
                  <th className="px-3 py-2 font-medium">最后使用时间</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.userId} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">{user.username}</div>
                      <div className="text-xs text-muted-foreground">ID {user.userId}</div>
                    </td>
                    <td className="max-w-56 px-3 py-2 text-muted-foreground">
                      <span className="line-clamp-2 break-words">{user.tenantNames || '-'}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-foreground">{formatNumber(user.sessionCount)}</td>
                    <td className="px-3 py-2 text-right text-foreground">{formatNumber(user.totalMessageCount)}</td>
                    <td className="px-3 py-2 text-right text-foreground">{formatNumber(user.userMessageCount)}</td>
                    <td className="px-3 py-2 text-right text-foreground">{formatNumber(user.systemMessageCount)}</td>
                    <td className="px-3 py-2 text-right text-foreground">{formatNumber(user.assistantMessageCount)}</td>
                    <td className="px-3 py-2 text-right text-foreground">{formatTokenCount(user.tokenCount)}</td>
                    <td className="px-3 py-2 text-right text-foreground">{formatNumber(user.activeDays)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDateTime(user.firstUsedAt)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDateTime(user.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <div>
          共 {formatNumber(totalUsers)} 人 · 第 {formatNumber(currentPage)} / {formatNumber(totalPages)} 页
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={currentPage <= 1 || isLoadingUsers}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages || isLoadingUsers}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function QueryTable({
  rows,
  emptyLabel,
  failureMode = false,
}: {
  rows: QueryMetric[];
  emptyLabel: string;
  failureMode?: boolean;
}) {
  if (rows.length === 0) {
    return <EmptyState label={emptyLabel} />;
  }

  return (
    <div className="overflow-auto rounded-md border border-border">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Query</th>
            <th className="px-3 py-2 text-right font-medium">{failureMode ? '失败次数' : '次数'}</th>
            <th className="px-3 py-2 text-right font-medium">用户数</th>
            {failureMode ? <th className="px-3 py-2 font-medium">原因</th> : null}
            <th className="px-3 py-2 font-medium">{failureMode ? '最近失败' : '最近提问'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.queryKey}:${row.lastAskedAt || row.lastFailedAt || ''}`} className="border-b border-border last:border-b-0">
              <td className="max-w-[360px] px-3 py-2 text-foreground">
                <span className="line-clamp-2 break-words">{row.query}</span>
              </td>
              <td className="px-3 py-2 text-right text-foreground">{formatNumber(row.count)}</td>
              <td className="px-3 py-2 text-right text-foreground">{formatNumber(row.users)}</td>
              {failureMode ? <td className="px-3 py-2 text-muted-foreground">{getReasonLabel(row.reason || '')}</td> : null}
              <td className="px-3 py-2 text-muted-foreground">
                {formatDateTime(failureMode ? row.lastFailedAt : row.lastAskedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FailureReasons({ reasons }: { reasons: FailureReason[] }) {
  const maxCount = getMax(reasons.map((reason) => reason.count));

  if (reasons.length === 0) {
    return <EmptyState label="暂无失败归因数据" />;
  }

  return (
    <div className="space-y-2">
      {reasons.map((reason, index) => (
        <div key={reason.reason} className="rounded-md border border-border bg-background px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-foreground">{getReasonLabel(reason.reason) || reason.label}</span>
            <span className="font-medium text-foreground">{formatNumber(reason.count)}</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-muted">
            <div
              className={`h-2 rounded-full ${index === 0 ? 'bg-rose-500' : 'bg-amber-500'}`}
              style={{ width: `${Math.max(4, Math.round((reason.count / maxCount) * 100))}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function CoverageNotice({ coverage }: { coverage: AnalyticsCoverage }) {
  const items = [
    {
      label: '登录活跃',
      value: coverage.loginHistory === 'last_login_only' ? '基于 last_login 最新值' : '已接入事件',
      active: true,
    },
    {
      label: '问数事件',
      value: coverage.questionEvents ? '已接入消息表' : '待埋点',
      active: coverage.questionEvents,
    },
    {
      label: 'SQL 生成',
      value: coverage.sqlDetection === 'heuristic' ? '基于助手消息启发式识别' : '已接入事件',
      active: true,
    },
    {
      label: 'DataOps',
      value: coverage.dataOpsEvents ? '已接入事件' : '待埋点',
      active: coverage.dataOpsEvents,
    },
    {
      label: 'Token',
      value: coverage.tokenUsage ? '已从消息 usage 汇总' : '待补充 usage 事件',
      active: coverage.tokenUsage,
    },
  ];

  return (
    <div className="grid gap-2 md:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="rounded-md border border-border bg-background px-3 py-2">
          <div className="text-xs text-muted-foreground">{item.label}</div>
          <div className={item.active ? 'mt-1 text-sm font-medium text-foreground' : 'mt-1 text-sm font-medium text-amber-700 dark:text-amber-300'}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsDashboardTab() {
  const { t } = useTranslation('admin');
  const [rangeDays, setRangeDays] = useState(30);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const translate = useCallback((key: string, defaultValue: string) => (
    t(`analytics.${key}`, { defaultValue })
  ), [t]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await api.admin.analyticsSummary(rangeDays);
      if (!response.ok) {
        setError(await readError(response, translate('errors.load', '加载统计面板失败')));
        return;
      }

      const payload = await response.json() as AnalyticsSummary;
      setSummary(payload);
    } catch (caughtError) {
      console.error('[AnalyticsDashboardTab] Failed to load analytics:', caughtError);
      setError(translate('errors.load', '加载统计面板失败'));
    } finally {
      setIsLoading(false);
    }
  }, [rangeDays, translate]);

  useEffect(() => {
    void load();
  }, [load]);

  const overall = summary?.overall;
  const kpis = summary?.kpis;
  const retentionTiles = useMemo(() => {
    if (!summary) return [];
    return [
      { label: 'D1 留存', value: summary.retention.d1 },
      { label: 'D7 留存', value: summary.retention.d7 },
      { label: 'D30 留存', value: summary.retention.d30 },
    ];
  }, [summary]);

  if (!summary && isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-md border border-border bg-muted/40" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-md border border-border bg-muted/40" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">{translate('title', '统计面板')}</h3>
          <div className="text-xs text-muted-foreground">
            {summary ? `总体指标为全历史数据；时间范围指标：近 ${summary.range.days} 天 · 生成时间 ${formatDateTime(summary.range.generatedAt)}` : '聚合平台使用、问数、租户和执行链路数据'}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-background p-1">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={`h-8 rounded px-3 text-sm transition-colors ${rangeDays === option ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                onClick={() => setRangeDays(option)}
              >
                {option} 天
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={isLoading}>
            <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {translate('refresh', '刷新')}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {summary && overall && kpis ? (
        <>
          <OverallMetrics metrics={overall} />

          <Section title={`时间范围指标（近 ${summary.range.days} 天）`}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricTile
                icon={Users}
                label="登录 DAU / MAU"
                value={`${formatNumber(kpis.loginDau)} / ${formatNumber(kpis.loginMau)}`}
                detail={`总用户 ${formatNumber(kpis.totalUsers)}，活跃账号 ${formatNumber(kpis.activeUsers)}`}
              />
              <MetricTile
                icon={MessageSquare}
                label="问数 DAU / MAU"
                value={`${formatNumber(kpis.questionDau)} / ${formatNumber(kpis.questionMau)}`}
                detail={`新增问数用户 ${formatNumber(kpis.newQuestionUsers)}`}
                tone="good"
              />
              <MetricTile
                icon={BarChart3}
                label="总问数 / 会话"
                value={`${formatNumber(kpis.questionCount)} / ${formatNumber(kpis.sessionCount)}`}
                detail={`助手返回率 ${formatPercent(kpis.answerReturnRate)}`}
              />
              <MetricTile
                icon={Database}
                label="SQL 生成"
                value={formatNumber(kpis.sqlGeneratedCount)}
                detail={`启发式生成率 ${formatPercent(kpis.sqlGenerationRate)}`}
                tone="good"
              />
              <MetricTile
                icon={TrendingUp}
                label="新增登录用户"
                value={formatNumber(kpis.newLoginUsers)}
                detail={`问数流失用户 ${formatNumber(kpis.churnedQuestionUsers)}`}
              />
              <MetricTile
                icon={Activity}
                label="DataOps 执行成功率"
                value={formatPercent(kpis.dataOpsExecutionSuccessRate, '待埋点')}
                detail="提交、执行、返回结果事件接入后可计算"
                tone="warning"
              />
              <MetricTile
                icon={Gauge}
                label="Token 消耗"
                value={kpis.tokenTrackingEnabled ? formatTokenCount(kpis.totalTokens) : '待补充'}
                detail={kpis.tokenTrackingEnabled
                  ? `输入 ${formatTokenCount(kpis.inputTokens)} · 输出 ${formatTokenCount(kpis.outputTokens)}`
                  : '新的会话产生 usage 后展示'}
              />
              <MetricTile
                icon={ShieldAlert}
                label="风险与失败"
                value={`${formatNumber(kpis.failedRuntimeCount)} / ${formatNumber(kpis.highRiskSqlCount)}`}
                detail="运行时失败 / 高风险 SQL 命中"
                tone={kpis.failedRuntimeCount > 0 || kpis.highRiskSqlCount > 0 ? 'danger' : 'default'}
              />
            </div>
          </Section>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
            <Section title="问数趋势">
              <TrendChart data={summary.dailyTrend} />
            </Section>
            <Section title="问数漏斗">
              <FunnelView items={summary.funnel} />
            </Section>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Section title="活跃租户 TOP10">
              <TenantRanking tenants={summary.activeTenants} />
            </Section>
            <Section title="留存">
              <div className="grid gap-2">
                {retentionTiles.map((item) => (
                  <div key={item.label} className="rounded-md border border-border bg-background px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">{item.label}</div>
                        <div className="text-xs text-muted-foreground">
                          cohort {formatNumber(item.value.cohortSize)} · retained {formatNumber(item.value.retained)}
                        </div>
                      </div>
                      <div className="text-lg font-semibold text-foreground">{formatPercent(item.value.rate)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.55fr)]">
            <Section title="用户使用明细">
              <UserAnalyticsPanel rangeDays={rangeDays} />
            </Section>
            <Section title="失败原因">
              <FailureReasons reasons={summary.failureReasons} />
            </Section>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Section
              title="高频 Query"
              action={<Search className="h-4 w-4 text-muted-foreground" />}
            >
              <QueryTable rows={summary.highFrequencyQueries} emptyLabel="暂无高频 query 数据" />
            </Section>
            <Section
              title="高频失败 Query"
              action={<AlertTriangle className="h-4 w-4 text-amber-500" />}
            >
              <QueryTable rows={summary.highFailureQueries} emptyLabel="暂无失败 query 数据" failureMode />
            </Section>
          </div>

          <Section
            title="数据覆盖"
            action={<Clock className="h-4 w-4 text-muted-foreground" />}
          >
            <CoverageNotice coverage={summary.coverage} />
          </Section>

          <Section
            title="租户分布明细"
            action={<Building2 className="h-4 w-4 text-muted-foreground" />}
          >
            {summary.tenantDistribution.length === 0 ? (
              <EmptyState label="暂无租户分布数据" />
            ) : (
              <div className="overflow-auto rounded-md border border-border">
                <table className="w-full min-w-[680px] text-left text-sm">
                  <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">租户</th>
                      <th className="px-3 py-2 text-right font-medium">成员</th>
                      <th className="px-3 py-2 text-right font-medium">活跃成员</th>
                      <th className="px-3 py-2 text-right font-medium">问数用户</th>
                      <th className="px-3 py-2 text-right font-medium">问数</th>
                      <th className="px-3 py-2 text-right font-medium">会话</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.tenantDistribution.map((tenant) => (
                      <tr key={tenant.tenantId} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-2">
                          <div className="font-medium text-foreground">{tenant.tenantName}</div>
                          <div className="text-xs text-muted-foreground">{tenant.tenantCode}</div>
                        </td>
                        <td className="px-3 py-2 text-right text-foreground">{formatNumber(tenant.totalUsers)}</td>
                        <td className="px-3 py-2 text-right text-foreground">{formatNumber(tenant.activeUsers)}</td>
                        <td className="px-3 py-2 text-right text-foreground">{formatNumber(tenant.questionUsers)}</td>
                        <td className="px-3 py-2 text-right text-foreground">{formatNumber(tenant.questionCount)}</td>
                        <td className="px-3 py-2 text-right text-foreground">{formatNumber(tenant.sessionCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}
