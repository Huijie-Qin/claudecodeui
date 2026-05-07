# Skills 与 Tools 目录实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to execute this plan.

**Goal:** 在主工作区新增 `Skills` 与 `Tools` 两个与 `Files` 平行的 Tab，并实现 workspace 级 skill 管理与 workspace/project 级 HTTP MCP server 管理。

**Architecture:** 新增薄 UI + API route 层，核心逻辑放在 backend service。Skills 使用 CloudCLI managed source + Claude runtime-visible materialized directory；Tools 使用 workspace `.mcp.json` 作为 runtime config，CloudCLI metadata 保存 probe status 与 draft。

**Tech Stack:** React 18, Vite, Tailwind CSS, lucide-react, Express, SQLite-backed workspace access, Node.js 22 test runner, `tsx --test`, existing workspace auth and tenant middleware.

---

## Canonical Inputs

- PRD: `docs/superpowers/prds/2026-05-05-skills-tools-market-prd.md`
- Product design: `docs/superpowers/specs/2026-05-04-skills-tools-market-design.md`
- Skills mockup: `scratch/designs/skills-tools-market/index.html`
- Tools mockup: `scratch/designs/skills-tools-market/tools.html`
- Notion umbrella issue: `https://www.notion.so/357880c33ce681a4a8eec842cd4a06d7`

## V1 Decisions To Preserve

- v1 only supports project/workspace-level skills. Do not show user-level skills.
- v1 only installs public GitHub HTTPS skills.
- Installed skills are pinned to a commit SHA.
- Third-party skill install never runs scripts, package managers, or dynamic code.
- Workspace enabled skills must be loadable by Claude Code CLI in Docker mode.
- Workspace skill reconcile failures fail closed before starting a new Agent turn.
- Already running Agent turns are not hot-updated or interrupted.
- Tools page does not expose Claude, Codex, Gemini, Cursor provider selection or provider fan-out.
- Tools page only manages current workspace project MCP config.
- Tools page only supports HTTP MCP servers. `http://` and `https://` are both valid.
- Stdio and SSE are visible as unsupported existing config but cannot be connected, tested, or edited from Tools v1.
- HTTP MCP values, including tokens, headers, and env-like values, are stored visibly for the current workspace.
- Missing token/header/env values can be saved only as `needs value` drafts.
- Needs-value drafts are not written to `.mcp.json` and are not runtime-loadable.
- JSON import must preview all `mcpServers` entries and classify each independently.
- Runtime probe must run from the effective Agent runtime context, including Docker-compatible context in Docker mode.
- Permissions use the existing workspace model: `owner`, `edit`, system admin can write; `view` can read only.

## Proposed Storage Contracts

### Workspace Skills

Managed source and metadata:

```text
<workspace>/.cloudcli/skills/metadata.json
<workspace>/.cloudcli/skills/sources/<skill-name>/SKILL.md
<workspace>/.cloudcli/skills/sources/<skill-name>/**
```

Runtime-visible materialized view:

```text
<workspace>/.claude/skills/<skill-name>/SKILL.md
<workspace>/.claude/skills/<skill-name>/**
```

`metadata.json` shape:

```json
{
  "version": 1,
  "skills": {
    "grill-me": {
      "name": "grill-me",
      "description": "Stress-test a plan by asking hard questions.",
      "enabled": true,
      "sourceType": "github",
      "sourceUrl": "https://github.com/example/repo/tree/main/skills/grill-me",
      "resolvedCommit": "0123456789abcdef0123456789abcdef01234567",
      "sourceSubdir": "skills/grill-me",
      "installedAt": "2026-05-05T00:00:00.000Z",
      "updatedAt": "2026-05-05T00:00:00.000Z",
      "managedBy": "cloudcli"
    }
  }
}
```

Unmanaged skills are detected from `<workspace>/.claude/skills/<name>` when no matching metadata entry exists.

### Workspace Tools

Runtime config:

```text
<workspace>/.mcp.json
```

CloudCLI metadata:

```text
<workspace>/.cloudcli/mcp/status.json
<workspace>/.cloudcli/mcp/drafts.json
```

`status.json` shape:

```json
{
  "version": 1,
  "servers": {
    "jira": {
      "name": "jira",
      "status": "healthy",
      "transport": "http",
      "url": "https://jira.example.com/mcp",
      "lastProbeAt": "2026-05-05T00:00:00.000Z",
      "latencyMs": 184,
      "runtimeMode": "docker",
      "probeContext": "docker-probe-container",
      "toolCount": 7,
      "tools": [
        {
          "name": "create_issue",
          "description": "Create an issue"
        }
      ]
    }
  }
}
```

`drafts.json` shape:

