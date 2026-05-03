import { multitenancyDb } from '../database/multitenancy-db.js';
import {
  agentSessionRuntimeManager,
  DockerCliClient,
} from './agent-session-runtime.js';

const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const DEFAULT_SWEEPER_INTERVAL_SECONDS = 60;
const DEFAULT_STALE_ACTIVE_MINUTES = 30;

function parseBoolean(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function ageSeconds(value, now) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
}

function parseCpuPercent(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return null;
  const parsed = Number.parseFloat(String(value).replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMemoryValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (value == null) return null;
  const match = String(value).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B?)$/i);
  if (!match) return null;

  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers = {
    B: 1,
    K: 1000,
    KB: 1000,
    M: 1000 ** 2,
    MB: 1000 ** 2,
    G: 1000 ** 3,
    GB: 1000 ** 3,
    T: 1000 ** 4,
    TB: 1000 ** 4,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
  };
  return Math.round(amount * (multipliers[unit || 'B'] ?? 1));
}

function dockerStateFromInspect(inspected) {
  if (!inspected) return 'missing';
  if (inspected.running) return 'running';
  return inspected.status || inspected.state?.Status || 'exited';
}

function buildSummary(rows) {
  return rows.reduce((summary, row) => {
    summary.total += 1;
    if (row.businessStatus === 'active') summary.active += 1;
    if (row.businessStatus === 'idle' && row.dockerState === 'running') {
      summary.idleRunning += 1;
    }
    if (row.businessStatus === 'failed' || row.dockerState === 'unknown') {
      summary.failedOrUnknown += 1;
    }
    if (row.dockerState === 'missing') summary.missing += 1;
    if (row.staleActive) summary.staleActive += 1;
    if (row.dockerState === 'running' && row.memoryUsageBytes != null) {
      summary.totalLiveMemoryBytes += row.memoryUsageBytes;
    }
    return summary;
  }, {
    total: 0,
    active: 0,
    idleRunning: 0,
    failedOrUnknown: 0,
    missing: 0,
    staleActive: 0,
    totalLiveMemoryBytes: 0,
  });
}

export function resolveRuntimeMonitorConfig(env = process.env) {
  const dockerMode = String(env.CLAUDE_EXECUTION_MODE || 'local').trim().toLowerCase() === 'docker';
  return {
    enabled: parseBoolean(env.CLOUDCLI_RUNTIME_MONITOR_ENABLED, dockerMode),
    idleTimeoutMinutes: parsePositiveInteger(
      env.CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES,
      DEFAULT_IDLE_TIMEOUT_MINUTES,
    ),
    sweeperIntervalSeconds: parsePositiveInteger(
      env.CLOUDCLI_RUNTIME_SWEEPER_INTERVAL_SECONDS,
      DEFAULT_SWEEPER_INTERVAL_SECONDS,
    ),
    staleActiveMinutes: parsePositiveInteger(
      env.CLOUDCLI_RUNTIME_STALE_ACTIVE_MINUTES,
      DEFAULT_STALE_ACTIVE_MINUTES,
    ),
  };
}

export function parseDockerMemoryUsage(memUsage) {
  if (memUsage == null) {
    return { usageBytes: null, limitBytes: null };
  }
  const [usage, limit] = String(memUsage).split('/').map((part) => part.trim());
  return {
    usageBytes: parseMemoryValue(usage),
    limitBytes: parseMemoryValue(limit),
  };
}

export function parseDockerStatsLine(lineOrObject) {
  if (!lineOrObject) return null;
  const row = typeof lineOrObject === 'string'
    ? JSON.parse(lineOrObject)
    : lineOrObject;

  if (
    row.name != null
    || row.cpuPercent != null
    || row.memoryUsageBytes != null
    || row.memoryLimitBytes != null
  ) {
    return {
      name: row.name ?? row.Name ?? null,
      cpuPercent: row.cpuPercent ?? parseCpuPercent(row.CPUPerc),
      memoryUsageBytes: row.memoryUsageBytes ?? parseDockerMemoryUsage(row.MemUsage).usageBytes,
      memoryLimitBytes: row.memoryLimitBytes ?? parseDockerMemoryUsage(row.MemUsage).limitBytes,
      raw: row.raw ?? row,
    };
  }

  const memory = parseDockerMemoryUsage(row.MemUsage);
  return {
    name: row.Name ?? null,
    cpuPercent: parseCpuPercent(row.CPUPerc),
    memoryUsageBytes: memory.usageBytes,
    memoryLimitBytes: memory.limitBytes,
    raw: row,
  };
}

