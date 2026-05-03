# Admin Runtime Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Admin Runtime Monitor for Docker-backed Claude sessions, with global observability, safe Stop control, and idle-only automatic cleanup.

**Architecture:** Use `agent_session_runtime` as the business state source and Docker CLI inspection/stats as auxiliary process state. Add focused backend services for monitor enrichment and sweeping, expose system-admin-only API endpoints, and add a `Runtime Monitor` tab inside the existing Admin dialog.

**Tech Stack:** Node.js ESM, Express, better-sqlite3, Docker CLI via `execFile`, React 18, existing shared UI primitives, Node test runner, `tsx` frontend unit tests.

---

## Current Branch And Safety Notes

- Work in `/Users/huijieqin/project/claude-code-ui`.
- Preserve unrelated local files. At plan creation time the worktree had unrelated changes including `package.json`, `.superpowers/`, scratch presentation artifacts, and generated workspace folders.
- Each task commit should stage only the files listed in that task.
- Do not change Docker isolation semantics from `docs/superpowers/specs/2026-04-26-claude-docker-session-runtime-design.md`.
- Do not expose `workspace_host_path` or `runtime_home_path` in the default Admin table.

## File Structure

- Modify `server/database/multitenancy-db.js`: add monitor query helpers under `runtimes`.
- Modify `server/database/multitenancy-db.test.js`: test joined runtime rows and expired-idle runtime selection.
- Modify `server/services/agent-session-runtime.js`: extend `DockerCliClient` with richer inspect/stats methods and make `stopRuntime()` idempotent for missing/exited containers.
- Modify `server/services/agent-session-runtime.test.js`: cover idempotent Stop behavior for running, exited, and missing containers.
- Create `server/services/runtime-monitor.js`: parse monitor env, enrich DB rows with Docker state/stats, compute summaries, expose a safe stop wrapper.
- Create `server/services/runtime-monitor.test.js`: unit-test env parsing, stats parsing, Docker state mapping, summaries, and sweep candidate behavior.
- Create `server/services/runtime-sweeper.js`: periodic backend sweeper that stops only expired idle running containers.
- Create `server/services/runtime-sweeper.test.js`: unit-test interval lifecycle and idle-only stop behavior.
- Modify `server/routes/admin.js`: add `GET /runtimes`, `GET /runtimes/summary`, `POST /runtimes/:runtimeId/stop`.
- Create `server/routes/admin-runtime-monitor.test.js`: test admin auth, list, summary, stop, invalid filters, and Docker unavailable response.
- Modify `server/index.js`: start the sweeper after database initialization and stop it during shutdown.
- Modify `src/utils/api.js`: add Admin runtime monitor client methods.
- Create `src/components/admin/runtimeMonitorUtils.ts`: formatting and query-building helpers for the Runtime Monitor tab.
- Create `src/components/admin/runtimeMonitorUtils.test.ts`: test helpers without introducing a React test dependency.
- Create `src/components/admin/RuntimeMonitorTab.tsx`: compact operational UI for summaries, filters, runtime rows, and Stop actions.
- Modify `src/components/admin/AdminPanel.tsx`: add `Tenants & Users` / `Runtime Monitor` tabs and mount the new tab.

---

### Task 1: Add Database Queries For Runtime Monitoring

**Files:**
- Modify: `server/database/multitenancy-db.js`
- Modify: `server/database/multitenancy-db.test.js`

- [ ] **Step 1: Write failing DB monitor tests**

Append these tests to `server/database/multitenancy-db.test.js`:

```js
test('runtime monitor lists runtimes with tenant user and workspace context', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'default', name: 'Default' });
  const user = { id: 1 };
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'admin', 'hash')").run();
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: user.id,
    slug: 'demo',
    displayName: 'Demo Workspace',
    path: '/tmp/demo',
  });
  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: user.id,
    provider: 'claude',
    providerSessionId: 'session-1',
    containerName: 'cloudcli-claude-demo',
    image: 'cloudcli/test:claude',
    workspaceHostPath: '/tmp/demo',
    runtimeHomePath: '/tmp/runtime/home',
    status: 'idle',
  });

  const result = mt.runtimes.listForMonitor({ limit: 20, offset: 0 });

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].runtime_id, 'runtime-1');
  assert.equal(result.rows[0].tenant_code, 'default');
  assert.equal(result.rows[0].username, 'admin');
  assert.equal(result.rows[0].workspace_display_name, 'Demo Workspace');
});

test('runtime monitor filters by status and query text', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'acme', name: 'Acme' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', 'hash')").run();
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'alpha',
    displayName: 'Alpha',
    path: '/tmp/alpha',
  });
  mt.runtimes.createRuntime({
    runtimeId: 'runtime-active',
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: 1,
    provider: 'claude',
    providerSessionId: 'session-alpha',
    containerName: 'container-alpha',
    image: 'cloudcli/test:claude',
    workspaceHostPath: '/tmp/alpha',
    runtimeHomePath: '/tmp/runtime/alpha',
    status: 'active',
  });

  const active = mt.runtimes.listForMonitor({ status: 'active', q: 'alpha' });
  const idle = mt.runtimes.listForMonitor({ status: 'idle', q: 'alpha' });

  assert.equal(active.total, 1);
  assert.equal(active.rows[0].runtime_id, 'runtime-active');
  assert.equal(idle.total, 0);
});

test('runtime monitor selects expired idle runtimes only', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash')").run();
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'work',
    displayName: 'Work',
    path: '/tmp/work',
  });
  for (const [runtimeId, status] of [['old-idle', 'idle'], ['old-active', 'active']]) {
    mt.runtimes.createRuntime({
      runtimeId,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      userId: 1,
      provider: 'claude',
      providerSessionId: `${runtimeId}-session`,
      containerName: `${runtimeId}-container`,
      image: 'cloudcli/test:claude',
      workspaceHostPath: '/tmp/work',
      runtimeHomePath: `/tmp/runtime/${runtimeId}`,
      status,
    });
    database.prepare(`
      UPDATE agent_session_runtime
      SET last_used_at = datetime('now', '-45 minutes')
      WHERE runtime_id = ?
    `).run(runtimeId);
  }

  const expired = mt.runtimes.listExpiredIdleRuntimes({ olderThanMinutes: 30, limit: 10 });

  assert.deepEqual(expired.map((row) => row.runtime_id), ['old-idle']);
});
```

- [ ] **Step 2: Run DB tests and confirm failure**

Run:

```bash
node --test server/database/multitenancy-db.test.js
```

Expected: fail with `mt.runtimes.listForMonitor is not a function`.

- [ ] **Step 3: Implement DB monitor helpers**