```json
{
  "version": 1,
  "drafts": {
    "github": {
      "name": "github",
      "kind": "needs_value",
      "operation": "create",
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "missingValues": ["Authorization"],
      "headers": {
        "Authorization": ""
      },
      "createdAt": "2026-05-05T00:00:00.000Z",
      "updatedAt": "2026-05-05T00:00:00.000Z"
    }
  }
}
```

## API Shape

Add route modules and mount them from `server/index.js`:

```text
GET    /api/workspaces/:workspaceId/skills
POST   /api/workspaces/:workspaceId/skills/preview
POST   /api/workspaces/:workspaceId/skills
PATCH  /api/workspaces/:workspaceId/skills/:name
DELETE /api/workspaces/:workspaceId/skills/:name
POST   /api/workspaces/:workspaceId/skills/reconcile

GET    /api/workspaces/:workspaceId/tools
POST   /api/workspaces/:workspaceId/tools/mcp/import-preview
POST   /api/workspaces/:workspaceId/tools/mcp/probe
POST   /api/workspaces/:workspaceId/tools/mcp
PATCH  /api/workspaces/:workspaceId/tools/mcp/:name
DELETE /api/workspaces/:workspaceId/tools/mcp/:name
```

Read routes require `canViewWorkspace`. Write routes require `canEditWorkspace` or system-admin equivalent through existing workspace authorization helpers.

## File Map

Backend files to add:

```text
server/routes/workspace-skills.js
server/routes/workspace-tools.js
server/services/workspace-skills.js
server/services/workspace-tools.js
server/services/workspace-mcp-probe.js
server/services/workspace-skills.test.js
server/services/workspace-tools.test.js
server/services/workspace-mcp-probe.test.js
server/routes/workspace-skills.test.js
server/routes/workspace-tools.test.js
```

Backend files to modify:

```text
server/index.js
server/claude-sdk.js
server/services/agent-session-runtime.js
```

Frontend files to add:

```text
src/components/skills-market/SkillsPanel.tsx
src/components/skills-market/SkillCard.tsx
src/components/skills-market/SkillDetailPanel.tsx
src/components/skills-market/InstallSkillDialog.tsx
src/components/skills-market/hooks/useWorkspaceSkills.ts
src/components/skills-market/utils/skillFormatting.ts
src/components/skills-market/utils/skillFormatting.test.ts
src/components/tools-market/ToolsPanel.tsx
src/components/tools-market/ToolCard.tsx
src/components/tools-market/ToolDetailPanel.tsx
src/components/tools-market/ConnectMcpDialog.tsx
src/components/tools-market/hooks/useWorkspaceTools.ts
src/components/tools-market/utils/toolFormatting.ts
src/components/tools-market/utils/toolFormatting.test.ts
```

Frontend files to modify:

```text
src/types/app.ts
src/components/main-content/view/MainContent.tsx
src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx
src/components/main-content/view/subcomponents/MainContentTitle.tsx
src/components/main-content/utils/mainContentAccess.ts
src/utils/api.js
src/i18n/locales/en/common.json
src/i18n/locales/zh/common.json
```

## Implementation Slices

### Slice 1: Add Built-In Tabs And Read-Only Shells

Purpose: Make `Skills` and `Tools` first-class workspace tabs without backend behavior.

Steps:

1. Add `'skills' | 'tools'` to `AppTab` in `src/types/app.ts`.
2. Add `SkillsPanel` and `ToolsPanel` placeholder components with loading, empty, error, and view-only read-only states.
3. Add `Skills` and `Tools` to `BASE_TABS` in `MainContentTabSwitcher.tsx`, placed after `Files` and before `Source Control`.
4. Render panels in `MainContent.tsx`.
5. Add tab titles in `MainContentTitle.tsx`.
6. Keep `skills` and `tools` readable for `view` role in `mainContentAccess.ts`.
7. Add i18n keys in English and Chinese.

Tests:

```text
src/components/main-content/utils/mainContentAccess.test.ts
src/components/skills-market/utils/skillFormatting.test.ts
src/components/tools-market/utils/toolFormatting.test.ts
```

Verification:

```bash
npx tsx --test src/components/main-content/utils/mainContentAccess.test.ts src/components/skills-market/utils/skillFormatting.test.ts src/components/tools-market/utils/toolFormatting.test.ts
npm run typecheck
```

Acceptance:

- `Skills` and `Tools` are visible next to `Files`.
- `view` users can open both tabs.
- No provider names appear in the Tools shell.

### Slice 2: Workspace Skills Inventory

Purpose: Show managed, unmanaged, plugin, and bundled skills in one inventory.

Steps:

1. Implement `server/services/workspace-skills.js` pure functions:
   - `readSkillsMetadata(workspacePath)`
   - `writeSkillsMetadata(workspacePath, metadata)`
   - `listManagedSkills(workspacePath)`
   - `listUnmanagedRuntimeSkills(workspacePath)`
   - `parseSkillManifest(skillDirectory)`
   - `listWorkspaceSkills(workspacePath, availableSystemSkills)`
