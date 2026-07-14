import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import type { McpProvider } from '../types';

export type McpToolUsageCall = {
  id: number;
  tenantId: number;
  workspaceId: number;
  userId: number;
  runtimeId: string;
  sessionId: string | null;
  messageId: string;
  provider: McpProvider;
  serverName: string;
  toolName: string;
  status: string;
  calledAt: string;
};

export type McpToolUsageSummary = {
  range: {
    days: number;
    provider: McpProvider | null;
    generatedAt: string;
  };
  totals: {
    callCount: number;
    successCount: number;
    errorCount: number;
    serverCount: number;
    toolCount: number;
  };
  byServer: Array<{
    serverName: string;
    callCount: number;
    errorCount: number;
    toolCount: number;
    lastCalledAt: string;
  }>;
  byTool: Array<{
    serverName: string;
    toolName: string;
    callCount: number;
    errorCount: number;
    lastCalledAt: string;
  }>;
  recentCalls: McpToolUsageCall[];
};

type UseMcpToolUsageOptions = {
  provider: McpProvider;
  rangeDays: number;
  refreshIntervalMs?: number;
};

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // Ignore JSON parsing errors and use the route-specific fallback below.
  }

  return fallback;
};

export function useMcpToolUsage({
  provider,
  rangeDays,
  refreshIntervalMs = 15_000,
}: UseMcpToolUsageOptions) {
  const [summary, setSummary] = useState<McpToolUsageSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(async ({ quiet = false } = {}) => {
    if (quiet) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      const response = await api.admin.mcpToolUsage({ rangeDays, provider });
      if (response.status === 403) {
        setSummary(null);
        setError('System admin access required');
        return;
      }
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, 'Failed to load MCP tool usage'));
      }

      const payload = await response.json() as McpToolUsageSummary;
      setSummary(payload);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to load MCP tool usage';
      setError(message);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [provider, rangeDays]);

  useEffect(() => {
    let cancelled = false;

    const load = async (quiet = false) => {
      if (cancelled) return;
      await loadUsage({ quiet });
    };

    load(false);
    const interval = window.setInterval(() => {
      void load(true);
    }, refreshIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadUsage, refreshIntervalMs]);

  return {
    summary,
    isLoading,
    isRefreshing,
    error,
    refresh: () => loadUsage({ quiet: true }),
  };
}
