import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRuntimeMonitorService,
  parseDockerMemoryUsage,
  parseDockerStatsLine,
  resolveRuntimeMonitorConfig,
} from './runtime-monitor.js';

test('resolveRuntimeMonitorConfig defaults to docker-enabled monitor settings', () => {
  const config = resolveRuntimeMonitorConfig({
    CLAUDE_EXECUTION_MODE: 'docker',
  });

  assert.deepEqual(config, {
    enabled: true,
    idleTimeoutMinutes: 4320,
    sweeperIntervalSeconds: 43200,
    staleActiveMinutes: 30,
  });
});

test('resolveRuntimeMonitorConfig applies explicit overrides', () => {
  const config = resolveRuntimeMonitorConfig({
    CLAUDE_EXECUTION_MODE: 'docker',
    CLOUDCLI_RUNTIME_SWEEPER_ENABLED: 'false',
    CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES: '5',
    CLOUDCLI_RUNTIME_SWEEPER_INTERVAL_SECONDS: '10',
    CLOUDCLI_RUNTIME_STALE_ACTIVE_MINUTES: '7',
  });

  assert.deepEqual(config, {
    enabled: false,
    idleTimeoutMinutes: 5,
    sweeperIntervalSeconds: 10,
    staleActiveMinutes: 7,
  });
});

test('resolveRuntimeMonitorConfig falls back to legacy enabled env only when canonical env is unset', () => {
  assert.equal(resolveRuntimeMonitorConfig({
    CLAUDE_EXECUTION_MODE: 'docker',
    CLOUDCLI_RUNTIME_MONITOR_ENABLED: 'false',
  }).enabled, false);
  assert.equal(resolveRuntimeMonitorConfig({
    CLAUDE_EXECUTION_MODE: 'docker',
    CLOUDCLI_RUNTIME_SWEEPER_ENABLED: 'true',
    CLOUDCLI_RUNTIME_MONITOR_ENABLED: 'false',
  }).enabled, true);
});

test('resolveRuntimeMonitorConfig rejects malformed numeric overrides', () => {
  assert.throws(
    () => resolveRuntimeMonitorConfig({ CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES: '5abc' }),
    /CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES must be a positive integer/,
  );
  assert.throws(
    () => resolveRuntimeMonitorConfig({ CLOUDCLI_RUNTIME_SWEEPER_INTERVAL_SECONDS: '0' }),
    /CLOUDCLI_RUNTIME_SWEEPER_INTERVAL_SECONDS must be a positive integer/,
  );
  assert.throws(
    () => resolveRuntimeMonitorConfig({ CLOUDCLI_RUNTIME_STALE_ACTIVE_MINUTES: 'abc' }),
    /CLOUDCLI_RUNTIME_STALE_ACTIVE_MINUTES must be a positive integer/,
  );
});

test('parseDockerStatsLine parses Docker JSON stats', () => {
  const stats = parseDockerStatsLine(JSON.stringify({
    Name: 'cloudcli-claude-runtime',
    CPUPerc: '12.34%',
    MemUsage: '21.5MiB / 2GiB',
  }));

  assert.deepEqual(stats, {
    name: 'cloudcli-claude-runtime',
    cpuPercent: 12.34,
    memoryUsageBytes: 22544384,
    memoryLimitBytes: 2147483648,
    raw: {
      Name: 'cloudcli-claude-runtime',
      CPUPerc: '12.34%',
      MemUsage: '21.5MiB / 2GiB',
    },
  });
});

test('parseDockerStatsLine accepts already-normalized stats objects', () => {
  const stats = parseDockerStatsLine({
    name: 'cloudcli-claude-runtime',
    cpuPercent: 4.5,
    memoryUsageBytes: 1024,
    memoryLimitBytes: 2048,
    raw: { Name: 'cloudcli-claude-runtime' },
  });

  assert.deepEqual(stats, {
    name: 'cloudcli-claude-runtime',
    cpuPercent: 4.5,
    memoryUsageBytes: 1024,
    memoryLimitBytes: 2048,
    raw: { Name: 'cloudcli-claude-runtime' },
  });
});

