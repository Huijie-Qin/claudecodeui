import { Activity, AlertTriangle, Clock, RefreshCw, Server, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge, Button } from '../../../shared/view/ui';
import type { McpProvider } from '../types';
import { useMcpToolUsage } from '../hooks/useMcpToolUsage';

type McpToolUsagePanelProps = {
  selectedProvider: McpProvider;
};

const RANGE_OPTIONS = [7, 30, 90];

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatDateTime(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function MetricTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background/60 px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{formatNumber(value)}</div>
    </div>
  );
}

export default function McpToolUsagePanel({ selectedProvider }: McpToolUsagePanelProps) {
  const [rangeDays, setRangeDays] = useState(7);
  const {
    summary,
    isLoading,
    isRefreshing,
    error,
    refresh,
  } = useMcpToolUsage({ provider: selectedProvider, rangeDays });
  const topServers = useMemo(() => summary?.byServer.slice(0, 5) || [], [summary]);
  const topTools = useMemo(() => summary?.byTool.slice(0, 8) || [], [summary]);
  const recentCalls = useMemo(() => summary?.recentCalls.slice(0, 8) || [], [summary]);

  return (
    <section className="rounded-lg border border-border bg-card/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="h-4 w-4 text-purple-500" />
          <h4 className="truncate text-sm font-medium text-foreground">MCP Tool Usage</h4>
          {summary?.range.generatedAt && (
            <Badge variant="outline" className="text-xs">
              <Clock className="mr-1 h-3 w-3" />
              {formatDateTime(summary.range.generatedAt)}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            {RANGE_OPTIONS.map((days) => (
              <Button
                key={days}
                type="button"
                variant={rangeDays === days ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setRangeDays(days)}
              >
                {days}d
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            title="Refresh MCP tool usage"
            onClick={refresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!error && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricTile label="Calls" value={summary?.totals.callCount || 0} />
            <MetricTile label="Success" value={summary?.totals.successCount || 0} />
            <MetricTile label="Errors" value={summary?.totals.errorCount || 0} />
            <MetricTile label="Servers" value={summary?.totals.serverCount || 0} />
            <MetricTile label="Tools" value={summary?.totals.toolCount || 0} />
          </div>

          {isLoading && !summary && (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading MCP tool usage...</div>
          )}

          {!isLoading && summary && summary.totals.callCount === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">No MCP tool calls in this range.</div>
          )}

          {summary && summary.totals.callCount > 0 && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Server className="h-3.5 w-3.5" />
                  Servers
                </div>
                <div className="space-y-2">
                  {topServers.map((server) => (
                    <div key={server.serverName} className="rounded-md border border-border bg-background/50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium text-foreground">{server.serverName}</span>
                        <span className="text-sm text-muted-foreground">{formatNumber(server.callCount)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{server.toolCount} tools</span>
                        {server.errorCount > 0 && <span>{server.errorCount} errors</span>}
                        <span>{formatDateTime(server.lastCalledAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Wrench className="h-3.5 w-3.5" />
                    Top Tools
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {topTools.map((tool) => (
                      <div key={`${tool.serverName}:${tool.toolName}`} className="min-w-0 rounded-md border border-border bg-background/50 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-medium text-foreground">{tool.toolName}</span>
                          <span className="text-sm text-muted-foreground">{formatNumber(tool.callCount)}</span>
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{tool.serverName}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent Calls</div>
                  <div className="space-y-1">
                    {recentCalls.map((call) => (
                      <div key={call.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                        <div className="min-w-0">
                          <div className="truncate text-foreground">{call.toolName}</div>
                          <div className="truncate text-xs text-muted-foreground">{call.serverName} - {call.runtimeId}</div>
                        </div>
                        <div className="text-right">
                          <Badge variant={call.status === 'error' ? 'destructive' : 'outline'} className="text-xs">
                            {call.status}
                          </Badge>
                          <div className="mt-1 text-xs text-muted-foreground">{formatDateTime(call.calledAt)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
