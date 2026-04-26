# Claude Docker Session Runtime Design

Date: 2026-04-26

## Summary

This design moves Claude Code CLI execution for multitenant chat sessions into Docker containers. The production model is:

- A container is a disposable execution process.
- A session runtime home is persistent and mounted into containers.
- Normalized message history is persisted in the application database and is the UI history source of truth.

The target security property is that a Claude session for one tenant/user/workspace can only see the selected workspace and its own session runtime home, even if the model asks tools to traverse parent directories or inspect local history.

The first implementation scope is Claude only. Codex, Gemini, and Cursor can continue using the current local execution path until they receive equivalent runtime support.

## Goals

- Run each Claude provider session in an isolated Docker container.
- Mount only the current authorized workspace into the container.
- Keep session resume working after containers are stopped or removed.
- Persist UI message history in the database instead of relying on Claude JSONL files.
- Keep a `local` execution fallback for development and rollback.
- Avoid mounting host-level `~/.claude`, application source directories, auth databases, Docker socket, or other tenant workspaces.

## Non-Goals

- Full provider parity for Codex, Gemini, and Cursor in the first version.
- Strong network egress filtering in the first version.
- Replacing Claude Code CLI session persistence. Claude can still use its own JSONL files inside the session runtime home for resume.
- Per-message ephemeral containers. This design uses one long-lived runtime per provider session.

## Current State

The WebSocket command handler authorizes the requested tenant workspace and injects the resolved workspace path into `data.options.cwd` and `data.options.projectPath`.

Claude execution then maps `cwd` into SDK options and invokes Claude Code through `pathToClaudeCodeExecutable`. In local mode, this means Claude Code runs as a host process with the same operating system permissions as the CloudCLI server.

That is not a reliable multitenancy boundary. Even if workspaces are laid out under tenant-specific directories, a same-user host process can often read sibling directories, application config, local provider history, and other sensitive host files.

## Recommended Architecture

```text
Frontend
  -> WebSocket command
    -> Tenant and workspace authorization
      -> AgentSessionRuntimeService
        -> create or resolve session runtime row
        -> create persistent runtime home
        -> create or start Docker container
        -> create Claude wrapper executable
      -> Claude SDK
        -> cwd = /workspace
        -> pathToClaudeCodeExecutable = wrapper path
        -> wrapper executes docker exec into the session container
      -> Stream normalized messages
        -> persist normalized messages to DB
        -> send messages to WebSocket client
```

The runtime identity is:

```text
tenant_id + user_id + workspace_id + provider + provider_session_id
```

For a new session, `provider_session_id` is not known yet. The server creates a `runtime_id` first, then writes `provider_session_id` into the runtime row when Claude emits the real session id.

## Filesystem Model

Runtime state is stored outside the container:

```text
~/.cloudcli/runtimes/claude/
  tenant-<tenant_id>/
    user-<user_id>/
      workspace-<workspace_id>/
        runtime-<runtime_id>/
          home/
            .claude/
              projects/
                -workspace/
                  <provider_session_id>.jsonl
          wrapper/
            claude-docker-wrapper
```

The container sees:

```text
/workspace       current workspace bind mount
/home/cloudcli   session runtime home bind mount
/tmp             tmpfs
```

The container must not see:

- Host `~/.claude`
- Host application repository
- Other tenant workspaces
- Auth or multitenancy databases
- Host Docker socket
- Host SSH keys or provider global config

## Docker Runtime

The container is created per Claude provider session and may be stopped or removed after an idle timeout. The runtime home remains on disk and is reused on resume.

Example container creation:

```bash
docker run -d \
  --name cloudcli-claude-t3-u1-w3-r<runtime_id> \
  --user 1000:1000 \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory 2g \
  --cpus 2 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,size=512m \
  --mount type=bind,src=<workspace_host_path>,dst=/workspace,rw \
  --mount type=bind,src=<runtime_home_path>,dst=/home/cloudcli,rw \
  -e HOME=/home/cloudcli \
  -w /workspace \
  <claude_image> \
  sleep infinity
```

The first version should keep outbound network access enabled because Claude Code needs access to Anthropic or the configured provider endpoint. A later hardening pass can add an egress proxy or Docker network policy.