Inside `server/database/multitenancy-db.js`, add these helpers near the existing normalization functions:

```js
function normalizePositiveLimit(value, fallback = 50, max = 200) {
  const limit = value == null ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }
  return Math.min(limit, max);
}

function normalizeOptionalPositiveInteger(value, name) {
  if (value == null || value === '') return null;
  return requirePositiveInteger(Number(value), name);
}

function normalizeRuntimeMonitorFilters(filters = {}) {
  return {
    tenantId: normalizeOptionalPositiveInteger(filters.tenantId, 'tenantId'),
    userId: normalizeOptionalPositiveInteger(filters.userId, 'userId'),
    workspaceId: normalizeOptionalPositiveInteger(filters.workspaceId, 'workspaceId'),
    provider: filters.provider ? requireEnum(filters.provider, PROVIDERS, 'provider') : null,
    status: filters.status ? requireEnum(filters.status, RUNTIME_STATUSES, 'status') : null,
    q: typeof filters.q === 'string' && filters.q.trim() ? `%${filters.q.trim().toLowerCase()}%` : null,
    limit: normalizePositiveLimit(filters.limit, 50, 200),
    offset: normalizeOffset(filters.offset),
  };
}
```

Under `runtimes`, add:

```js
listForMonitor: (filters = {}) => {
  const normalized = normalizeRuntimeMonitorFilters(filters);
  const where = ["r.status != 'deleted'"];
  const params = [];

  if (normalized.tenantId) {
    where.push('r.tenant_id = ?');
    params.push(normalized.tenantId);
  }
  if (normalized.userId) {
    where.push('r.user_id = ?');
    params.push(normalized.userId);
  }
  if (normalized.workspaceId) {
    where.push('r.workspace_id = ?');
    params.push(normalized.workspaceId);
  }
  if (normalized.provider) {
    where.push('r.provider = ?');
    params.push(normalized.provider);
  }
  if (normalized.status) {
    where.push('r.status = ?');
    params.push(normalized.status);
  }
  if (normalized.q) {
    where.push(`(
      lower(r.runtime_id) LIKE ?
      OR lower(COALESCE(r.provider_session_id, '')) LIKE ?
      OR lower(r.container_name) LIKE ?
      OR lower(t.code) LIKE ?
      OR lower(t.name) LIKE ?
      OR lower(u.username) LIKE ?
      OR lower(w.display_name) LIKE ?
    )`);
    params.push(normalized.q, normalized.q, normalized.q, normalized.q, normalized.q, normalized.q, normalized.q);
  }

  const whereSql = where.join(' AND ');
  const total = database.prepare(`
    SELECT COUNT(*) AS total
    FROM agent_session_runtime r
    JOIN tenants t ON t.id = r.tenant_id
    JOIN users u ON u.id = r.user_id
    JOIN workspaces w ON w.id = r.workspace_id
    WHERE ${whereSql}
  `).get(...params).total;

  const rows = database.prepare(`
    SELECT
      r.*,
      t.code AS tenant_code,
      t.name AS tenant_name,
      u.username AS username,
      w.display_name AS workspace_display_name,
      w.slug AS workspace_slug
    FROM agent_session_runtime r
    JOIN tenants t ON t.id = r.tenant_id
    JOIN users u ON u.id = r.user_id
    JOIN workspaces w ON w.id = r.workspace_id
    WHERE ${whereSql}
    ORDER BY r.updated_at DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, normalized.limit, normalized.offset);

  return { total, rows };
},

getMonitorRowByRuntimeId: (runtimeId) => {
  return database.prepare(`
    SELECT
      r.*,
      t.code AS tenant_code,
      t.name AS tenant_name,
      u.username AS username,
      w.display_name AS workspace_display_name,
      w.slug AS workspace_slug
    FROM agent_session_runtime r
    JOIN tenants t ON t.id = r.tenant_id
    JOIN users u ON u.id = r.user_id
    JOIN workspaces w ON w.id = r.workspace_id
    WHERE r.runtime_id = ?
      AND r.status != 'deleted'
  `).get(requireNonEmptyString(runtimeId, 'runtimeId')) ?? null;
},

listExpiredIdleRuntimes: ({ olderThanMinutes, limit = 100 } = {}) => {
  const minutes = Number(olderThanMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('olderThanMinutes must be a positive number');
  }
  const normalizedLimit = normalizePositiveLimit(limit, 100, 500);
  return database.prepare(`
    SELECT *
    FROM agent_session_runtime
    WHERE status = 'idle'
      AND datetime(last_used_at) <= datetime('now', ?)
    ORDER BY last_used_at ASC
    LIMIT ?
  `).all(`-${minutes} minutes`, normalizedLimit);
},
```

- [ ] **Step 4: Run DB tests and confirm pass**

Run:

```bash
node --test server/database/multitenancy-db.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit DB query work**

```bash
git add server/database/multitenancy-db.js server/database/multitenancy-db.test.js
git commit -m "feat: add runtime monitor database queries"
```

---

### Task 2: Add Docker Runtime Monitor Service

**Files:**
- Modify: `server/services/agent-session-runtime.js`
- Modify: `server/services/agent-session-runtime.test.js`
- Create: `server/services/runtime-monitor.js`
- Create: `server/services/runtime-monitor.test.js`

- [ ] **Step 1: Write failing Docker client and monitor service tests**

Append these tests to `server/services/agent-session-runtime.test.js`:

```js
test('docker mode stopRuntime is idempotent for an exited container', async () => {
  let stopped = false;
  let statusUpdate = null;
  const manager = createAgentSessionRuntimeManager({
    env: { CLAUDE_EXECUTION_MODE: 'docker' },
    multitenancy: {
      runtimes: {
        findByRuntimeId: () => ({ runtime_id: 'runtime-1', container_name: 'container-1' }),
        updateStatus: (input) => {
          statusUpdate = input;
          return input;
        },
      },
    },
    docker: {
      inspectContainer: async () => ({ exists: true, running: false, state: 'exited' }),
      stopContainer: async () => {
        stopped = true;
      },
    },
  });

  const result = await manager.stopRuntime('runtime-1');

  assert.equal(result, true);
  assert.equal(stopped, false);
  assert.deepEqual(statusUpdate, { runtimeId: 'runtime-1', status: 'idle' });
});

test('docker mode stopRuntime is idempotent for a missing container', async () => {
  let statusUpdate = null;
  const manager = createAgentSessionRuntimeManager({
    env: { CLAUDE_EXECUTION_MODE: 'docker' },
    multitenancy: {
      runtimes: {
        findByRuntimeId: () => ({ runtime_id: 'runtime-2', container_name: 'container-2' }),
        updateStatus: (input) => {
          statusUpdate = input;
          return input;
        },
      },
    },
    docker: {
      inspectContainer: async () => null,
      stopContainer: async () => {
        throw new Error('must not stop missing container');
      },
    },
  });

  const result = await manager.stopRuntime('runtime-2');

  assert.equal(result, true);
  assert.deepEqual(statusUpdate, { runtimeId: 'runtime-2', status: 'idle' });
});
```

