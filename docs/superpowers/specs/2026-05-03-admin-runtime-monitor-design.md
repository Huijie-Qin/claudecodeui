# Admin Runtime Monitor Design

Date: 2026-05-03

## Summary

This design adds a first-version Admin runtime monitor for Docker-backed Claude sessions in the multitenant CloudCLI deployment.

The accepted scope is "B": observability, safe manual control, and automatic cleanup. System admins can see all Claude runtime containers across tenants, users, workspaces, and sessions; inspect business runtime state together with Docker state and live CPU/memory; and stop a selected runtime. A backend sweeper periodically stops long-idle Docker containers after a configurable timeout.

This version intentionally does not implement quota enforcement, admission control, force kill, container removal, alert routing, or per-tenant throttling. Those are future "C" hardening steps.

## Goals

- Give system admins a global view of Docker-backed session runtimes.
- Distinguish application runtime state from Docker process state.
- Show enough context to identify risky containers: tenant, user, workspace, provider session, container name, image, status, last used time, CPU, and memory.
- Allow a system admin to safely stop a runtime container.
- Automatically stop Docker containers that are already idle and past the configured idle timeout.
- Make the idle timeout configurable from `.env`, defaulting to 30 minutes.
- Keep the first version compatible with the existing `agent_session_runtime` table and `AgentSessionRuntimeManager`.

## Non-Goals

- Do not stop active runtimes automatically.
- Do not infer business activity from low CPU or low memory usage.
- Do not add force kill or container remove actions in the first version.
- Do not enforce tenant, user, workspace, or host-level concurrency quotas yet.
- Do not add disk usage, log collection, historical charts, or alert webhooks yet.
- Do not change the Docker execution isolation model defined by the Claude Docker session runtime design.

## Current State

The existing Docker runtime layer creates one long-lived container per Claude provider session. The container runs `sleep infinity`; Claude requests execute through a generated wrapper that calls `docker exec` into that container.

The existing persistence table `agent_session_runtime` already stores the business lifecycle:

- `runtime_id`
- `tenant_id`
- `workspace_id`
- `user_id`
- `provider`
- `provider_session_id`
- `container_name`
- `image`
- `workspace_host_path`
- `runtime_home_path`
- `status`
- `last_used_at`
- `updated_at`

`server/services/agent-session-runtime.js` already exposes:

- `prepareClaudeRuntime()` to create/resume a runtime and mark it `active`.
- `bindProviderSession()` to attach the runtime to Claude's provider session id.
- `markIdle()` to mark a runtime idle after normal completion or interruption.
- `markFailed()` to mark runtime failure.
- `stopRuntime()` to stop the Docker container and mark the runtime idle.

`server/routes/admin.js` already has system-admin-only endpoints for tenant and user management. `src/components/admin/AdminPanel.tsx` is the right entry point for an added `Runtime Monitor` tab.

## Runtime State Model

The monitor must display two different state dimensions:

```text
Business runtime state: agent_session_runtime.status
Docker process state: docker inspect / docker stats result
```

Docker `running` is not the same thing as "active" because the container is intentionally kept alive with `sleep infinity`. A container can be running while no Claude query is currently executing.

Business runtime states:

- `pending`: DB row exists, but the runtime has not fully entered a usable state.
- `active`: CloudCLI has prepared the runtime for an in-flight Claude query.
- `idle`: the last query completed, failed cleanly, or was interrupted and no query is currently using the runtime.
- `failed`: runtime setup or query execution failed.
- `deleted`: logical deletion; not shown in the normal monitor list.

Docker process states shown in the UI:

- `running`: Docker reports the container exists and is running.
- `exited`: Docker reports the container exists but is stopped.
- `missing`: DB row exists but Docker cannot find the container.
- `unknown`: Docker inspection failed for an unexpected reason.

Derived warning state:

- `active stale`: business status is `active`, but `last_used_at` or `updated_at` is older than a separate stale threshold. This is only a warning in the first version. It does not trigger automatic stop.

The automatic cleanup rule is deliberately narrow:

```text
agent_session_runtime.status == "idle"
AND docker.state == "running"
AND now - agent_session_runtime.last_used_at >= CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES
=> docker stop
```