test('parseDockerMemoryUsage handles binary Docker memory units', () => {
  assert.deepEqual(parseDockerMemoryUsage('512KiB / 1MiB'), {
    usageBytes: 524288,
    limitBytes: 1048576,
  });
  assert.deepEqual(parseDockerMemoryUsage('1.5MiB / 2GiB'), {
    usageBytes: 1572864,
    limitBytes: 2147483648,
  });
  assert.deepEqual(parseDockerMemoryUsage('2GiB / 4GiB'), {
    usageBytes: 2147483648,
    limitBytes: 4294967296,
  });
});

test('createRuntimeMonitorService listRuntimes enriches rows with Docker state, stats, stop flag, and summary', async () => {
  const rows = [
    {
      runtime_id: 'runtime-active',
      tenant_id: 10,
      tenant_code: 'default',
      tenant_name: 'Default Tenant',
      user_id: 20,
      username: 'alice',
      workspace_id: 30,
      workspace_slug: 'demo',
      workspace_display_name: 'Demo Workspace',
      workspace_path: '/host/workspaces/demo',
      provider: 'claude',
      provider_session_id: 'session-active',
      status: 'active',
      container_name: 'container-active',
      image: 'cloudcli/test:claude',
      last_used_at: '2026-05-04T01:00:00.000Z',
      updated_at: '2026-05-04T01:01:00.000Z',
    },
    {
      runtime_id: 'runtime-idle',
      tenant_id: 10,
      tenant_code: 'default',
      tenant_name: 'Default Tenant',
      user_id: 21,
      username: 'bob',
      workspace_id: 31,
      workspace_slug: 'idle',
      workspace_display_name: 'Idle Workspace',
      workspace_path: '/host/workspaces/idle',
      provider: 'claude',
      provider_session_id: 'session-idle',
      status: 'idle',
      container_name: 'container-idle',
      image: 'cloudcli/test:claude',
      last_used_at: '2026-05-04T01:50:00.000Z',
      updated_at: '2026-05-04T01:51:00.000Z',
    },
    {
      runtime_id: 'runtime-missing',
      tenant_id: 11,
      tenant_code: 'missing',
      tenant_name: 'Missing Tenant',
      user_id: 22,
      username: 'carol',
      workspace_id: 32,
      workspace_slug: 'missing',
      workspace_display_name: 'Missing Workspace',
      workspace_path: '/host/workspaces/missing',
      provider: 'claude',
      provider_session_id: 'session-missing',
      status: 'failed',
      container_name: 'container-missing',
      image: 'cloudcli/test:claude',
      last_used_at: '2026-05-04T01:55:00.000Z',
      updated_at: '2026-05-04T01:56:00.000Z',
    },
  ];
  const inspected = [];
  const statsRequests = [];
  const service = createRuntimeMonitorService({
    config: {
      enabled: true,
      idleTimeoutMinutes: 30,
      sweeperIntervalSeconds: 60,
      staleActiveMinutes: 30,
    },
    now: () => new Date('2026-05-04T02:00:00.000Z'),
    multitenancy: {
      runtimes: {
        listForMonitor: (filters) => {
          assert.deepEqual(filters, { limit: 50 });
          return { rows, total: rows.length, limit: 50, offset: 0 };
        },
      },
    },
    docker: {
      inspectContainer: async (name) => {
        inspected.push(name);
        if (name === 'container-active') {
          return { exists: true, running: true, status: 'running' };
        }
        if (name === 'container-idle') {
          return { exists: true, running: true, status: 'running' };
        }
        return null;
      },
      statsContainers: async (names) => {
        statsRequests.push(names);
        return new Map([
          ['container-active', {
            Name: 'container-active',
            CPUPerc: '7.5%',
            MemUsage: '128MiB / 2GiB',
          }],
          ['container-idle', {
            name: 'container-idle',
            cpuPercent: 0,
            memoryUsageBytes: 67108864,
            memoryLimitBytes: 2147483648,
          }],
        ]);
      },
    },
  });

  const result = await service.listRuntimes({ limit: 50 });

  assert.deepEqual(inspected, ['container-active', 'container-idle', 'container-missing']);
  assert.deepEqual(statsRequests, [['container-active', 'container-idle']]);
  assert.equal(result.total, 3);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[0], {
    runtimeId: 'runtime-active',
    tenant: { id: 10, code: 'default', name: 'Default Tenant' },
    user: { id: 20, username: 'alice' },
    workspace: { id: 30, slug: 'demo', displayName: 'Demo Workspace' },
    provider: 'claude',
    providerSessionId: 'session-active',
    businessStatus: 'active',
    dockerState: 'running',
    staleActive: true,
    containerName: 'container-active',
    image: 'cloudcli/test:claude',
    lastUsedAt: '2026-05-04T01:00:00.000Z',
    updatedAt: '2026-05-04T01:01:00.000Z',
    cpuPercent: 7.5,
    memoryUsageBytes: 134217728,
    memoryLimitBytes: 2147483648,
    idleAgeSeconds: 3600,
    canStop: true,
  });
  assert.equal(result.rows[0].workspace.path, undefined);
  assert.equal(result.rows[1].dockerState, 'running');
  assert.equal(result.rows[1].canStop, true);
  assert.equal(result.rows[2].dockerState, 'missing');
  assert.equal(result.rows[2].canStop, false);
  assert.deepEqual(result.summary, {
    total: 3,
    active: 1,
    idleRunning: 1,
    failedOrUnknown: 1,
    missing: 1,
    staleActive: 1,
    totalLiveMemoryBytes: 201326592,
  });
});