export function createRuntimeMonitorService({
  multitenancy = multitenancyDb,
  docker = new DockerCliClient(),
  runtimeManager = agentSessionRuntimeManager,
  config = resolveRuntimeMonitorConfig(),
  now = () => new Date(),
  logger = console,
} = {}) {
  async function enrichRows(rows) {
    const currentTime = now();
    const inspectedByContainer = new Map();
    const runningContainers = [];

    await Promise.all(rows.map(async (row) => {
      try {
        const inspected = await docker.inspectContainer(row.container_name);
        inspectedByContainer.set(row.container_name, {
          inspected,
          dockerState: dockerStateFromInspect(inspected),
        });
        if (inspected?.running) {
          runningContainers.push(row.container_name);
        }
      } catch (error) {
        logger?.warn?.('runtime monitor inspect failed', {
          runtimeId: row.runtime_id,
          containerName: row.container_name,
          error: error?.message,
        });
        inspectedByContainer.set(row.container_name, {
          inspected: null,
          dockerState: 'unknown',
        });
      }
    }));

    let statsByContainer = new Map();
    if (runningContainers.length > 0) {
      try {
        statsByContainer = await docker.statsContainers(runningContainers);
      } catch (error) {
        logger?.warn?.('runtime monitor stats failed', { error: error?.message });
      }
    }

    return rows.map((row) => {
      const dockerStatus = inspectedByContainer.get(row.container_name) ?? { dockerState: 'unknown' };
      const stats = parseDockerStatsLine(statsByContainer.get(row.container_name));
      const idleAge = ageSeconds(row.last_used_at, currentTime);
      const staleActive = row.status === 'active'
        && idleAge != null
        && idleAge >= config.staleActiveMinutes * 60;

      return {
        runtimeId: row.runtime_id,
        tenant: {
          id: row.tenant_id,
          code: row.tenant_code,
          name: row.tenant_name,
        },
        user: {
          id: row.user_id,
          username: row.username,
        },
        workspace: {
          id: row.workspace_id,
          slug: row.workspace_slug,
          displayName: row.workspace_display_name,
        },
        provider: row.provider,
        providerSessionId: row.provider_session_id ?? null,
        businessStatus: row.status,
        dockerState: dockerStatus.dockerState,
        staleActive,
        containerName: row.container_name,
        image: row.image,
        lastUsedAt: normalizeDate(row.last_used_at),
        updatedAt: normalizeDate(row.updated_at),
        cpuPercent: stats?.cpuPercent ?? null,
        memoryUsageBytes: stats?.memoryUsageBytes ?? null,
        memoryLimitBytes: stats?.memoryLimitBytes ?? null,
        idleAgeSeconds: idleAge,
        canStop: dockerStatus.dockerState === 'running',
      };
    });
  }

  async function enrichResult(rows, metadata = {}, filters = {}) {
    let enrichedRows = await enrichRows(rows);
    if (filters.dockerState) {
      enrichedRows = enrichedRows.filter((row) => row.dockerState === filters.dockerState);
    }
    return {
      rows: enrichedRows,
      total: enrichedRows.length,
      limit: metadata.limit ?? enrichedRows.length,
      offset: metadata.offset ?? 0,
      summary: buildSummary(enrichedRows),
    };
  }

  async function listRuntimes(filters = {}) {
    const result = multitenancy.runtimes.listForMonitor(filters);
    const rows = Array.isArray(result) ? result : result.rows;
    return enrichResult(rows ?? [], result, filters);
  }

  async function getRuntime(runtimeId) {
    const row = multitenancy.runtimes.getMonitorRowByRuntimeId(runtimeId);
    if (!row) return null;
    const result = await enrichResult([row]);
    return result.rows[0] ?? null;
  }

  async function getSummary(filters = {}) {
    const result = await listRuntimes(filters);
    return result.summary;
  }

  async function stopRuntime({ runtimeId, adminUserId } = {}) {
    const row = multitenancy.runtimes.getMonitorRowByRuntimeId(runtimeId);
    if (!row) return null;
    await runtimeManager.stopRuntime(runtimeId);
    logger?.info?.('runtime monitor stopRuntime', {
      runtimeId,
      adminUserId,
      tenantId: row.tenant_id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
    });
    return getRuntime(runtimeId);
  }

  return {
    listRuntimes,
    getRuntime,
    getSummary,
    stopRuntime,
  };
}

export const runtimeMonitorService = createRuntimeMonitorService();