2. Parse `SKILL.md` front matter when present and fallback to first heading plus first paragraph.
3. Return invalid skills with `status: "invalid"` and a parse error.
4. Implement `GET /api/workspaces/:workspaceId/skills`.
5. Use existing workspace path resolution and tenant authorization.
6. Wire `useWorkspaceSkills` to load and render the inventory.

Tests:

```text
server/services/workspace-skills.test.js
server/routes/workspace-skills.test.js
```

Verification:

```bash
node --test server/services/workspace-skills.test.js server/routes/workspace-skills.test.js
npm run typecheck
```

Acceptance:

- Managed skills appear as manageable.
- Unmanaged `.claude/skills` appear read-only.
- Invalid `SKILL.md` entries appear with parse errors.
- View-only users receive inventory but no write affordances.

### Slice 3: Skill Install Preview And Install

Purpose: Install public GitHub HTTPS skills safely into the current workspace.

Steps:

1. Add `previewGithubSkillInstall({ url, workspacePath })`.
2. Accept only `https://github.com/<owner>/<repo>` URLs, GitHub tree subdirectory URLs, and GitHub archive URLs.
3. Reject SSH, local paths, non-GitHub hosts, and private credential-shaped URLs.
4. Resolve the URL to a commit SHA.
5. Download into a temp directory under the workspace-safe temp root.
6. Validate exactly one selected skill directory unless the URL points to a specific skill subdirectory.
7. Return name, description, files, source URL, resolved commit, source subdir, and conflict state.
8. Add `installGithubSkill({ previewId, enable })`.
9. Copy source into `.cloudcli/skills/sources/<name>`.
10. Write metadata atomically.
11. Materialize enabled skills into `.claude/skills/<name>`.
12. Preserve old managed version if install fails.
13. Block unmanaged name conflicts.

Tests:

```text
server/services/workspace-skills.test.js
server/routes/workspace-skills.test.js
```

Verification:

```bash
node --test server/services/workspace-skills.test.js server/routes/workspace-skills.test.js
```

Acceptance:

- Public GitHub HTTPS preview succeeds with a pinned commit.
- Unsupported sources are rejected before download.
- Same-name unmanaged skill blocks install.
- Failed install does not change existing managed skill files or metadata.

### Slice 4: Skill Lifecycle And Reconcile

Purpose: Make enable, disable, reinstall, uninstall, and reconcile deterministic.

Steps:

1. Add `setSkillEnabled(workspacePath, name, enabled)`.
2. Add `uninstallManagedSkill(workspacePath, name)`.
3. Add `reinstallManagedSkill(workspacePath, name, previewId)`.
4. Add `reconcileManagedSkills(workspacePath)`.
5. On disable, remove only the materialized managed runtime directory.
6. On uninstall, delete source, metadata entry, and materialized copy.
7. On uninstall, leave no tombstone metadata.
8. On reconcile, materialize all enabled managed skills and remove materialized managed disabled skills.
9. On reconcile, never delete unmanaged runtime skills.
10. Add explicit UI copy: changes apply on next Agent turn or reload.

Tests:

```text
server/services/workspace-skills.test.js
server/routes/workspace-skills.test.js
```

Verification:

```bash
node --test server/services/workspace-skills.test.js server/routes/workspace-skills.test.js
```

Acceptance:

- Enable creates runtime-visible copy.
- Disable removes only the managed runtime-visible copy.
- Uninstall removes metadata completely.
- Reconcile is idempotent.
- Unmanaged skill directories survive reconcile.

### Slice 5: Agent Turn Preflight And Docker Visibility

Purpose: Ensure enabled workspace skills are loadable before Claude starts, including Docker mode.

Steps:

1. Call `reconcileManagedSkills(workspacePath)` in the Claude turn startup path before invoking the Claude SDK query.
2. If reconcile fails, return a structured error to the WebSocket writer and do not start a new Claude query.
3. Do not interrupt already running Agent turns.
4. Ensure the Docker runtime workspace bind mount includes both `.cloudcli/skills` and `.claude/skills`.
5. Add a Docker-mode test seam that asserts the runtime command sees `<workspace>/.claude/skills`.
6. Add logging for reconcile failures with workspace ID and skill name when known.

Tests:

```text
server/services/workspace-skills.test.js
server/services/agent-session-runtime.test.js
```

Verification:

```bash
node --test server/services/workspace-skills.test.js server/services/agent-session-runtime.test.js
```

Acceptance:

- New Claude turn blocks when reconcile fails.
- Existing turn behavior is unchanged.
- Docker runtime loads the same workspace `.claude/skills` tree.

### Slice 6: Workspace Tools Inventory

Purpose: Display built-in tools and workspace HTTP MCP config without provider fan-out.

Steps:

1. Implement `server/services/workspace-tools.js` pure functions:
   - `readWorkspaceMcpConfig(workspacePath)`
   - `writeWorkspaceMcpConfig(workspacePath, config)`
   - `readMcpStatus(workspacePath)`
   - `writeMcpStatus(workspacePath, status)`
   - `readMcpDrafts(workspacePath)`
   - `writeMcpDrafts(workspacePath, drafts)`
   - `listWorkspaceTools(workspacePath, permissionState)`
2. Parse `.mcp.json` `mcpServers`.
3. Classify HTTP servers as `connected`, `unverified`, `probe_failed`, or `draft_update_pending`.
4. Classify stdio/SSE/unknown transport as `unsupported`.
5. Include built-in tool permission state as read-only inventory.
6. Implement `GET /api/workspaces/:workspaceId/tools`.
7. Wire `useWorkspaceTools` and render list/detail UI.

Tests:

```text
server/services/workspace-tools.test.js
server/routes/workspace-tools.test.js
src/components/tools-market/utils/toolFormatting.test.ts
```

Verification:

```bash
node --test server/services/workspace-tools.test.js server/routes/workspace-tools.test.js
npx tsx --test src/components/tools-market/utils/toolFormatting.test.ts
```

Acceptance:

- Tools page contains built-in tools and MCP servers.
- Existing hand-written HTTP config appears as unverified and runtime-loadable.
- Unsupported stdio/SSE config appears read-only and unsupported.
- Claude/Codex/Gemini/Cursor provider selection is absent.

### Slice 7: Runtime-Context HTTP MCP Probe

Purpose: Test HTTP MCP servers from the same effective context as the Agent runtime.

Steps:

1. Implement `server/services/workspace-mcp-probe.js`.
2. Add `probeHttpMcpServer({ workspacePath, server, runtimeMode })`.
3. Use local backend context when runtime mode is local.
4. Use active Docker runtime container when one exists.
5. Use a short-lived Docker probe container when Docker mode has no active runtime container.
6. Send MCP initialize and tools-list requests.
7. Return phase-specific errors for static validation, network, initialize, auth, and tools-list.
8. Cache successful probe data in `.cloudcli/mcp/status.json`.
9. Preserve last successful tools list on later probe failure.

Tests:

```text
server/services/workspace-mcp-probe.test.js
server/services/workspace-tools.test.js
```

Verification:

```bash
node --test server/services/workspace-mcp-probe.test.js server/services/workspace-tools.test.js
```

Acceptance:

- Probe result includes latency, runtime mode, probe context, and discovered tool count.
- Docker-mode probe dispatch is covered through an injected runner.
- Probe failure does not modify `.mcp.json`.

### Slice 8: Connect, Edit, Delete, And JSON Import

Purpose: Complete workspace HTTP MCP server management.

Steps:

1. Implement `POST /tools/mcp/import-preview`.
2. Classify each `mcpServers` entry as:
   - `http_valid`
   - `needs_value`
   - `unsupported_transport`
   - `duplicate_name`
   - `invalid_json`
   - `invalid_url`
   - `invalid_name`
3. Let valid HTTP entries run independent probes.
4. Write successful entries to `.mcp.json`.
5. Save static-valid probe failures as drafts.
6. Save missing-value entries as `needs value` drafts.
7. Block invalid JSON, invalid URL, unsupported transport, and invalid name from draft persistence.
8. Implement create route for form mode.
9. Implement edit route with old-config preservation on failed probe.
10. Implement delete route that removes runtime config, probe cache, drafts, and saved values.
11. Add UI states for connected, unverified, probe failed runtime-loadable, needs value, update draft, unsupported, and blocked.

Tests:

```text
server/services/workspace-tools.test.js
server/routes/workspace-tools.test.js
src/components/tools-market/utils/toolFormatting.test.ts
```

Verification:

```bash
node --test server/services/workspace-tools.test.js server/routes/workspace-tools.test.js
npx tsx --test src/components/tools-market/utils/toolFormatting.test.ts
```

Acceptance:

- JSON import preview is never silent.
- Partial import reports connected, drafted, needs value, skipped, and blocked outcomes.
- Deleting a server fully removes related metadata.
- Missing values are saved only as non-runtime drafts.

### Slice 9: High-Fidelity UI Completion

Purpose: Bring production UI in line with the static design.

Steps:

1. Match list density, toolbar layout, right-side detail panel, status badges, and modal flow from the mockups.
2. Use existing CloudCLI color, spacing, and button conventions.
3. Use lucide icons for tab icons and action buttons.
4. Keep cards compact with radius at or under 8px.
5. Ensure no visible feature-instruction prose is used as app content.
6. Ensure long names, URLs, and token values wrap or truncate without overlap.
7. Add disabled tooltips for view-only write controls.
8. Add local/private endpoint Docker warning when URL host is localhost, loopback, RFC1918, or link-local.