Low CPU, low memory, or Docker `running` by itself must never be used to classify a runtime as idle.

## Backend Design

Add a runtime monitor surface to the existing Admin API.

Recommended endpoints:

```text
GET  /api/admin/runtimes
POST /api/admin/runtimes/:runtimeId/stop
GET  /api/admin/runtimes/summary
```

All endpoints reuse `requireSystemAdmin`.

`GET /api/admin/runtimes` returns a paged, filterable global list. Filters:

- `tenantId`
- `userId`
- `workspaceId`
- `provider`
- `status`
- `dockerState`
- `q` for fuzzy lookup across provider session id, runtime id, container name, tenant code/name, username, and workspace display name.

Each row should include DB context and Docker context:

```json
{
  "runtimeId": "runtime-uuid",
  "tenant": { "id": 1, "code": "default", "name": "Default" },
  "user": { "id": 1, "username": "admin" },
  "workspace": { "id": 12, "displayName": "cc-multitenant-default-01" },
  "provider": "claude",
  "providerSessionId": "claude-session-id",
  "businessStatus": "idle",
  "dockerState": "running",
  "containerName": "cloudcli-claude-t1-u1-w12-rabc",
  "image": "docker.io/cloudcliai/sandbox:claude-code",
  "lastUsedAt": "2026-05-03T10:00:00.000Z",
  "updatedAt": "2026-05-03T10:00:00.000Z",
  "cpuPercent": 0.15,
  "memoryUsageBytes": 134217728,
  "memoryLimitBytes": 2147483648,
  "idleAgeSeconds": 1900,
  "canStop": true
}
```

`GET /api/admin/runtimes/summary` returns counts for the dashboard header:

- total DB runtimes
- active runtimes
- idle running runtimes
- failed runtimes
- missing containers
- stale active warnings
- total live memory from Docker stats

`POST /api/admin/runtimes/:runtimeId/stop` calls the runtime manager's stop path. It must be idempotent: stopping an already stopped or missing container should not return a fatal error if the DB row exists. The response returns the refreshed row so the UI can update without a full reload.

## Docker Inspection Service

Extend the runtime manager or add a small companion service around Docker CLI calls.

Required operations:

- inspect one container by name.
- inspect many containers for list enrichment.
- get one-shot stats using `docker stats --no-stream --format json`.
- stop one container by runtime id.

The service should tolerate partial Docker failures. A single failed inspect should mark that row's Docker state as `unknown`; it should not fail the whole monitor list.

Stats collection should be best-effort. If stats fails because the container exited between inspect and stats, the row still renders with DB context and `dockerState` set to the latest known state.

## Sweeper Design

Add a backend-internal periodic sweeper that runs inside the CloudCLI server process.

Configuration:

```text
CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES=30
CLOUDCLI_RUNTIME_SWEEPER_INTERVAL_SECONDS=60
CLOUDCLI_RUNTIME_SWEEPER_ENABLED=true
```

Defaults:

- idle timeout: 30 minutes
- sweeper interval: 60 seconds
- sweeper enabled: true in Docker execution mode

The sweeper:

1. Lists DB runtimes where `status = 'idle'` and `last_used_at` is older than the timeout.
2. Inspects the corresponding Docker containers.
3. Stops only containers that are still `running`.
4. Leaves missing or already exited containers as DB `idle`.
5. Logs a compact structured event for each stop or inspect failure.

The sweeper must not stop `active`, `pending`, or `failed` runtimes automatically. A stale `active` runtime is a monitor warning only in this version.

## Frontend Design

Reuse the existing System Administration dialog and add tabs:

```text
Tenants & Users | Runtime Monitor
```

The Runtime Monitor tab should be a compact operational surface, not a marketing-style page.

Header summary cards:

- Total
- Active
- Idle running
- Failed / Unknown
- Live memory

Controls:

- refresh button
- status filter
- tenant filter
- user filter
- workspace filter
- search input

Table columns:

- Runtime / provider session
- Tenant
- User
- Workspace
- Business status
- Docker state
- CPU
- Memory
- Last used
- Action