test('listRuntimes keeps rows when Docker inspect fails and marks that row unknown', async () => {
  const warnings = [];
  const service = createRuntimeMonitorService({
    now: () => new Date('2026-05-04T02:00:00.000Z'),
    multitenancy: {
      runtimes: {
        listForMonitor: () => ({
          rows: [
            {
              runtime_id: 'runtime-unknown',
              tenant_id: 1,
              tenant_code: 'default',
              tenant_name: 'Default',
              user_id: 2,
              username: 'alice',
              workspace_id: 3,
              workspace_slug: 'demo',
              workspace_display_name: 'Demo',
              provider: 'claude',
              provider_session_id: 'session-1',
              status: 'active',
              container_name: 'container-unknown',
              image: 'cloudcli/test:claude',
              last_used_at: '2026-05-04T01:58:00.000Z',
              updated_at: '2026-05-04T01:59:00.000Z',
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      },
    },
    docker: {
      inspectContainer: async () => {
        throw new Error('docker inspect failed');
      },
      statsContainers: async () => {
        throw new Error('stats should not run for unknown containers');
      },
    },
    logger: {
      warn: (...args) => warnings.push(args),
    },
  });

  const result = await service.listRuntimes();

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].dockerState, 'unknown');
  assert.equal(result.rows[0].canStop, false);
  assert.equal(result.summary.failedOrUnknown, 1);
  assert.equal(warnings.length, 1);
});

test('listRuntimes renders rows when Docker stats fails', async () => {
  const warnings = [];
  const service = createRuntimeMonitorService({
    now: () => new Date('2026-05-04T02:00:00.000Z'),
    multitenancy: {
      runtimes: {
        listForMonitor: () => ({
          rows: [
            {
              runtime_id: 'runtime-running',
              tenant_id: 1,
              tenant_code: 'default',
              tenant_name: 'Default',
              user_id: 2,
              username: 'alice',
              workspace_id: 3,
              workspace_slug: 'demo',
              workspace_display_name: 'Demo',
              provider: 'claude',
              provider_session_id: 'session-1',
              status: 'idle',
              container_name: 'container-running',
              image: 'cloudcli/test:claude',
              last_used_at: '2026-05-04T01:58:00.000Z',
              updated_at: '2026-05-04T01:59:00.000Z',
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      },
    },
    docker: {
      inspectContainer: async () => ({ exists: true, running: true, status: 'running' }),
      statsContainers: async () => {
        throw new Error('docker stats failed');
      },
    },
    logger: {
      warn: (...args) => warnings.push(args),
    },
  });

  const result = await service.listRuntimes();

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].dockerState, 'running');
  assert.equal(result.rows[0].cpuPercent, null);
  assert.equal(result.rows[0].memoryUsageBytes, null);
  assert.equal(result.summary.idleRunning, 1);
  assert.equal(warnings.length, 1);
});

test('listRuntimes preserves database total when no dockerState filter is applied', async () => {
  const service = createRuntimeMonitorService({
    now: () => new Date('2026-05-04T02:00:00.000Z'),
    multitenancy: {
      runtimes: {
        listForMonitor: () => ({
          rows: [
            {
              runtime_id: 'runtime-page-one',
              tenant_id: 1,
              tenant_code: 'default',
              tenant_name: 'Default',
              user_id: 2,
              username: 'alice',
              workspace_id: 3,
              workspace_slug: 'demo',
              workspace_display_name: 'Demo',
              provider: 'claude',
              provider_session_id: 'session-1',
              status: 'idle',
              container_name: 'container-page-one',
              image: 'cloudcli/test:claude',
              last_used_at: '2026-05-04T01:58:00.000Z',
              updated_at: '2026-05-04T01:59:00.000Z',
            },
          ],
          total: 2,
          limit: 1,
          offset: 0,
        }),
      },
    },
    docker: {
      inspectContainer: async () => ({ exists: true, running: false, status: 'exited' }),
      statsContainers: async () => new Map(),
    },
  });

  const result = await service.listRuntimes({ limit: 1 });

  assert.equal(result.total, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.limit, 1);
  assert.equal(result.offset, 0);
});

test('listRuntimes treats SQLite timestamps without timezone as UTC', async () => {
  const service = createRuntimeMonitorService({
    now: () => new Date('2026-05-04T02:00:00.000Z'),
    multitenancy: {
      runtimes: {
        listForMonitor: () => ({
          rows: [
            {
              runtime_id: 'runtime-sqlite-time',
              tenant_id: 1,
              tenant_code: 'default',
              tenant_name: 'Default',
              user_id: 2,
              username: 'alice',
              workspace_id: 3,
              workspace_slug: 'demo',
              workspace_display_name: 'Demo',
              provider: 'claude',
              provider_session_id: 'session-1',
              status: 'idle',
              container_name: 'container-exited',
              image: 'cloudcli/test:claude',
              last_used_at: '2026-05-04 01:58:00',
              updated_at: '2026-05-04 01:59:00',
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      },
    },
    docker: {
      inspectContainer: async () => ({ exists: true, running: false, status: 'exited' }),
      statsContainers: async () => new Map(),
    },
  });

  const result = await service.listRuntimes();

  assert.equal(result.rows[0].idleAgeSeconds, 120);
  assert.equal(result.rows[0].lastUsedAt, '2026-05-04T01:58:00.000Z');
  assert.equal(result.rows[0].updatedAt, '2026-05-04T01:59:00.000Z');
});

test('stopRuntime logs, delegates to runtime manager, and returns refreshed runtime row', async () => {
  const calls = [];
  const logs = [];
  const monitorRows = new Map([
    ['runtime-1', {
      runtime_id: 'runtime-1',
      tenant_id: 1,
      tenant_code: 'default',
      tenant_name: 'Default',
      user_id: 2,
      username: 'alice',
      workspace_id: 3,
      workspace_slug: 'demo',
      workspace_display_name: 'Demo',
      provider: 'claude',
      provider_session_id: 'session-1',
      status: 'active',
      container_name: 'container-running',
      image: 'cloudcli/test:claude',
      last_used_at: '2026-05-04T01:58:00.000Z',
      updated_at: '2026-05-04T01:59:00.000Z',
    }],
  ]);
  const service = createRuntimeMonitorService({
    now: () => new Date('2026-05-04T02:00:00.000Z'),
    multitenancy: {
      runtimes: {
        getMonitorRowByRuntimeId: (runtimeId) => monitorRows.get(runtimeId) ?? null,
      },
    },
    docker: {
      inspectContainer: async () => ({ exists: true, running: false, status: 'exited' }),
      statsContainers: async () => new Map(),
    },
    runtimeManager: {
      stopRuntime: async (runtimeId) => {
        calls.push(runtimeId);
        monitorRows.set(runtimeId, {
          ...monitorRows.get(runtimeId),
          status: 'idle',
          updated_at: '2026-05-04T02:00:00.000Z',
        });
        return true;
      },
    },
    logger: {
      info: (...args) => logs.push(args),
    },
  });

  const row = await service.stopRuntime({ runtimeId: 'runtime-1', adminUserId: 99 });

  assert.deepEqual(calls, ['runtime-1']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].adminUserId, 99);
  assert.equal(row.runtimeId, 'runtime-1');
  assert.equal(row.businessStatus, 'idle');
  assert.equal(row.dockerState, 'exited');
});

test('reports filtered total and unfiltered page total when dockerState filter is applied', async () => {
  const service = createRuntimeMonitorService({
    now: () => new Date('2026-05-04T02:00:00.000Z'),
    multitenancy: {
      runtimes: {
        listForMonitor: () => ({
          rows: [
            {
              runtime_id: 'runtime-running',
              tenant_id: 1,
              tenant_code: 'default',
              tenant_name: 'Default',
              user_id: 2,
              username: 'alice',
              workspace_id: 3,
              workspace_slug: 'running',
              workspace_display_name: 'Running',
              provider: 'claude',
              status: 'idle',
              container_name: 'container-running',
              image: 'cloudcli/test:claude',
              last_used_at: '2026-05-04T01:58:00.000Z',
              updated_at: '2026-05-04T01:59:00.000Z',
            },
            {
              runtime_id: 'runtime-missing',
              tenant_id: 1,
              tenant_code: 'default',
              tenant_name: 'Default',
              user_id: 2,
              username: 'alice',
              workspace_id: 4,
              workspace_slug: 'missing',
              workspace_display_name: 'Missing',
              provider: 'claude',
              status: 'idle',
              container_name: 'container-missing',
              image: 'cloudcli/test:claude',
              last_used_at: '2026-05-04T01:58:00.000Z',
              updated_at: '2026-05-04T01:59:00.000Z',
            },
          ],
          total: 2,
          limit: 20,
          offset: 0,
        }),
      },
    },
    docker: {
      inspectContainer: async (name) => (name === 'container-running'
        ? { exists: true, running: true, status: 'running' }
        : null),
      statsContainers: async () => new Map(),
    },
  });

  const result = await service.listRuntimes({ dockerState: 'missing' });

  assert.equal(result.total, 1);
  assert.equal(result.unfilteredTotal, 2);
  assert.deepEqual(result.rows.map((row) => row.runtimeId), ['runtime-missing']);
});

test('listRuntimes filters docker state before paginating the full monitor set', async () => {
  const inspected = [];
  const rows = [
    {
      runtime_id: 'runtime-running',
      tenant_id: 1,
      tenant_code: 'default',
      tenant_name: 'Default',
      user_id: 2,
      username: 'alice',
      workspace_id: 3,
      workspace_slug: 'running',
      workspace_display_name: 'Running',
      provider: 'claude',
      status: 'idle',
      container_name: 'container-running',
      image: 'cloudcli/test:claude',
      last_used_at: '2026-05-04T01:58:00.000Z',
      updated_at: '2026-05-04T01:59:00.000Z',
    },
    {
      runtime_id: 'runtime-missing-1',
      tenant_id: 1,
      tenant_code: 'default',
      tenant_name: 'Default',
      user_id: 2,
      username: 'alice',
      workspace_id: 4,
      workspace_slug: 'missing-1',
      workspace_display_name: 'Missing 1',
      provider: 'claude',
      status: 'idle',
      container_name: 'container-missing-1',
      image: 'cloudcli/test:claude',
      last_used_at: '2026-05-04T01:57:00.000Z',
      updated_at: '2026-05-04T01:58:00.000Z',
    },
    {
      runtime_id: 'runtime-missing-2',
      tenant_id: 1,
      tenant_code: 'default',
      tenant_name: 'Default',
      user_id: 2,
      username: 'alice',
      workspace_id: 5,
      workspace_slug: 'missing-2',
      workspace_display_name: 'Missing 2',
      provider: 'claude',
      status: 'idle',
      container_name: 'container-missing-2',
      image: 'cloudcli/test:claude',
      last_used_at: '2026-05-04T01:56:00.000Z',
      updated_at: '2026-05-04T01:57:00.000Z',
    },
  ];
  const service = createRuntimeMonitorService({
    now: () => new Date('2026-05-04T02:00:00.000Z'),
    multitenancy: {
      runtimes: {
        listAllForMonitor: (filters) => {
          assert.deepEqual(filters, { dockerState: 'missing', limit: 1, offset: 1 });
          return { rows, total: rows.length };
        },
      },
    },
    docker: {
      inspectContainer: async (name) => {
        inspected.push(name);
        return name === 'container-running'
          ? { exists: true, running: true, status: 'running' }
          : null;
      },
      statsContainers: async () => new Map(),
    },
  });

  const result = await service.listRuntimes({ dockerState: 'missing', limit: 1, offset: 1 });

  assert.deepEqual(inspected, ['container-running', 'container-missing-1', 'container-missing-2']);
  assert.equal(result.total, 2);
  assert.equal(result.unfilteredTotal, 3);
  assert.equal(result.limit, 1);
  assert.equal(result.offset, 1);
  assert.deepEqual(result.rows.map((row) => row.runtimeId), ['runtime-missing-2']);
  assert.equal(result.summary.missing, 2);
});
