# Claude Docker Session Runtime Implementation Plan

Date: 2026-04-26

## Objective

Implement the Docker-backed Claude session runtime described in
`docs/superpowers/specs/2026-04-26-claude-docker-session-runtime-design.md`.

The first implementation keeps `CLAUDE_EXECUTION_MODE=local` as the default and
enables Docker execution only when explicitly configured.

## Scope

- Add persistent runtime and normalized-message tables.
- Add database helpers for runtime lifecycle and message history.
- Add a Claude runtime service that prepares local or Docker execution.
- Generate a per-runtime Docker wrapper that only enters the selected session
  container.
- Persist normalized Claude messages while streaming.
- Make the unified message-history endpoint read from the DB first and preserve
  the legacy provider fallback.
- Verify through automated tests and a Computer Use browser check.

## Implementation Steps

1. Database persistence
   - Extend the multitenancy schema with `agent_session_runtime` and
     `agent_session_messages`.
   - Add DB APIs for creating pending runtimes, binding provider session ids,
     updating runtime status, and idempotently storing normalized messages.
   - Add tests proving message persistence is idempotent and tenant/user scoped.

2. Runtime service
   - Add pure helpers for execution mode, runtime path building, container name
     sanitization, Docker run args, and wrapper script generation.
   - Add a runtime manager that creates runtime homes/wrapper dirs and starts or
     reuses containers in Docker mode.
   - Keep local mode behavior unchanged.
   - Add tests with injected filesystem and Docker runners.

3. Claude SDK integration
   - Prepare runtime before creating SDK options.
   - In Docker mode, set `cwd=/workspace` and
     `pathToClaudeCodeExecutable=<runtime wrapper>`.
   - Disable host user/local settings sources in Docker mode while preserving
     project settings.
   - Bind the runtime row once Claude emits the real provider session id.
   - Persist normalized messages before sending them to the WebSocket.
   - Mark runtime idle or failed on completion/error.

4. History endpoint
   - For authorized sessions, return DB messages first.
   - Fall back to legacy provider JSONL only when no DB messages exist.

5. Verification
   - Run focused node tests for DB, runtime service, and history behavior.
   - Run the existing multitenancy test script.
   - Use Computer Use against the local app to verify tenant/session UI still
     loads after the runtime changes.

## Acceptance Criteria

- `CLAUDE_EXECUTION_MODE=local` remains backward compatible.
- Docker mode never mounts host `~/.claude` or sibling workspace directories.
- A resumed session resolves the same runtime home by provider session id.
- UI message history is returned from the database when persisted rows exist.
- Duplicate streamed messages do not duplicate history rows.
- Automated tests pass for the touched behavior.