Create `server/services/runtime-monitor.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRuntimeMonitorService,
  parseDockerMemoryUsage,
  parseDockerStatsLine,
  resolveRuntimeMonitorConfig,
} from './runtime-monitor.js';

test('resolveRuntimeMonitorConfig uses 30 minute idle default and env overrides', () => {
  assert.deepEqual(resolveRuntimeMonitorConfig({ CLAUDE_EXECUTION_MODE: 'docker' }), {
    enabled: true,
    idleTimeoutMinutes: 30,
    sweeperIntervalSeconds: 60,
    staleActiveMinutes: 30,
  });
  assert.deepEqual(resolveRuntimeMonitorConfig({
    CLOUDCLI_RUNTIME_SWEEPER_ENABLED: 'false',
    CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES: '5',
    CLOUDCLI_RUNTIME_SWEEPER_INTERVAL_SECONDS: '10',
    CLOUDCLI_RUNTIME_STALE_ACTIVE_MINUTES: '7',
  }), {
    enabled: false,
    idleTimeoutMinutes: 5,
    sweeperIntervalSeconds: 10,
    staleActiveMinutes: 7,
  });
});

test('parseDockerStatsLine parses json stats from docker stats', () => {
  const stats = parseDockerStatsLine(JSON.stringify({
    Name: 'container-1',
    CPUPerc: '1.25%',
    MemUsage: '128MiB / 2GiB',
  }));

  assert.equal(stats.name, 'container-1');
  assert.equal(stats.cpuPercent, 1.25);
  assert.equal(stats.memoryUsageBytes, 134217728);
  assert.equal(stats.memoryLimitBytes, 2147483648);
});

test('parseDockerMemoryUsage handles docker memory units', () => {
  assert.deepEqual(parseDockerMemoryUsage('512KiB / 1MiB'), {
    memoryUsageBytes: 524288,
    memoryLimitBytes: 1048576,
  });
  assert.deepEqual(parseDockerMemoryUsage('1.5GiB / 2GiB'), {
    memoryUsageBytes: 1610612736,
    memoryLimitBytes: 2147483648,
  });
});

test('runtime monitor enriches rows with docker state stats and summary', async () => {
  const rows = [{
    runtime_id: 'runtime-1',
    tenant_id: 1,
    tenant_code: 'default',
    tenant_name: 'Default',
    user_id: 2,
    username: 'admin',
    workspace_id: 3,
    workspace_display_name: 'Demo',
    provider: 'claude',
    provider_session_id: 'session-1',
    container_name: 'container-1',
    image: 'cloudcli/test:claude',
    status: 'idle',
    last_used_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  }];
  const service = createRuntimeMonitorService({
    multitenancy: {
      runtimes: {
        listForMonitor: () => ({ rows, total: 1 }),
      },
    },
    docker: {
      inspectContainer: async () => ({ exists: true, running: true, state: 'running' }),
      statsContainers: async () => new Map([['container-1', {
        name: 'container-1',
        cpuPercent: 0.5,
        memoryUsageBytes: 100,
        memoryLimitBytes: 1000,
      }]]),
    },
    now: () => new Date(),
  });

  const result = await service.listRuntimes();

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].businessStatus, 'idle');
  assert.equal(result.rows[0].dockerState, 'running');
  assert.equal(result.rows[0].canStop, true);
  assert.equal(result.summary.idleRunning, 1);
  assert.equal(result.summary.totalLiveMemoryBytes, 100);
});
```

- [ ] **Step 2: Run service tests and confirm failure**

Run:

```bash
node --test server/services/agent-session-runtime.test.js server/services/runtime-monitor.test.js
```

Expected: fail because `runtime-monitor.js` does not exist and Docker client methods are not implemented.

- [ ] **Step 3: Extend DockerCliClient and idempotent Stop**

In `server/services/agent-session-runtime.js`, replace `inspectContainer()` with a richer state result:

```js
async inspectContainer(containerName) {
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '-f',
      '{{json .State}}',
      containerName,
    ]);
    const state = JSON.parse(stdout.trim());
    return {
      exists: true,
      running: state.Running === true,
      state: state.Running === true ? 'running' : (state.Status || 'exited'),
      status: state.Status || null,
      exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
      startedAt: state.StartedAt || null,
      finishedAt: state.FinishedAt || null,
    };
  } catch (error) {
    if (error?.code === 1 || error?.stderr?.includes('No such object')) {
      return null;
    }
    throw error;
  }
}

async statsContainers(containerNames) {
  const names = [...new Set((containerNames || []).filter(Boolean))];
  if (names.length === 0) return new Map();
  const { stdout } = await execFileAsync('docker', [
    'stats',
    '--no-stream',
    '--format',
    'json',
    ...names,
  ]);
  const rows = new Map();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    const name = parsed.Name || parsed.Container || parsed.ID;
    if (name) rows.set(name, parsed);
  }
  return rows;
}
```

Keep `stopRuntime()` idempotent with this body:

```js
async stopRuntime(runtimeId) {
  if (!runtimeId) return false;

  const runtime = multitenancy.runtimes.findByRuntimeId(runtimeId);
  if (!runtime) return false;

  const inspected = await docker.inspectContainer(runtime.container_name);
  if (inspected?.running) {
    await docker.stopContainer(runtime.container_name);
  }

  multitenancy.runtimes.updateStatus({ runtimeId, status: 'idle' });
  return true;
},
```

- [ ] **Step 4: Create runtime monitor service**

Create `server/services/runtime-monitor.js`:

```js
import { DockerCliClient, agentSessionRuntimeManager } from './agent-session-runtime.js';
import { multitenancyDb } from '../database/multitenancy-db.js';

const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const DEFAULT_SWEEPER_INTERVAL_SECONDS = 60;
const DEFAULT_STALE_ACTIVE_MINUTES = 30;

function parsePositiveNumber(value, fallback, name) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

export function resolveRuntimeMonitorConfig(env = process.env) {
  return {
    enabled: parseBoolean(
      env.CLOUDCLI_RUNTIME_SWEEPER_ENABLED,
      String(env.CLAUDE_EXECUTION_MODE || 'local').toLowerCase() === 'docker',
    ),
    idleTimeoutMinutes: parsePositiveNumber(
      env.CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES,
      DEFAULT_IDLE_TIMEOUT_MINUTES,
      'CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES',
    ),
    sweeperIntervalSeconds: parsePositiveNumber(
      env.CLOUDCLI_RUNTIME_SWEEPER_INTERVAL_SECONDS,
      DEFAULT_SWEEPER_INTERVAL_SECONDS,
      'CLOUDCLI_RUNTIME_SWEEPER_INTERVAL_SECONDS',
    ),
    staleActiveMinutes: parsePositiveNumber(
      env.CLOUDCLI_RUNTIME_STALE_ACTIVE_MINUTES,
      DEFAULT_STALE_ACTIVE_MINUTES,
      'CLOUDCLI_RUNTIME_STALE_ACTIVE_MINUTES',
    ),
  };
}

function parseDockerByteValue(value) {
  const match = String(value).trim().match(/^([\d.]+)\s*([KMGT]?i?B|B)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  return Math.round(amount * (multipliers[unit] || 1));
}

export function parseDockerMemoryUsage(memUsage) {
  const [usage, limit] = String(memUsage || '').split('/').map((part) => part.trim());
  return {
    memoryUsageBytes: parseDockerByteValue(usage),
    memoryLimitBytes: parseDockerByteValue(limit),
  };
}

export function parseDockerStatsLine(line) {
  const parsed = typeof line === 'string' ? JSON.parse(line) : line;
  const { memoryUsageBytes, memoryLimitBytes } = parseDockerMemoryUsage(parsed.MemUsage || parsed.MemPerc);
  return {
    name: parsed.Name || parsed.Container || parsed.ID,
    cpuPercent: Number(String(parsed.CPUPerc || '0').replace('%', '')),
    memoryUsageBytes,
    memoryLimitBytes,
  };
}

function toDockerState(inspected) {
  if (!inspected) return 'missing';
  if (inspected.running) return 'running';
  return inspected.state || 'exited';
}

function secondsSince(now, isoDate) {
  const time = Date.parse(isoDate);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / 1000));
}

function mapMonitorRow(row, inspected, stats, { now, staleActiveMinutes }) {
  const dockerState = toDockerState(inspected);
  const idleAgeSeconds = secondsSince(now, row.last_used_at);
  const activeAgeSeconds = secondsSince(now, row.updated_at || row.last_used_at);
  const staleActive = row.status === 'active'
    && activeAgeSeconds != null
    && activeAgeSeconds >= staleActiveMinutes * 60;

  return {
    runtimeId: row.runtime_id,
    tenant: { id: row.tenant_id, code: row.tenant_code, name: row.tenant_name },
    user: { id: row.user_id, username: row.username },
    workspace: {
      id: row.workspace_id,
      displayName: row.workspace_display_name,
      slug: row.workspace_slug,
    },
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    businessStatus: row.status,
    dockerState,
    staleActive,
    containerName: row.container_name,
    image: row.image,
    lastUsedAt: row.last_used_at,
    updatedAt: row.updated_at,
    cpuPercent: stats?.cpuPercent ?? null,
    memoryUsageBytes: stats?.memoryUsageBytes ?? null,
    memoryLimitBytes: stats?.memoryLimitBytes ?? null,
    idleAgeSeconds,
    canStop: dockerState === 'running',
  };
}

function buildSummary(rows) {
  return rows.reduce((summary, row) => {
    summary.total += 1;
    if (row.businessStatus === 'active') summary.active += 1;
    if (row.businessStatus === 'idle' && row.dockerState === 'running') summary.idleRunning += 1;
    if (row.businessStatus === 'failed' || row.dockerState === 'unknown') summary.failedOrUnknown += 1;
    if (row.dockerState === 'missing') summary.missing += 1;
    if (row.staleActive) summary.staleActive += 1;
    summary.totalLiveMemoryBytes += row.memoryUsageBytes || 0;
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

export function createRuntimeMonitorService({
  multitenancy = multitenancyDb,
  docker = new DockerCliClient(),
  runtimeManager = agentSessionRuntimeManager,
  config = resolveRuntimeMonitorConfig(),
  now = () => new Date(),
  logger = console,
} = {}) {
  async function enrichRows(rows) {
    const inspectedByName = new Map();
    await Promise.all(rows.map(async (row) => {
      try {
        inspectedByName.set(row.container_name, await docker.inspectContainer(row.container_name));
      } catch (error) {
        logger.warn?.('[runtime-monitor] docker inspect failed', {
          containerName: row.container_name,
          error: error?.message || String(error),
        });
        inspectedByName.set(row.container_name, { exists: true, running: false, state: 'unknown' });
      }
    }));

    let statsByName = new Map();
    const runningNames = rows
      .filter((row) => inspectedByName.get(row.container_name)?.running)
      .map((row) => row.container_name);
    if (runningNames.length > 0) {
      try {
        const rawStats = await docker.statsContainers(runningNames);
        statsByName = new Map([...rawStats.entries()].map(([name, value]) => [name, parseDockerStatsLine(value)]));
      } catch (error) {
        logger.warn?.('[runtime-monitor] docker stats failed', { error: error?.message || String(error) });
      }
    }

    const currentTime = now();
    return rows.map((row) => mapMonitorRow(row, inspectedByName.get(row.container_name), statsByName.get(row.container_name), {
      now: currentTime,
      staleActiveMinutes: config.staleActiveMinutes,
    }));
  }

  return {
    async listRuntimes(filters = {}) {
      const result = multitenancy.runtimes.listForMonitor(filters);
      const rows = await enrichRows(result.rows);
      const filteredRows = filters.dockerState
        ? rows.filter((row) => row.dockerState === filters.dockerState)
        : rows;
      return {
        total: filters.dockerState ? filteredRows.length : result.total,
        rows: filteredRows,
        summary: buildSummary(filteredRows),
      };
    },

    async getRuntime(runtimeId) {
      const row = multitenancy.runtimes.getMonitorRowByRuntimeId(runtimeId);
      if (!row) return null;
      const rows = await enrichRows([row]);
      return rows[0] || null;
    },

    async getSummary(filters = {}) {
      const result = await this.listRuntimes({ ...filters, limit: 200, offset: 0 });
      return result.summary;
    },

    async stopRuntime({ runtimeId, adminUserId }) {
      const before = multitenancy.runtimes.getMonitorRowByRuntimeId(runtimeId);
      if (!before) return null;
      await runtimeManager.stopRuntime(runtimeId);
      logger.info?.('[runtime-monitor] admin stopped runtime', {
        adminUserId,
        runtimeId,
        tenantId: before.tenant_id,
        workspaceId: before.workspace_id,
        providerSessionId: before.provider_session_id,
        containerName: before.container_name,
      });
      return this.getRuntime(runtimeId);
    },
  };
}

export const runtimeMonitorService = createRuntimeMonitorService();
```