Actions:

- `Stop` is shown when `dockerState = running`.
- Stop is disabled while the action is in flight.
- After Stop succeeds, update that row and refresh summary counts.

UX notes:

- Use status chips for business status and Docker state.
- Show `active stale` as a warning chip, not as an automatic cleanup action.
- Never show full `workspace_host_path` or `runtime_home_path` by default. Those are host filesystem details. If needed later, expose them behind an explicit admin-only details expansion.
- Keep table rows stable during refresh to avoid confusing operations during active incident handling.

## Error Handling

- Admin API returns `403` for non-system-admin users.
- Invalid filters return `400`.
- Runtime not found returns `404`.
- Docker unavailable returns `503` for stop requests, and best-effort `unknown` states for list requests.
- Stop requests are idempotent for existing DB rows: already stopped or missing containers return success with refreshed state.
- Sweeper errors are logged and do not crash the server.

## Audit And Safety

First-version stop actions should be logged at minimum:

- admin user id
- runtime id
- tenant id
- workspace id
- provider session id
- container name
- timestamp
- result

If an audit table is already introduced during implementation, use it. Otherwise, structured server logs are acceptable for V1 and an audit table can be a follow-up.

Manual Stop must preserve runtime home and normalized DB message history. The action stops the Docker process only; it does not delete the runtime row, workspace, message history, or persistent runtime home.

## Testing Strategy

Backend unit tests:

- parse runtime monitor env defaults and overrides.
- list DB runtimes with tenant/user/workspace joins.
- enrich rows with running, exited, missing, and unknown Docker states.
- parse Docker stats CPU and memory values.
- stop runtime is idempotent for running, exited, and missing containers.
- sweeper stops only `idle` + `running` + expired runtimes.
- sweeper ignores `active`, `pending`, `failed`, and non-expired `idle` runtimes.

Frontend tests:

- AdminPanel loads both tabs.
- Runtime Monitor renders summary cards and runtime rows.
- filters update the list request.
- Stop disables the row action, calls the API, and updates the row.
- host filesystem paths are not visible in the default table.

Manual verification:

- Start the app with `CLAUDE_EXECUTION_MODE=docker`.
- Create or resume a Claude session to create a running runtime.
- Confirm the Admin Runtime Monitor shows the runtime with business status and Docker state separately.
- Complete the query and confirm the runtime becomes `idle` while the Docker state remains `running`.
- Set a short `CLOUDCLI_RUNTIME_IDLE_TIMEOUT_MINUTES` value and verify the sweeper stops only the idle runtime.
- Start a second active query and confirm the sweeper does not stop it.
- Use the Stop button and verify the container stops, UI updates, and session history remains available.

## Future DFX Hardening

After this B version is stable, evolve to C with:

- per-tenant, per-user, and host-level concurrent runtime limits.
- admission control before starting new Docker runtimes.
- configurable CPU/memory budgets per tenant.
- force kill and remove actions with explicit confirmation.
- orphan container reconciliation on server startup.
- disk usage tracking for runtime homes and workspaces.
- alerting for stale active runtimes, high memory, high CPU, and repeated failures.
- background cleanup of deleted runtimes after a retention period.
- audit table for all admin runtime actions.
- optional egress control and network policy for runtime containers.

## Rollout Plan

1. Add backend monitor query and Docker inspection helpers.
2. Add Stop endpoint and idempotent stop behavior.
3. Add idle-only backend sweeper with `.env` configuration.
4. Add Runtime Monitor tab to the existing Admin dialog.
5. Add backend and frontend tests.
6. Verify locally with Docker mode enabled.

## Open Decisions Closed By This Spec

- First version uses solution B, not quota-enforcing solution C.
- Idle timeout defaults to 30 minutes and is configurable through `.env`.
- Manual runtime action is Stop only.
- Admin view is global across all tenants, users, workspaces, and sessions.
- V1 metrics include DB state, Docker state, CPU, and memory.
- Automatic cleanup stops only already-idle runtimes.
- Sweeper runs inside the CloudCLI backend process.
- UI placement is a `Runtime Monitor` tab in the existing Admin dialog.