The image should provide a non-root runtime user or otherwise support the configured UID/GID. The mounted workspace and runtime home should be writable by that UID/GID. If the host user id differs, the runtime service should choose the current host UID/GID rather than hardcoding `1000:1000`.

## Claude SDK Integration

The current local mode keeps:

```js
sdkOptions.cwd = workspace.path;
sdkOptions.pathToClaudeCodeExecutable = process.env.CLAUDE_CLI_PATH || 'claude';
```

Docker mode changes this to:

```js
sdkOptions.cwd = '/workspace';
sdkOptions.pathToClaudeCodeExecutable = '<runtime-wrapper-dir>/claude-docker-wrapper';
```

The wrapper is generated per runtime because it embeds the container name:

```bash
#!/usr/bin/env bash
exec docker exec -i \
  -w /workspace \
  -e HOME=/home/cloudcli \
  -e ANTHROPIC_API_KEY \
  -e ANTHROPIC_BASE_URL \
  -e ANTHROPIC_AUTH_TOKEN \
  <container_name> \
  claude "$@"
```

The wrapper should only forward allowlisted environment variables. It should not forward the full host process environment.

## Credentials And Provider Config

Do not mount host `~/.claude`.

The first version should support API-key based Claude authentication by forwarding an allowlist of environment variables:

```text
ANTHROPIC_API_KEY
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
```

If OAuth-based Claude credentials are required, add a separate credential materialization step that writes the minimal required credential files into the session runtime home. That step must be scoped by user and provider account. It must not bind mount the host global Claude config directory.

Project-level MCP config should be read from the mounted workspace if the user created it there. User-level or host-global MCP config should not be imported into the container by default.

## Database Model

Add `t_agent_session_runtime`:

```text
id integer primary key
runtime_id text not null unique
tenant_id integer not null
user_id integer not null
workspace_id integer not null
provider text not null
provider_session_id text null
container_name text not null
image text not null
workspace_host_path text not null
runtime_home_path text not null
status text not null
created_at text not null
last_used_at text not null
```

Recommended indexes:

```text
unique(tenant_id, user_id, workspace_id, provider, provider_session_id) where provider_session_id is not null
index(tenant_id, user_id, workspace_id, provider)
index(last_used_at)
```

Add `t_agent_session_message`:

```text
id integer primary key
tenant_id integer not null
user_id integer not null
workspace_id integer not null
runtime_id text not null
provider text not null
provider_session_id text null
message_id text not null
kind text not null
role text null
content_text text null
normalized_json text not null
provider_timestamp text null
sequence integer not null
created_at text not null
```

Recommended uniqueness:

```text
unique(runtime_id, message_id)
unique(tenant_id, user_id, workspace_id, provider, provider_session_id, message_id) where provider_session_id is not null
```

The existing session ownership table remains useful for sidebar session indexing and access control. The new runtime table binds a session to its container runtime home, while the message table stores normalized UI history.

## Message History Strategy

UI history is DB-first:

```text
GET /api/sessions/:sessionId/messages
  -> authorize tenant, user, workspace, provider session ownership
  -> read t_agent_session_message
  -> return normalized messages with pagination
```

Claude JSONL remains a provider runtime artifact used by Claude CLI to resume. It is not the UI history source of truth for Docker sessions.

For backwards compatibility:

```text
If DB messages exist:
  return DB messages.
Else if session is legacy local Claude:
  read old Claude JSONL and optionally backfill DB.
Else:
  return an empty message list.
```

During active streaming, every normalized message emitted by the provider should be persisted before or at the same time it is sent to the client. Duplicate message ids should be ignored or updated idempotently.

## New Session Flow

```text
1. User sends a Claude command over WebSocket.
2. Server authenticates the tenant and verifies edit access to workspace_id.
3. Server creates a pending runtime row with a generated runtime_id.
4. Server creates runtime_home_path and wrapper directory.
5. Server starts a Docker container with only /workspace and /home/cloudcli mounted.
6. Server invokes Claude SDK with cwd=/workspace and wrapper executable.
7. Claude emits provider_session_id.
8. Server updates runtime.provider_session_id.
9. Server records provider session ownership.
10. Server persists normalized messages to DB and streams them to the browser.
11. On completion, runtime status becomes idle and last_used_at is updated.
```