- [ ] **Step 5: Run service tests and confirm pass**

Run:

```bash
node --test server/services/agent-session-runtime.test.js server/services/runtime-monitor.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit monitor service work**

```bash
git add server/services/agent-session-runtime.js server/services/agent-session-runtime.test.js server/services/runtime-monitor.js server/services/runtime-monitor.test.js
git commit -m "feat: add runtime monitor service"
```

---

### Task 3: Add Admin Runtime API Endpoints

**Files:**
- Modify: `server/routes/admin.js`
- Create: `server/routes/admin-runtime-monitor.test.js`

- [ ] **Step 1: Write failing Admin API tests**

Create `server/routes/admin-runtime-monitor.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { createAdminRouter } from './admin.js';

async function requestJson(router, path, { method = 'GET', body = null, user = { id: 1, is_system_admin: 1 } } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = user;
      next();
    });
    app.use(router);

    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

test('admin runtime list requires system admin', async () => {
  const router = createAdminRouter({}, {}, { listRuntimes: async () => ({ rows: [], total: 0, summary: {} }) });

  const { response } = await requestJson(router, '/runtimes', {
    user: { id: 2, is_system_admin: 0 },
  });

  assert.equal(response.status, 403);
});

test('admin runtime list returns rows from monitor service', async () => {
  const seen = {};
  const router = createAdminRouter({}, {}, {
    listRuntimes: async (filters) => {
      seen.filters = filters;
      return { rows: [{ runtimeId: 'runtime-1' }], total: 1, summary: { total: 1 } };
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes?status=idle&q=demo');

  assert.equal(response.status, 200);
  assert.deepEqual(seen.filters.status, 'idle');
  assert.deepEqual(seen.filters.q, 'demo');
  assert.deepEqual(payload.rows, [{ runtimeId: 'runtime-1' }]);
  assert.equal(payload.total, 1);
});

test('admin runtime summary returns monitor summary', async () => {
  const router = createAdminRouter({}, {}, {
    getSummary: async () => ({ total: 2, idleRunning: 1 }),
  });

  const { response, payload } = await requestJson(router, '/runtimes/summary');

  assert.equal(response.status, 200);
  assert.deepEqual(payload.summary, { total: 2, idleRunning: 1 });
});

test('admin runtime stop returns refreshed runtime row', async () => {
  const seen = {};
  const router = createAdminRouter({}, {}, {
    stopRuntime: async (input) => {
      seen.input = input;
      return { runtimeId: input.runtimeId, dockerState: 'exited' };
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes/runtime-1/stop', { method: 'POST' });

  assert.equal(response.status, 200);
  assert.deepEqual(seen.input, { runtimeId: 'runtime-1', adminUserId: 1 });
  assert.deepEqual(payload.runtime, { runtimeId: 'runtime-1', dockerState: 'exited' });
});

test('admin runtime stop returns 404 for unknown runtime', async () => {
  const router = createAdminRouter({}, {}, {
    stopRuntime: async () => null,
  });

  const { response, payload } = await requestJson(router, '/runtimes/missing/stop', { method: 'POST' });

  assert.equal(response.status, 404);
  assert.equal(payload.error, 'Runtime not found');
});
```

- [ ] **Step 2: Run route tests and confirm failure**

Run:

```bash
node --test server/routes/admin-runtime-monitor.test.js
```

Expected: fail because the routes are not registered.

- [ ] **Step 3: Implement Admin runtime routes**

Change the imports in `server/routes/admin.js`:

```js
import { runtimeMonitorService } from '../services/runtime-monitor.js';
```

Change the router factory signature:

```js
export function createAdminRouter(
  multitenancy = multitenancyDb,
  users = userDb,
  runtimeMonitor = runtimeMonitorService,
) {
```

Add this query parser near `sendRouteError`:

```js
function buildRuntimeFilters(query = {}) {
  return {
    tenantId: query.tenantId ? Number(query.tenantId) : undefined,
    userId: query.userId ? Number(query.userId) : undefined,
    workspaceId: query.workspaceId ? Number(query.workspaceId) : undefined,
    provider: query.provider || undefined,
    status: query.status || undefined,
    dockerState: query.dockerState || undefined,
    q: query.q || undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined,
  };
}
```

Add these routes before `return router;`:

```js
router.get('/runtimes', async (req, res) => {
  try {
    const result = await runtimeMonitor.listRuntimes(buildRuntimeFilters(req.query));
    res.json(result);
  } catch (error) {
    sendRouteError(res, error, 'Failed to list runtimes');
  }
});

router.get('/runtimes/summary', async (req, res) => {
  try {
    const summary = await runtimeMonitor.getSummary(buildRuntimeFilters(req.query));
    res.json({ summary });
  } catch (error) {
    sendRouteError(res, error, 'Failed to load runtime summary');
  }
});

router.post('/runtimes/:runtimeId/stop', async (req, res) => {
  try {
    const runtime = await runtimeMonitor.stopRuntime({
      runtimeId: req.params.runtimeId,
      adminUserId: req.user.id,
    });
    if (!runtime) {
      return res.status(404).json({ error: 'Runtime not found' });
    }
    return res.json({ runtime });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to stop runtime';
    if (message.toLowerCase().includes('docker')) {
      return res.status(503).json({ error: message });
    }
    return sendRouteError(res, error, 'Failed to stop runtime');
  }
});
```

Update the default export:

```js
export default createAdminRouter(multitenancyDb, userDb, runtimeMonitorService);
```

- [ ] **Step 4: Run route tests and confirm pass**

Run:

```bash
node --test server/routes/admin-runtime-monitor.test.js server/routes/multitenancy-routes.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit Admin route work**

```bash
git add server/routes/admin.js server/routes/admin-runtime-monitor.test.js
git commit -m "feat: expose admin runtime monitor api"
```

---

### Task 4: Add Idle-Only Runtime Sweeper

**Files:**
- Create: `server/services/runtime-sweeper.js`
- Create: `server/services/runtime-sweeper.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write failing sweeper tests**

Create `server/services/runtime-sweeper.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeSweeper } from './runtime-sweeper.js';

test('runtime sweeper stops only expired idle running containers', async () => {
  const stopped = [];
  const sweeper = createRuntimeSweeper({
    config: { enabled: true, idleTimeoutMinutes: 30, sweeperIntervalSeconds: 60 },
    multitenancy: {
      runtimes: {
        listExpiredIdleRuntimes: () => [
          { runtime_id: 'idle-running', container_name: 'container-1' },
          { runtime_id: 'idle-exited', container_name: 'container-2' },
        ],
      },
    },
    docker: {
      inspectContainer: async (name) => name === 'container-1'
        ? { exists: true, running: true, state: 'running' }
        : { exists: true, running: false, state: 'exited' },
    },
    runtimeManager: {
      stopRuntime: async (runtimeId) => {
        stopped.push(runtimeId);
        return true;
      },
    },
    logger: { info: () => {}, warn: () => {} },
  });

  const result = await sweeper.sweepOnce();

  assert.deepEqual(stopped, ['idle-running']);
  assert.deepEqual(result, { inspected: 2, stopped: 1, failed: 0 });
});

test('runtime sweeper does nothing when disabled', async () => {
  let listed = false;
  const sweeper = createRuntimeSweeper({
    config: { enabled: false, idleTimeoutMinutes: 30, sweeperIntervalSeconds: 60 },
    multitenancy: {
      runtimes: {
        listExpiredIdleRuntimes: () => {
          listed = true;
          return [];
        },
      },
    },
  });

  const result = await sweeper.sweepOnce();

  assert.equal(listed, false);
  assert.deepEqual(result, { inspected: 0, stopped: 0, failed: 0 });
});

test('runtime sweeper start and stop manage one interval', () => {
  const intervals = [];
  const cleared = [];
  const sweeper = createRuntimeSweeper({
    config: { enabled: true, idleTimeoutMinutes: 30, sweeperIntervalSeconds: 60 },
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms });
      return 'timer-1';
    },
    clearIntervalFn: (id) => cleared.push(id),
  });

  sweeper.start();
  sweeper.start();
  sweeper.stop();

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 60000);
  assert.deepEqual(cleared, ['timer-1']);
});
```

- [ ] **Step 2: Run sweeper tests and confirm failure**

Run:

```bash
node --test server/services/runtime-sweeper.test.js
```

Expected: fail because `runtime-sweeper.js` does not exist.

- [ ] **Step 3: Implement runtime sweeper**

Create `server/services/runtime-sweeper.js`:

```js
import { multitenancyDb } from '../database/multitenancy-db.js';
import { DockerCliClient, agentSessionRuntimeManager } from './agent-session-runtime.js';
import { resolveRuntimeMonitorConfig } from './runtime-monitor.js';

export function createRuntimeSweeper({
  config = resolveRuntimeMonitorConfig(),
  multitenancy = multitenancyDb,
  docker = new DockerCliClient(),
  runtimeManager = agentSessionRuntimeManager,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let timer = null;
  let running = false;

  async function sweepOnce() {
    if (!config.enabled) {
      return { inspected: 0, stopped: 0, failed: 0 };
    }
    if (running) {
      return { inspected: 0, stopped: 0, failed: 0 };
    }
    running = true;
    let inspected = 0;
    let stopped = 0;
    let failed = 0;

    try {
      const candidates = multitenancy.runtimes.listExpiredIdleRuntimes({
        olderThanMinutes: config.idleTimeoutMinutes,
        limit: 100,
      });
      for (const runtime of candidates) {
        inspected += 1;
        try {
          const container = await docker.inspectContainer(runtime.container_name);
          if (container?.running) {
            await runtimeManager.stopRuntime(runtime.runtime_id);
            stopped += 1;
            logger.info?.('[runtime-sweeper] stopped idle runtime', {
              runtimeId: runtime.runtime_id,
              containerName: runtime.container_name,
              idleTimeoutMinutes: config.idleTimeoutMinutes,
            });
          }
        } catch (error) {
          failed += 1;
          logger.warn?.('[runtime-sweeper] failed to inspect or stop runtime', {
            runtimeId: runtime.runtime_id,
            containerName: runtime.container_name,
            error: error?.message || String(error),
          });
        }
      }
      return { inspected, stopped, failed };
    } finally {
      running = false;
    }
  }

  function start() {
    if (!config.enabled || timer) return;
    timer = setIntervalFn(() => {
      void sweepOnce();
    }, config.sweeperIntervalSeconds * 1000);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { sweepOnce, start, stop };
}

export const runtimeSweeper = createRuntimeSweeper();
```

- [ ] **Step 4: Start sweeper from server lifecycle**

In `server/index.js`, add the import:

```js
import { runtimeSweeper } from './services/runtime-sweeper.js';
```

After `await initializeDatabase();` in the startup path, add:

```js
runtimeSweeper.start();
```

Replace the existing shutdown function near the bottom of `server/index.js`:

```js
const shutdownPlugins = async () => {
    await stopAllPlugins();
    process.exit(0);
};
```

with:

```js
const shutdownPlugins = async () => {
    runtimeSweeper.stop();
    await stopAllPlugins();
    process.exit(0);
};
```

- [ ] **Step 5: Run sweeper tests and smoke typecheck**

Run:

```bash
node --test server/services/runtime-sweeper.test.js
npm run typecheck
```

Expected: tests pass and typecheck exits with code 0.

- [ ] **Step 6: Commit sweeper work**

```bash
git add server/services/runtime-sweeper.js server/services/runtime-sweeper.test.js server/index.js
git commit -m "feat: stop idle docker runtimes automatically"
```

---

### Task 5: Add Frontend Runtime Monitor API And Helpers

**Files:**
- Modify: `src/utils/api.js`
- Create: `src/components/admin/runtimeMonitorUtils.ts`
- Create: `src/components/admin/runtimeMonitorUtils.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create `src/components/admin/runtimeMonitorUtils.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRuntimeQueryString,
  formatBytes,
  formatRuntimeAge,
  runtimeRowContainsHostPath,
} from './runtimeMonitorUtils';

test('buildRuntimeQueryString includes only selected filters', () => {
  assert.equal(
    buildRuntimeQueryString({ status: 'idle', tenantId: '2', q: 'demo', userId: '', workspaceId: '' }),
    '?status=idle&tenantId=2&q=demo',
  );
});

test('formatBytes renders compact binary units', () => {
  assert.equal(formatBytes(null), '-');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(2147483648), '2.0 GiB');
});

test('formatRuntimeAge renders seconds minutes and hours', () => {
  assert.equal(formatRuntimeAge(null), '-');
  assert.equal(formatRuntimeAge(42), '42s');
  assert.equal(formatRuntimeAge(360), '6m');
  assert.equal(formatRuntimeAge(7200), '2h');
});

test('runtimeRowContainsHostPath guards against accidental host path display', () => {
  assert.equal(runtimeRowContainsHostPath({
    runtimeId: 'r1',
    containerName: 'cloudcli-claude',
    workspaceHostPath: '/Users/admin/secret',
  }), true);
  assert.equal(runtimeRowContainsHostPath({
    runtimeId: 'r1',
    containerName: 'cloudcli-claude',
  }), false);
});
```

- [ ] **Step 2: Run helper tests and confirm failure**

Run:

```bash
npx tsx --test src/components/admin/runtimeMonitorUtils.test.ts
```

Expected: fail because `runtimeMonitorUtils.ts` does not exist.

- [ ] **Step 3: Implement helper utilities**

Create `src/components/admin/runtimeMonitorUtils.ts`:

```ts
export type RuntimeMonitorFilters = {
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  status?: string;
  dockerState?: string;
  provider?: string;
  q?: string;
};

export function buildRuntimeQueryString(filters: RuntimeMonitorFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value != null && String(value).trim() !== '') {
      params.set(key, String(value).trim());
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${amount} B` : `${amount.toFixed(1)} ${units[unitIndex]}`;
}

export function formatRuntimeAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '-';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function runtimeRowContainsHostPath(row: Record<string, unknown>): boolean {
  return Object.keys(row).some((key) => key === 'workspaceHostPath' || key === 'runtimeHomePath');
}
```

- [ ] **Step 4: Add API client methods**

In `src/utils/api.js`, import the query helper:

```js
import { buildRuntimeQueryString } from '../components/admin/runtimeMonitorUtils';
```

Inside `api.admin`, add:

```js
runtimes: (filters = {}) =>
  authenticatedFetch(`/api/admin/runtimes${buildRuntimeQueryString(filters)}`),
runtimeSummary: (filters = {}) =>
  authenticatedFetch(`/api/admin/runtimes/summary${buildRuntimeQueryString(filters)}`),
stopRuntime: (runtimeId) =>
  authenticatedFetch(`/api/admin/runtimes/${encodeURIComponent(runtimeId)}/stop`, {
    method: 'POST',
  }),
```

- [ ] **Step 5: Run helper tests and typecheck**

Run:

```bash
npx tsx --test src/components/admin/runtimeMonitorUtils.test.ts
npm run typecheck
```

Expected: tests pass and typecheck exits with code 0.

- [ ] **Step 6: Commit frontend helper work**

```bash
git add src/utils/api.js src/components/admin/runtimeMonitorUtils.ts src/components/admin/runtimeMonitorUtils.test.ts
git commit -m "feat: add runtime monitor frontend helpers"
```

---

### Task 6: Add Runtime Monitor Admin UI

**Files:**
- Create: `src/components/admin/RuntimeMonitorTab.tsx`
- Modify: `src/components/admin/AdminPanel.tsx`

- [ ] **Step 1: Add the RuntimeMonitorTab component**

Create `src/components/admin/RuntimeMonitorTab.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, Square } from 'lucide-react';

import { api } from '../../utils/api';
import { Button, Input } from '../../shared/view/ui';
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
  lastUsedAt: string;
  updatedAt: string;
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
};

function statusClassName(status: string): string {
  if (status === 'active' || status === 'running') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'idle' || status === 'exited') return 'bg-slate-50 text-slate-700 border-slate-200';
  if (status === 'failed' || status === 'unknown' || status === 'missing') return 'bg-rose-50 text-rose-700 border-rose-200';
  return 'bg-amber-50 text-amber-700 border-amber-200';
}