Verification:

```bash
npm run dev
```

Manual QA:

```text
Open the local app.
Open a workspace.
Open Skills.
Open Tools.
Resize to mobile width.
Verify labels and URLs do not overlap.
Verify view-only controls are disabled when using a view-only workspace membership.
```

Acceptance:

- Skills and Tools match the high-fidelity review direction.
- Tools design includes Connect MCP Server form, JSON import preview, needs-value draft, and runtime probe states.
- No provider-specific interaction appears in Tools.

### Slice 10: Regression And Release Readiness

Purpose: Validate the feature against existing app behavior.

Steps:

1. Run focused backend tests.
2. Run focused frontend tests.
3. Run typecheck.
4. Run lint.
5. Manually test local mode.
6. Manually test Docker-mode skill visibility and MCP probe context.
7. Update PRD or implementation docs only if behavior changed during implementation.

Verification:

```bash
node --test server/services/workspace-skills.test.js server/services/workspace-tools.test.js server/services/workspace-mcp-probe.test.js server/routes/workspace-skills.test.js server/routes/workspace-tools.test.js
npx tsx --test src/components/main-content/utils/mainContentAccess.test.ts src/components/skills-market/utils/skillFormatting.test.ts src/components/tools-market/utils/toolFormatting.test.ts
npm run typecheck
npm run lint
```

Manual acceptance checklist:

```text
Skills tab exists next to Files.
Tools tab exists next to Files.
Workspace view role can read both pages.
Workspace view role cannot mutate skills or MCP config.
Workspace edit role can install, enable, disable, uninstall managed workspace skills.
Uninstall deletes metadata completely.
Unmanaged skills are visible and read-only.
Docker runtime can see enabled workspace skills.
Tools page shows built-in tool permission state read-only.
Tools page can connect an HTTP MCP server after real probe.
Tools page can save needs-value drafts without writing .mcp.json.
Tools page can delete connected server config and metadata completely.
Tools page never shows Claude/Codex/Gemini/Cursor provider selection.
```

## Computer Use Regression Test Matrix

All release-blocking test schemes below require two kinds of evidence:

1. Automated evidence from Node, `tsx`, typecheck, or lint where applicable.
2. Desktop regression evidence through `@电脑` in the running app. Each Computer Use pass must record the browser URL, selected workspace, user role, tool actions used, expected visible state, and observed result from the latest `get_app_state` output.

Before running any Computer Use regression:

```text
Start app with npm run dev.
Open Chrome to the local CloudCLI URL.
Sign in with a user that can access at least one owner/edit workspace and one view-only workspace.
Open the target workspace.
Call @电脑 get_app_state for Google Chrome before the first click in each test scheme.
Use @电脑 click, type_text, set_value, press_key, and scroll for the actual regression path.
Call @电脑 get_app_state after the final action and store the observed visible state in the test report.
```

### Test Scheme 1: Built-In Tab Navigation

Automated coverage:

```bash
npx tsx --test src/components/main-content/utils/mainContentAccess.test.ts
npm run typecheck
```

Computer Use regression:

```text
Open owner/edit workspace in Chrome.
Use @电脑 get_app_state and confirm the current app shell is visible.
Click the main content tab row.
Click Skills.
Confirm the page title reads Skills and the workspace name is visible.
Click Tools.
Confirm the page title reads Tools and the workspace name is visible.
Confirm Skills and Tools sit next to Files and before plugin tabs.
Confirm Runtime Monitor is not in the main content tab row.
```

Pass criteria:

```text
Skills and Tools are reachable without navigating through Settings.
Switching tabs does not reset the selected workspace.
No provider-specific Tools entry appears in the main tab row.
```

### Test Scheme 2: Workspace Permission Boundaries

Automated coverage:

```bash
node --test server/routes/workspace-skills.test.js server/routes/workspace-tools.test.js
npx tsx --test src/components/main-content/utils/mainContentAccess.test.ts
```

Computer Use regression:

```text
Open an owner/edit workspace.
Use @电脑 get_app_state.
Open Skills and confirm Install from GitHub is enabled.
Open Tools and confirm Connect MCP Server is enabled.
Switch to a view-only workspace or a view-only account.
Use @电脑 get_app_state.
Open Skills and confirm install, enable, disable, uninstall controls are disabled or absent.
Open Tools and confirm connect, edit, delete, import, and remove controls are disabled or absent.
Confirm read-only inventory remains visible.
```

Pass criteria:

```text
owner/edit can see management controls.
view can inspect Skills and Tools inventory.
view cannot write skill or MCP config.
Disabled controls explain that workspace edit permission is required.
```

### Test Scheme 3: Skills Inventory Classification

Automated coverage:

```bash
node --test server/services/workspace-skills.test.js server/routes/workspace-skills.test.js
```

Computer Use regression:

```text
Prepare a workspace with one CloudCLI managed skill, one unmanaged .claude/skills entry, and one invalid SKILL.md.
Open Skills.
Use @电脑 get_app_state.
Search for the managed skill name.
Confirm it shows Workspace, managed, and enabled or disabled state.
Search for the unmanaged skill name.
Confirm it shows unmanaged and read-only.
Search for the invalid skill name.
Confirm it shows invalid with a parse error.
Open each detail panel and confirm path, source, status, and available actions match its classification.
```

Pass criteria:

```text
Managed, unmanaged, bundled/plugin, and invalid skills are visually distinct.
Only managed workspace skills expose lifecycle actions.
Invalid skills are visible instead of silently hidden.
```

### Test Scheme 4: GitHub Skill Preview And Install

Automated coverage:

```bash
node --test server/services/workspace-skills.test.js server/routes/workspace-skills.test.js
```

Computer Use regression:

```text
Open Skills in an owner/edit workspace.
Click Install from GitHub.
Type a public GitHub HTTPS skill URL.
Click Preview.
Use @电脑 get_app_state.
Confirm preview shows name, description, file list, source URL, resolved commit, and risk message.
Click Install and enable.
Confirm success state appears.
Confirm the skill appears in the Workspace group as enabled.
Open detail panel and confirm pinned commit is visible.
Repeat with an SSH URL and confirm the form rejects it before preview.
Repeat with a name that conflicts with unmanaged .claude/skills and confirm install is blocked.
```

Pass criteria:

```text
GitHub HTTPS install succeeds only after preview.
Unsupported source URLs are rejected.
Pinned commit is visible after install.
Unmanaged name conflict blocks overwrite.
```

### Test Scheme 5: Skill Enable, Disable, Reinstall, Uninstall, And Reconcile

Automated coverage:

```bash
node --test server/services/workspace-skills.test.js server/routes/workspace-skills.test.js
```

Computer Use regression:

```text
Open Skills in an owner/edit workspace with an installed managed skill.
Use @电脑 get_app_state.
Open the skill detail panel.
Click Disable.
Confirm the list state changes to disabled and the page says the change applies on next Agent turn or reload.
Click Enable.
Confirm the list state changes to enabled.
Click reinstall or install same name again.
Confirm overwrite preview shows old source, old commit, new source, new commit, and file changes.
Cancel reinstall and confirm current skill remains unchanged.
Open uninstall confirmation.
Confirm warning says source, runtime copy, and metadata will be removed.
Confirm uninstall.
Confirm the skill disappears from managed inventory.
Refresh the page with @电脑 press_key Cmd+R.
Confirm no tombstone or deleted metadata entry is visible.
```

Pass criteria:

```text
Enable and disable affect managed skills only.
Reinstall requires explicit overwrite preview.
Uninstall removes metadata completely.
The UI never deletes unmanaged skill entries.
```

### Test Scheme 6: Agent Turn Preflight And Docker Skill Visibility

Automated coverage:

```bash
node --test server/services/workspace-skills.test.js server/services/agent-session-runtime.test.js
```

Computer Use regression:

```text
Open a Docker-enabled workspace with one enabled managed skill.
Open Skills and confirm the skill is enabled.
Open Chat.
Start a new Agent turn with a prompt that should trigger the installed skill.
Use @电脑 get_app_state while the turn starts.
Confirm no reconcile error appears for a healthy skill tree.
Introduce a controlled reconcile failure in a test workspace fixture.
Start a new Agent turn.
Confirm the turn is blocked before model execution and the visible error names skill reconcile.
Remove the fixture failure.
Start a new Agent turn again.
Confirm the turn starts normally.
```

Pass criteria:

```text
Healthy enabled workspace skills are visible in Docker mode.
Reconcile failure blocks only a new turn.
Existing running turn is not interrupted by later skill changes.
The user sees a recoverable error instead of a silent runtime mismatch.
```

### Test Scheme 7: Tools Inventory And Unsupported Config

Automated coverage:

```bash
node --test server/services/workspace-tools.test.js server/routes/workspace-tools.test.js
npx tsx --test src/components/tools-market/utils/toolFormatting.test.ts
```

Computer Use regression:

```text
Prepare .mcp.json with one HTTP server, one stdio server, and one SSE server.
Open Tools.
Use @电脑 get_app_state.
Confirm built-in tools are listed with allowed, prompt required, or blocked state.
Confirm the HTTP server appears as existing HTTP config or connected depending on status cache.
Confirm stdio and SSE servers appear as unsupported read-only.
Open unsupported server detail.
Confirm Test connection and Edit config are unavailable.
Confirm Remove unsupported config is available only for owner/edit.
Confirm no Claude, Codex, Gemini, or Cursor provider selection exists.
```

Pass criteria:

```text
Built-in tool inventory is visible but not editable inline.
Unsupported MCP configs are visible and removable with confirmation.
Unsupported configs are not tested or edited from Tools v1.
Provider fan-out is absent.
```