## Resume Flow

```text
1. User opens a historical session.
2. UI fetches messages from t_agent_session_message.
3. User sends a new query.
4. Server resolves runtime by tenant/user/workspace/provider/provider_session_id.
5. If the container is missing or stopped, server recreates it and mounts the same runtime_home_path.
6. Claude CLI sees prior JSONL under /home/cloudcli and resumes normally.
7. New normalized messages are appended to DB and streamed to the UI.
```

## Runtime Cleanup

Containers can be stopped or removed after an idle TTL:

```text
status = idle
last_used_at older than TTL
docker rm -f <container_name>
```

Runtime home directories should not be removed by idle cleanup. Deleting a session can either:

- Soft-delete the runtime and messages, or
- Remove DB rows and runtime home after an explicit user deletion confirmation.

Because runtime home contains provider history and potentially credentials, deletion must be handled as sensitive local data deletion.

## Configuration

Add environment flags:

```text
CLAUDE_EXECUTION_MODE=local|docker
CLOUDCLI_CLAUDE_DOCKER_IMAGE=docker.io/cloudcliai/sandbox:claude-code
CLOUDCLI_RUNTIME_ROOT=~/.cloudcli/runtimes
CLOUDCLI_CONTAINER_IDLE_TTL_SECONDS=1800
CLOUDCLI_DOCKER_MEMORY=2g
CLOUDCLI_DOCKER_CPUS=2
```

Default should stay `local` until Docker mode is verified. Production multitenant deployments should set `CLAUDE_EXECUTION_MODE=docker`.

## Error Handling

- If Docker is unavailable, return a clear provider error and do not fall back to local execution in production mode.
- If container creation fails, mark runtime as `failed` and stream an error message.
- If provider session id is never emitted, keep the runtime row with `provider_session_id = null` for diagnostics and cleanup.
- If DB message persistence fails, stop the provider stream and surface an error. UI history must not silently diverge from runtime history.
- If runtime home is missing during resume, return a recoverable error and do not start a fresh empty container for an existing session unless explicitly requested.

## Security Notes

Docker isolation reduces host filesystem exposure but is not a complete sandbox by itself. Hardening should include:

- No Docker socket mount.
- No privileged containers.
- Run containers as a non-root UID/GID.
- Drop all Linux capabilities by default.
- `no-new-privileges`.
- Read-only root filesystem.
- Explicit bind mounts only.
- Separate runtime home per provider session.
- Allowlisted environment variables only.
- Realpath boundary checks before mounting workspace paths.
- Optional future egress proxy for outbound network filtering.

The application server still needs strict API-level authorization and realpath checks for file, git, shell, and workspace routes. Docker runtime isolation is a second boundary, not a replacement for server-side authorization.

## Testing Plan

Unit tests:

- Runtime id and container name generation are deterministic and safe.
- Runtime path builder stays under `CLOUDCLI_RUNTIME_ROOT`.
- Docker command builder includes only the selected workspace and runtime home mounts.
- Docker command builder rejects missing or non-realpath workspace paths.
- Message persistence is idempotent by `runtime_id + message_id`.
- Session history endpoint prefers DB messages over provider JSONL.

Integration tests:

- New Docker-mode Claude session creates runtime row, runtime home, wrapper, and message rows.
- Session-created event updates `provider_session_id` in runtime and ownership tables.
- Removed container can be recreated for resume with the same runtime home.
- A Docker-mode session cannot read a sibling tenant workspace path from inside the container.
- Legacy local session history still reads through the fallback path.

Manual verification:

- Start Docker-mode server.
- Create workspace under tenant A and tenant B.
- Ask Claude in tenant A to list parent directories; it should only see container filesystem and mounted workspace.
- Stop/remove the session container.
- Resume the same session and confirm prior messages are visible in UI and Claude can continue the session.

## Rollout

1. Add DB message persistence while still in local mode.
2. Add runtime DB table and runtime service without switching execution.
3. Add Docker wrapper execution behind `CLAUDE_EXECUTION_MODE=docker`.
4. Verify Docker mode in development.
5. Enable Docker mode for production multitenant deployments.
6. Later hardening: network egress allowlist, credential materialization, runtime admin UI, retention policies.