function StatusChip({ value }: { value: string }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${statusClassName(value)}`}>
      {value}
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
  const payload = await response.json().catch(() => ({} as { error?: string; message?: string }));
  return payload.error || payload.message || fallback;
}

export default function RuntimeMonitorTab() {
  const [filters, setFilters] = useState<RuntimeMonitorFilters>({ status: '', dockerState: '', q: '' });
  const [rows, setRows] = useState<RuntimeRow[]>([]);
  const [summary, setSummary] = useState<RuntimeSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [stoppingRuntimeId, setStoppingRuntimeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queryKey = useMemo(() => buildRuntimeQueryString(filters), [filters]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.runtimes(filters);
      if (!response.ok) {
        setError(await readError(response, 'Failed to load runtimes'));
        return;
      }
      const payload = await response.json() as RuntimePayload;
      setRows(payload.rows || []);
      setSummary(payload.summary || null);
      setTotal(payload.total || 0);
    } catch (caughtError) {
      console.error('[RuntimeMonitorTab] Failed to load runtimes:', caughtError);
      setError('Failed to load runtimes');
    } finally {
      setIsLoading(false);
    }
  }, [queryKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const stopRuntime = async (runtimeId: string) => {
    setStoppingRuntimeId(runtimeId);
    setError(null);
    try {
      const response = await api.admin.stopRuntime(runtimeId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to stop runtime'));
        return;
      }
      await load();
    } finally {
      setStoppingRuntimeId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-5">
        <SummaryTile label="Total" value={summary?.total ?? total} />
        <SummaryTile label="Active" value={summary?.active ?? 0} />
        <SummaryTile label="Idle running" value={summary?.idleRunning ?? 0} />
        <SummaryTile label="Failed / unknown" value={summary?.failedOrUnknown ?? 0} />
        <SummaryTile label="Live memory" value={formatBytes(summary?.totalLiveMemoryBytes)} />
      </div>

      <div className="grid gap-2 lg:grid-cols-[150px_150px_minmax(0,1fr)_auto]">
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={filters.status || ''}
          onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="idle">Idle</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
        </select>
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={filters.dockerState || ''}
          onChange={(event) => setFilters((current) => ({ ...current, dockerState: event.target.value }))}
        >
          <option value="">All docker</option>
          <option value="running">Running</option>
          <option value="exited">Exited</option>
          <option value="missing">Missing</option>
          <option value="unknown">Unknown</option>
        </select>
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            value={filters.q || ''}
            onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
            placeholder="Search runtime, session, tenant, user, workspace"
          />
        </label>
        <Button variant="ghost" size="icon" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="min-w-[960px] w-full text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Runtime</th>
              <th className="px-3 py-2 font-medium">Tenant</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Workspace</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Docker</th>
              <th className="px-3 py-2 font-medium">CPU</th>
              <th className="px-3 py-2 font-medium">Memory</th>
              <th className="px-3 py-2 font-medium">Idle</th>
              <th className="px-3 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-muted-foreground" colSpan={10}>
                  No runtimes
                </td>
              </tr>
            ) : rows.map((row) => (
              <tr key={row.runtimeId} className="border-b border-border last:border-b-0">
                <td className="max-w-56 px-3 py-2">
                  <div className="truncate font-medium text-foreground">{row.providerSessionId || row.runtimeId}</div>
                  <div className="truncate text-xs text-muted-foreground">{row.containerName}</div>
                </td>
                <td className="px-3 py-2">{row.tenant.name}</td>
                <td className="px-3 py-2">{row.user.username}</td>
                <td className="max-w-44 truncate px-3 py-2">{row.workspace.displayName}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <StatusChip value={row.businessStatus} />
                    {row.staleActive ? <StatusChip value="active stale" /> : null}
                  </div>
                </td>
                <td className="px-3 py-2"><StatusChip value={row.dockerState} /></td>
                <td className="px-3 py-2">{row.cpuPercent == null ? '-' : `${row.cpuPercent.toFixed(1)}%`}</td>
                <td className="px-3 py-2">
                  {formatBytes(row.memoryUsageBytes)}
                  {row.memoryLimitBytes ? <span className="text-muted-foreground"> / {formatBytes(row.memoryLimitBytes)}</span> : null}
                </td>
                <td className="px-3 py-2">{formatRuntimeAge(row.idleAgeSeconds)}</td>
                <td className="px-3 py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!row.canStop || stoppingRuntimeId === row.runtimeId}
                    onClick={() => void stopRuntime(row.runtimeId)}
                  >
                    <Square className="h-3.5 w-3.5" />
                    Stop
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Mount the tab in AdminPanel**

In `src/components/admin/AdminPanel.tsx`, import:

```tsx
import RuntimeMonitorTab from './RuntimeMonitorTab';
```

Add state near the existing `useState` calls:

```tsx
const [activeTab, setActiveTab] = useState<'tenants' | 'runtimes'>('tenants');
```

Change the dialog width:

```tsx
<DialogContent className="max-h-[88vh] max-w-6xl overflow-hidden p-0">
```

Change the subtitle:

```tsx
<p className="truncate text-xs text-muted-foreground">Tenants, users, memberships, and runtimes</p>
```

Add tab buttons below the header block:

```tsx
<div className="flex gap-1 border-b border-border px-5 py-2">
  <Button
    variant={activeTab === 'tenants' ? 'default' : 'ghost'}
    size="sm"
    onClick={() => setActiveTab('tenants')}
  >
    Tenants & Users
  </Button>
  <Button
    variant={activeTab === 'runtimes' ? 'default' : 'ghost'}
    size="sm"
    onClick={() => setActiveTab('runtimes')}
  >
    Runtime Monitor
  </Button>
</div>
```

Replace the current single content wrapper:

```tsx
<div className="space-y-5 overflow-y-auto px-5 py-4">
```

with:

```tsx
{activeTab === 'tenants' ? (
  <div className="space-y-5 overflow-y-auto px-5 py-4">
```

Keep every current tenant/user section inside that branch. The moved block starts at the `Create tenant` section and ends after the existing `{error ? (...) : null}` block.

After the closing `</div>` for that tenant branch, add:

```tsx
) : (
  <div className="overflow-y-auto px-5 py-4">
    <RuntimeMonitorTab />
  </div>
)}
```

- [ ] **Step 3: Run frontend helper tests and typecheck**

Run:

```bash
npx tsx --test src/components/admin/runtimeMonitorUtils.test.ts
npm run typecheck
```

Expected: tests pass and typecheck exits with code 0.

- [ ] **Step 4: Commit UI work**

```bash
git add src/components/admin/RuntimeMonitorTab.tsx src/components/admin/AdminPanel.tsx
git commit -m "feat: add admin runtime monitor tab"
```

---

### Task 7: Full Verification And Browser Validation

**Files:**
- Modify only if verification finds a defect in files changed by Tasks 1-6.

- [ ] **Step 1: Run targeted backend tests**

Run:

```bash
node --test server/database/multitenancy-db.test.js server/services/agent-session-runtime.test.js server/services/runtime-monitor.test.js server/services/runtime-sweeper.test.js server/routes/admin-runtime-monitor.test.js server/routes/multitenancy-routes.test.js
```

Expected: all tests pass.

- [ ] **Step 2: Run targeted frontend tests**

Run:

```bash
npx tsx --test src/components/admin/runtimeMonitorUtils.test.ts src/components/admin/adminPanelUtils.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run multitenancy regression suite**

Run:

```bash
npm run test:multitenancy
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exits with code 0.

- [ ] **Step 5: Run Docker-mode manual verification**

Start the app with a short idle timeout:

```bash
CLAUDE_EXECUTION_MODE=docker CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES=1 CLOUDCLI_RUNTIME_SWEEPER_INTERVAL_SECONDS=10 npm run dev
```

Expected: server starts and Vite opens on `http://localhost:5173/`.

Use Computer Use in the in-app browser:

1. Log in as the system admin account.
2. Open the Admin dialog.
3. Click `Runtime Monitor`.
4. Create or resume a Claude session in Docker mode.
5. Confirm the monitor row appears with `businessStatus=active` and `dockerState=running`.
6. Let the response complete.
7. Confirm the row changes to `businessStatus=idle` while `dockerState=running`.
8. Wait for the one-minute timeout plus sweeper interval.
9. Refresh Runtime Monitor.
10. Confirm the same row has `dockerState=exited` and the message history still opens.
11. Start a second active query.
12. Confirm the sweeper does not stop the active runtime.
13. Click Stop on a running idle runtime.
14. Confirm the Stop button disables while in flight and the row refreshes to stopped/exited state.

- [ ] **Step 6: Confirm host paths are hidden**

In the Runtime Monitor table, verify that neither of these strings appears:

```text
workspace_host_path
runtime_home_path
```

Also verify real host prefixes such as `/Users/` and `~/.cloudcli/runtimes` do not appear in the default table.

- [ ] **Step 7: Final commit for verification-only fixes**

If Task 7 required code changes, commit only the files from Tasks 1-6 that were modified during verification. First inspect the changed files:

```bash
git status --short
```

Then stage only the touched implementation files. Example for a backend-only verification fix:

```bash
git add server/services/runtime-monitor.js server/services/runtime-monitor.test.js
git commit -m "fix: polish runtime monitor verification issues"
```

If no code changes were required, do not create an empty commit.

---

## Final Acceptance Criteria

- Admin users can open `System administration -> Runtime Monitor`.
- Non-admin users receive `403` for runtime monitor endpoints.
- Runtime rows show tenant, user, workspace, provider session, business status, Docker state, CPU, memory, idle age, and Stop.
- Default table does not reveal host workspace or runtime home paths.
- Stop action stops only the Docker process and preserves DB/runtime-home history.
- Sweeper stops only expired `idle` + Docker `running` runtimes.
- Sweeper never auto-stops `active`, `pending`, or `failed` runtimes.
- `CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES` controls the idle timeout and defaults to 30.
- `npm run test:multitenancy` passes.
- `npm run typecheck` passes.