### Test Scheme 8: Connect HTTP MCP Server With Runtime Probe

Automated coverage:

```bash
node --test server/services/workspace-mcp-probe.test.js server/services/workspace-tools.test.js server/routes/workspace-tools.test.js
```

Computer Use regression:

```text
Start a known test HTTP MCP server reachable from the selected runtime mode.
Open Tools in owner/edit workspace.
Click Connect MCP Server.
Confirm transport is fixed to HTTP and scope is current workspace project config.
Type server name, http or https URL, headers, and visible token value.
Click Test connection.
Use @电脑 get_app_state.
Confirm probe phases show validation, initialize, and tools discovery.
Click Connect server after successful probe.
Confirm the server appears as connected or healthy with last tested time, runtime mode, latency, and discovered tool count.
Open detail panel and confirm stored header/token values are visible to the workspace.
```

Pass criteria:

```text
HTTP and HTTPS endpoints can be tested.
Probe is required before writing runtime config for new managed servers.
Successful probe writes .mcp.json and status metadata.
Saved values are visible, not masked, for v1.
```

### Test Scheme 9: JSON Import Preview, Partial Import, And Needs-Value Draft

Automated coverage:

```bash
node --test server/services/workspace-tools.test.js server/routes/workspace-tools.test.js
npx tsx --test src/components/tools-market/utils/toolFormatting.test.ts
```

Computer Use regression:

```text
Open Tools.
Click Connect MCP Server.
Switch to JSON import.
Paste JSON containing one valid HTTP server, one HTTP server missing Authorization, one stdio server, one invalid URL, and one duplicate name.
Click Preview import.
Use @电脑 get_app_state.
Confirm each entry shows its independent classification.
Select the valid HTTP server and the needs-value HTTP server.
Run import.
Confirm valid HTTP server probes and connects.
Confirm missing Authorization entry saves as needs value draft.
Confirm stdio, invalid URL, and duplicate entries are blocked or skipped without writing runtime config.
Open Tools list and confirm partial import summary includes connected, needs value, skipped, and blocked outcomes.
```

Pass criteria:

```text
Import is preview-first and never silent.
Valid HTTP entries can connect independently.
Needs-value entries are saved only as drafts.
Unsupported and invalid entries do not become runtime-loadable config.
```

### Test Scheme 10: Existing HTTP Config Edit, Probe Failure, And Delete Cleanup

Automated coverage:

```bash
node --test server/services/workspace-tools.test.js server/routes/workspace-tools.test.js
```

Computer Use regression:

```text
Prepare .mcp.json with an existing hand-written HTTP server and no status cache.
Open Tools.
Use @电脑 get_app_state.
Confirm the server appears as unverified but runtime-loadable.
Click Test connection with a failing endpoint.
Confirm state becomes probe failed / runtime-loadable and .mcp.json is not removed.
Open Edit config and change URL to another failing endpoint.
Click Test connection.
Confirm old runtime config remains active and the failed new config is saved as update draft.
Change URL to a passing endpoint and connect.
Confirm runtime config is replaced only after successful probe.
Click Delete server.
Confirm the warning mentions config, probe cache, drafts, and saved values.
Confirm delete.
Refresh with @电脑 press_key Cmd+R.
Confirm server, status, draft, and saved values are no longer visible.
```

Pass criteria:

```text
Existing HTTP config is visible before CloudCLI probe.
Failed probe does not remove runtime-loadable config.
Failed edit does not overwrite old config.
Delete cleans runtime config and all CloudCLI metadata.
```

### Test Scheme 11: Responsive And Visual Regression

Automated coverage:

```bash
npm run typecheck
npm run lint
```

Computer Use regression:

```text
Open Skills at desktop width.
Use @电脑 get_app_state and confirm no text overlap in cards, toolbar, and detail panel.
Resize Chrome to a narrow mobile-like width.
Open Skills and confirm tabs scroll horizontally and controls remain reachable.
Open Tools at desktop width.
Confirm long URLs and visible token values truncate or wrap without overlapping actions.
Resize Chrome to a narrow mobile-like width.
Open Connect MCP Server and JSON import preview.
Confirm modal content scrolls and primary actions remain reachable.
Switch browser zoom to 125 percent.
Confirm tab labels, buttons, and badges remain readable.
```

Pass criteria:

```text
No clipped labels, overlapping buttons, or hidden primary actions.
Mobile width keeps Skills and Tools usable.
Visible token/header values do not break layout.
```

### Test Scheme 12: Settings MCP Coexistence

Automated coverage:

```bash
node --test server/modules/providers/tests/mcp.test.ts server/services/workspace-tools.test.js
```

Computer Use regression:

```text
Open Tools and confirm it manages only current workspace HTTP MCP servers.
Open Settings > Agents > MCP.
Use @电脑 get_app_state.
Confirm existing provider-specific advanced MCP settings remain reachable there.
Return to Tools.
Confirm Tools still does not expose provider fan-out, user scope, local scope, stdio connect, or SSE connect.
Create or remove a workspace HTTP MCP server from Tools.
Return to Settings > Agents > MCP and confirm provider-specific Settings UI still loads.
```

Pass criteria:

```text
Tools is a workspace inventory and HTTP connection surface.
Settings remains the advanced provider-specific MCP surface.
The new Tools flow does not regress existing provider MCP settings.
```

## Executed Computer Use Regression Evidence

Date: 2026-05-05.

Browser URL: `http://localhost:5176/`.

Workspace: `myworkspace3`.

Role: workspace user with edit access.

Regression coverage completed in Chrome through `@电脑`:

1. Built-in tab navigation: confirmed `Chat`, `Shell`, `Files`, `Skills`, `Tools`, and `Source Control` are visible in the main content tab row. Confirmed `Skills` and `Tools` are page-level tabs, and `Runtime Monitor` is not part of this row.
2. Tools empty/default inventory: opened `Tools` and confirmed the title, workspace name, built-in tools, and summary counters: total 4, HTTP MCP 0, blocked 0. Confirmed no Claude, Codex, Gemini, Cursor, provider fan-out, stdio connect, or SSE connect flow is present.
3. Connect HTTP MCP Server modal: opened the connect modal and confirmed HTTP-only fields for server name, HTTP URL, headers, JSON import, probe, save, and preview import.
4. Real HTTP MCP probe: started a local test HTTP MCP server at `http://127.0.0.1:3333/mcp`, entered server `codex-http-ok` with a visible `Authorization=Bearer visible-secret` header, clicked probe, and observed healthy probe state at `tools_list` phase with 1 discovered tool.
5. Save and detail view: saved `codex-http-ok`, confirmed summary counters changed to total 5 and HTTP MCP 1, opened detail, and observed URL, visible header value, last checked time, probe phase, and discovered tool `codex_test_tool`.
6. Delete cleanup: deleted `codex-http-ok`, confirmed browser confirmation, and observed the Tools list returned to total 4, HTTP MCP 0, blocked 0. Follow-up filesystem check found no `.mcp.json`, status, or draft metadata left in the tested workspace.
7. Needs-value draft: saved draft `codex-needs-url` without URL, confirmed it appeared as `Needs value`, opened detail, observed missing value `url`, deleted it, and confirmed the list returned to the default counters.
8. JSON import preview: pasted mixed import JSON containing one ready HTTP entry, one unsupported stdio entry, and one missing-value HTTP entry. Confirmed preview summary showed 3 entries, 1 ready, 1 needs values, 1 unsupported, and 0 invalid. Confirmed unsupported stdio was shown as unsupported instead of becoming connectable.
9. Skills default inventory: opened `Skills` and confirmed title, workspace name, zero counters, and empty state text for no installed project-level skills.

## Suggested Issue Breakdown

1. Add Skills/Tools tabs and read-only UI shells.
2. Implement workspace skills inventory and lifecycle backend.
3. Implement GitHub skill preview/install/reinstall with commit pinning.
4. Add skill reconcile preflight and Docker runtime visibility.
5. Implement workspace tools inventory and HTTP MCP config model.
6. Implement runtime-context HTTP MCP probe.
7. Implement Connect MCP Server, edit, delete, and JSON import flows.
8. Complete high-fidelity frontend UI and QA.

## Risks And Mitigations

- Risk: Skill install accidentally overwrites unmanaged `.claude/skills` content.
  Mitigation: Treat unmanaged name conflict as hard block.
- Risk: Disabled managed skills remain visible to Claude.
  Mitigation: Reconcile before each new Agent turn and fail closed on reconcile error.
- Risk: Docker runtime sees different skills than host UI.
  Mitigation: Materialize into workspace-mounted `.claude/skills` and add Docker visibility tests.
- Risk: Probe success from host does not mean probe success from Docker.
  Mitigation: Dispatch probe through effective runtime context.
- Risk: Tools page becomes a second provider MCP settings page.
  Mitigation: No provider selection, no user/local scope, no provider fan-out in v1.
- Risk: Visible token storage surprises users.
  Mitigation: UI labels values as workspace-visible and follows the explicit v1 product rule.

## Rollback Plan

1. Hide `Skills` and `Tools` tabs behind a feature flag if release risk appears late.
2. Leave existing Settings MCP flows untouched.
3. Do not migrate existing `.mcp.json`; only read and classify it.
4. Managed skills are isolated under `.cloudcli/skills`, so removing the feature leaves unmanaged `.claude/skills` untouched.
5. If reconcile preflight causes a production issue, disable only the preflight call and keep Skills inventory read-only until fixed.
