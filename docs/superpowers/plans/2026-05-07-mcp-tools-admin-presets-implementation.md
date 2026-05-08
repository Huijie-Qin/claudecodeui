# MCP Tools Admin Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current user-managed Skills/Tools workspace tabs with a focused MCP Tools experience where users install Admin-published internal MCP Server presets into the current workspace with one click.

**Architecture:** Admin owns the MCP preset catalog in the multitenancy database. Workspace users only see published presets plus their installed workspace bindings; install writes the Admin-managed MCP config snapshot to the workspace `.mcp.json`, which is visible inside Docker runtimes at `/workspace/.mcp.json` through the existing workspace bind mount. Existing Settings MCP management is retired from the user-facing settings surface and its configuration capability moves into Admin MCP Server Presets.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind CSS, lucide-react, Express, better-sqlite3, Node.js 22 test runner, existing tenant/workspace authorization, existing Docker Claude runtime manager, existing workspace `.mcp.json` helpers.

---

## Product Decisions To Preserve

- Main workspace top tabs become exactly `Chat`, `Files`, `MCP Tools`.
- Remove main workspace `Skills`, generic `Tools`, `Shell`, `Source Control`, `Tasks`, `preview`, and plugin tabs from the visible tab switcher.
- MCP Servers shown to users are self-developed internal servers, published by Admin.
- Users do not configure credentials, tokens, URLs, headers, env vars, or placeholders during install.
- Clicking `Install` installs directly from the card. No modal, review step, GitHub token step, or confirmation page.
- User MCP Tools page summary only needs `Available` and `Installed`.
- User MCP Tools filters only need `All`, `Available`, and `Installed`.
- Docker mode does not need a new file-level mount for MCP config. The workspace root is already bind-mounted to `/workspace`; writing `<workspace>/.mcp.json` makes it visible as `/workspace/.mcp.json`.
- Existing Agent turns are not hot-updated. Newly installed MCP servers apply on the next Agent turn/session reload.
- Mobile layout is out of scope.

## Current Code To Reuse

- Workspace `.mcp.json` read/write/status helpers: `server/services/workspace-tools.js`
- Workspace MCP routes and tests: `server/routes/workspace-tools.js`, `server/routes/workspace-tools.test.js`
- Current user-facing tools UI to reshape: `src/components/tools-market/ToolsPanel.tsx`
- Current workspace tools hook: `src/components/tools-market/hooks/useWorkspaceTools.ts`
- Current tab shell: `src/components/main-content/view/MainContent.tsx`, `src/components/main-content/view/subcomponents/mainContentTabs.ts`, `src/types/app.ts`
- Current Admin dialog shell: `src/components/admin/AdminPanel.tsx`
- Current provider/Settings MCP management capability: `src/components/mcp/**`, `server/modules/providers/services/mcp.service.ts`
- Docker workspace mount behavior: `server/services/agent-session-runtime.js`

## Storage Model

Add two database tables to `server/database/multitenancy-schema.js`.

```sql
CREATE TABLE IF NOT EXISTS mcp_server_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('http')),
  config_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'disabled')),
  docker_compatible INTEGER NOT NULL DEFAULT 0,
  last_test_status TEXT,
  last_test_error TEXT,
  last_tested_at DATETIME,
  tool_count INTEGER NOT NULL DEFAULT 0,
  tools_json TEXT,
  created_by_user_id INTEGER NOT NULL,
  updated_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_mcp_preset_installs (
  workspace_id INTEGER NOT NULL,
  preset_id INTEGER NOT NULL,
  installed_by_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'removed')),
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_probe_status TEXT,
  last_probe_error TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0,
  tools_json TEXT,
  PRIMARY KEY (workspace_id, preset_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_id) REFERENCES mcp_server_presets(id) ON DELETE CASCADE,
  FOREIGN KEY (installed_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

`config_json` stores the real Admin-managed MCP config snapshot:

```json
{
  "type": "http",
  "url": "https://mcp.internal.example/knowledge",
  "headers": {
    "Authorization": "Bearer internal-secret"
  }
}
```

Admin API may return full config to system admins. Workspace user APIs must redact secret-bearing fields and return only safe metadata such as transport, description, Docker compatibility, status, and tool count.

## API Shape

Admin routes under existing `/api/admin`:

```text
GET    /api/admin/mcp-presets
POST   /api/admin/mcp-presets
PUT    /api/admin/mcp-presets/:presetId
POST   /api/admin/mcp-presets/:presetId/test
POST   /api/admin/mcp-presets/:presetId/publish
POST   /api/admin/mcp-presets/:presetId/disable
DELETE /api/admin/mcp-presets/:presetId
```

Workspace routes under existing `/api/workspaces/:workspaceId`:

```text
GET    /api/workspaces/:workspaceId/mcp-tools
POST   /api/workspaces/:workspaceId/mcp-tools/:presetId/install
DELETE /api/workspaces/:workspaceId/mcp-tools/:presetId
```

The old workspace tools routes can remain temporarily for compatibility, but the main UI must stop calling the manual `probe`, `upsert`, and `import-preview` flows.

## Response Contracts

Workspace catalog response:

```json
{
  "workspaceId": 10,
  "accessRole": "edit",
  "canManage": true,
  "summary": {
    "available": 8,
    "installed": 3
  },
  "presets": [
    {
      "id": 1,
      "name": "knowledge_retrieval",
      "displayName": "Knowledge Retrieval MCP",
      "description": "Search internal knowledge bases, product specs, and implementation notes from Agent turns.",
      "transport": "http",
      "status": "available",
      "dockerCompatible": true,
      "toolCount": 12,
      "tools": [{ "name": "search_knowledge", "description": "Search approved knowledge sources" }],
      "installed": false,
      "userSetupRequired": false,
      "containerPath": "/workspace/.mcp.json"
    }
  ]
}
```

Install response:

```json
{
  "workspaceId": 10,
  "installed": {
    "presetId": 1,
    "name": "knowledge_retrieval",
    "status": "installed",
    "writeTarget": "myworkspace3/.mcp.json",
    "containerPath": "/workspace/.mcp.json",
    "appliesOn": "next_agent_turn",
    "toolCount": 12
  },
  "summary": {
    "available": 7,
    "installed": 4
  }
}
```

## File Map

Create:

```text
server/services/mcp-presets.js
server/services/mcp-presets.test.js
server/routes/admin-mcp-presets.test.js
server/routes/workspace-mcp-tools.js
server/routes/workspace-mcp-tools.test.js
src/components/tools-market/McpToolsPanel.tsx
src/components/tools-market/hooks/useWorkspaceMcpTools.ts
src/components/admin/McpPresetsTab.tsx
src/components/admin/hooks/useAdminMcpPresets.ts
src/components/admin/adminMcpPresetUtils.ts
src/components/admin/adminMcpPresetUtils.test.ts
```

Modify:

```text
server/database/multitenancy-schema.js
server/database/multitenancy-db.js
server/database/multitenancy-db.test.js
server/routes/admin.js
server/index.js
server/services/workspace-tools.js
server/services/workspace-tools.test.js
server/services/agent-session-runtime.js
src/types/app.ts
src/hooks/useProjectsState.ts
src/components/main-content/view/MainContent.tsx
src/components/main-content/view/subcomponents/mainContentTabs.ts
src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx
src/components/main-content/view/subcomponents/MainContentTitle.tsx
src/components/main-content/utils/mainContentAccess.ts
src/components/main-content/utils/mainContentAccess.test.ts
src/components/tools-market/utils/toolFormatting.ts
src/components/tools-market/utils/toolFormatting.test.ts
src/components/admin/AdminPanel.tsx
src/utils/api.js
src/i18n/locales/en/common.json
src/i18n/locales/zh-CN/common.json
src/i18n/locales/*/common.json
src/i18n/locales/*/settings.json
```

Retire or hide from reachable UI:

```text
src/components/skills-market/SkillsPanel.tsx
src/components/mcp/view/McpServers.tsx
src/components/plugins/view/PluginTabContent.tsx
src/components/standalone-shell/view/StandaloneShell.tsx
src/components/git-panel/view/GitPanel.tsx
src/components/task-master/view/TaskMasterPanel.tsx
```

These modules can remain in the repository for now if other flows still import them, but they must no longer be rendered from the main workspace shell.

---

## Task 1: Add Database Persistence For MCP Presets

**Files:**
- Modify: `server/database/multitenancy-schema.js`
- Modify: `server/database/multitenancy-db.js`
- Modify: `server/database/multitenancy-db.test.js`

- [ ] Add `mcp_server_presets` and `workspace_mcp_preset_installs` to `MULTITENANCY_SCHEMA_SQL`.
- [ ] Add normalizers in `server/database/multitenancy-db.js`:
  - preset status: `draft`, `published`, `disabled`
  - install status: `installed`, `removed`
  - transport: `http`
  - JSON stringify/parse helpers for `config_json` and `tools_json`
- [ ] Add `multitenancy.mcpPresets` methods:
  - `createPreset({ tenantId, name, displayName, description, config, status, createdByUserId })`
  - `updatePreset({ presetId, tenantId, displayName, description, config, status, updatedByUserId })`
  - `getPresetById({ tenantId, presetId })`
  - `listPresets({ tenantId, includeDisabled = true })`
  - `publishPreset({ tenantId, presetId, updatedByUserId })`
  - `disablePreset({ tenantId, presetId, updatedByUserId })`
  - `deletePreset({ tenantId, presetId })`
  - `recordPresetTest({ tenantId, presetId, status, error, toolCount, tools, dockerCompatible, updatedByUserId })`
- [ ] Add `multitenancy.mcpInstalls` methods:
  - `upsertInstall({ workspaceId, presetId, installedByUserId, probeStatus, probeError, toolCount, tools })`
  - `removeInstall({ workspaceId, presetId })`
  - `listInstallsForWorkspace({ workspaceId })`
- [ ] Add tests proving tenant isolation, unique `(tenant_id, name)`, published filtering, and reinstall updates the same install row.

Run:

```bash
node --test server/database/multitenancy-db.test.js
```

Expected: all multitenancy database tests pass.

## Task 2: Implement Admin Preset Service And Routes

**Files:**
- Create: `server/services/mcp-presets.js`
- Create: `server/services/mcp-presets.test.js`
- Modify: `server/routes/admin.js`
- Create: `server/routes/admin-mcp-presets.test.js`

- [ ] Implement `normalizePresetInput(input)` for Admin payloads:
  - `name` uses the existing MCP server name constraints from `workspace-tools.js`.
  - `displayName` and `description` are strings.
  - only `type: "http"` is accepted.
  - `url` must be `http://` or `https://`.
  - `headers` are accepted as Admin-managed config and are not exposed to workspace users.
- [ ] Implement `toAdminPreset(row)` returning full Admin-visible config.
- [ ] Implement `toWorkspacePreset(row, installRow)` returning redacted workspace-visible metadata.
- [ ] Implement Admin CRUD route handlers behind existing `requireSystemAdmin`.
- [ ] Implement `POST /api/admin/mcp-presets/:presetId/test`.
  - Reuse `probeHttpMcpServer` for JSON-RPC initialize + initialized + tools/list.
  - Store `toolCount`, `tools`, `last_test_status`, `last_test_error`, and `docker_compatible`.
  - Mark `docker_compatible = 1` only when Docker-mode probe succeeds.
- [ ] Implement publish guard:
  - preset must have a successful test before publish.
  - preset must have a valid complete config.
  - preset must not require any user-side values.
- [ ] Add route tests for non-admin 403, create/update/publish, disable, and redacted workspace-safe serialization.

Run:

```bash
node --test server/services/mcp-presets.test.js server/routes/admin-mcp-presets.test.js
```

Expected: service and Admin route tests pass.

## Task 3: Implement Workspace MCP Tools Catalog And One-Click Install

**Files:**
- Create: `server/routes/workspace-mcp-tools.js`
- Create: `server/routes/workspace-mcp-tools.test.js`
- Modify: `server/services/workspace-tools.js`
- Modify: `server/services/workspace-tools.test.js`
- Modify: `server/index.js`

- [ ] Add `listWorkspaceMcpPresetCatalog({ tenantId, workspaceId, accessRole })`.
  - Loads published presets for the tenant.
  - Loads install rows for the workspace.
  - Returns `available` and `installed` summary only.
  - Does not include disabled/draft presets.
  - Does not include raw headers or secret config.
- [ ] Add `installWorkspaceMcpPreset({ tenantId, workspaceId, workspacePath, presetId, userId })`.
  - Requires edit access through `workspaceAccess.requireWorkspace`.
  - Reads the published preset.
  - Writes preset config into `<workspace>/.mcp.json` under `mcpServers[preset.name]`.
  - Records status under `.cloudcli/mcp/status.json`.
  - Records `workspace_mcp_preset_installs`.
  - Does not ask the user for config.
  - Does not create `.cloudcli/mcp/drafts.json`.
- [ ] Add `removeWorkspaceMcpPreset({ tenantId, workspaceId, workspacePath, presetId })`.
  - Removes the matching server from `.mcp.json`.
  - Marks install row removed or deletes it according to the database helper.
  - Keeps unrelated unmanaged `.mcp.json` servers intact.
- [ ] Mount `workspace-mcp-tools` router in `server/index.js` under `/api/workspaces`.
- [ ] Keep existing `workspace-tools` routes mounted for compatibility until frontend migration is complete.
- [ ] Add tests:
  - view users can list but cannot install.
  - edit users can install.
  - install writes `.mcp.json`.
  - install does not require `GITHUB_TOKEN` or any user values.
  - disabled/draft presets are excluded.
  - install response returns `/workspace/.mcp.json` as the container-visible path.

Run:

```bash
node --test server/services/workspace-tools.test.js server/routes/workspace-mcp-tools.test.js
```

Expected: workspace MCP install behavior passes.

## Task 4: Preserve Docker Runtime Visibility

**Files:**
- Modify: `server/services/agent-session-runtime.js`
- Modify: `server/services/agent-session-runtime.test.js`
- Modify: `server/services/mcp-presets.js`

- [ ] Keep existing Docker `--mount type=bind,src=<workspace>,dst=/workspace`.
- [ ] Do not add a separate file mount for `.mcp.json`.
- [ ] Add a shared constant or helper for container MCP config path:
  - host write target: `<workspace>/.mcp.json`
  - container-visible path: `/workspace/.mcp.json`
- [ ] For Docker execution mode, Admin preset test should run from Docker-equivalent network context.
  - Preferred implementation: use the configured Claude Docker image and execute a small Node JSON-RPC probe inside an ephemeral container or existing runtime container.
  - If Docker is unavailable, return a structured Admin test failure and do not publish.
- [ ] Add tests for Docker run args confirming the workspace bind mount is still present and `.mcp.json` is covered by that mount.
- [ ] Add tests proving install does not restart or mutate existing runtime containers.

Run:

```bash
node --test server/services/agent-session-runtime.test.js server/services/mcp-presets.test.js
```

Expected: Docker mount and Docker-compatible probe tests pass.

## Task 5: Reduce Main Workspace IA To Chat, Files, MCP Tools

**Files:**
- Modify: `src/types/app.ts`
- Modify: `src/hooks/useProjectsState.ts`
- Modify: `src/components/main-content/view/MainContent.tsx`
- Modify: `src/components/main-content/view/subcomponents/mainContentTabs.ts`
- Modify: `src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx`
- Modify: `src/components/main-content/view/subcomponents/MainContentTitle.tsx`
- Modify: `src/components/main-content/utils/mainContentAccess.ts`
- Modify: `src/components/main-content/utils/mainContentAccess.test.ts`

- [ ] Change `AppTab` to the supported workspace tabs:
  - `chat`
  - `files`
  - `mcp-tools`
  - keep `preview` only if required by hidden editor plumbing; do not render it as a tab.
- [ ] Update active-tab persistence:
  - old `skills`, `tools`, `shell`, `git`, `tasks`, `preview`, and `plugin:*` persisted values resolve to `chat`.
- [ ] Update `mainContentTabs.ts` to return only:
  - `Chat`
  - `Files`
  - `MCP Tools`
- [ ] Remove plugin tab injection from `MainContentTabSwitcher`.
- [ ] Remove `shouldShowTasksTab` from visible tab construction.
- [ ] Remove main content render branches for `SkillsPanel`, `StandaloneShell`, `GitPanel`, `TaskMasterPanel`, and `PluginTabContent`.
- [ ] Render the new MCP Tools panel when `activeTab === "mcp-tools"`.
- [ ] Keep Chat and Files behavior unchanged.
- [ ] Update title logic so MCP Tools title is `MCP Tools`.
- [ ] Add tests for tab fallback and disabled tab behavior.

Run:

```bash
npx tsx --test src/components/main-content/utils/mainContentAccess.test.ts src/hooks/projectTenantUpdates.test.ts
npm run typecheck
```

Expected: invalid old tabs resolve away and typecheck passes.

## Task 6: Build The User MCP Tools Page

**Files:**
- Create: `src/components/tools-market/McpToolsPanel.tsx`
- Create: `src/components/tools-market/hooks/useWorkspaceMcpTools.ts`
- Modify: `src/components/tools-market/utils/toolFormatting.ts`
- Modify: `src/components/tools-market/utils/toolFormatting.test.ts`
- Modify: `src/utils/api.js`
- Modify: `src/i18n/locales/en/common.json`
- Modify: `src/i18n/locales/zh-CN/common.json`

- [ ] Add API helpers:
  - `api.workspaceMcpTools.list(workspaceId)`
  - `api.workspaceMcpTools.install(workspaceId, presetId)`
  - `api.workspaceMcpTools.remove(workspaceId, presetId)`
- [ ] Implement `useWorkspaceMcpTools(workspaceId)` with:
  - `data`, `error`, `isLoading`
  - `reload`
  - `installPreset`
  - `removePreset`
  - optimistic installing state per preset id
- [ ] Implement user page layout from the approved UX:
  - header: `MCP Tools`, current workspace name, Refresh.
  - summary tiles: `Available`, `Installed`.
  - search input.
  - filters: `All`, `Available`, `Installed`.
  - available internal MCP server cards.
  - installed MCP server cards.
  - right detail panel.
- [ ] Install button behavior:
  - clicking `Install` immediately calls install API.
  - card enters `Installing`.
  - on success, card moves to installed and shows a toast/inline success message.
  - no modal is shown.
- [ ] Do not render user fields for URL, token, headers, import JSON, probe, or save.
- [ ] Do not render user summary counters for install failed/admin disabled.
- [ ] Do not render user filter for error/admin disabled.
- [ ] Detail panel shows safe values:
  - preset source: Admin published.
  - install target: `<workspaceDisplayName>/.mcp.json`.
  - container path: `/workspace/.mcp.json`.
  - user configuration: Not required.
  - runtime policy: applies on next Agent turn/session reload.
- [ ] Respect view-only workspaces:
  - show installed/published presets.
  - disable install/remove actions with `Requires edit access`.

Run:

```bash
npx tsx --test src/components/tools-market/utils/toolFormatting.test.ts
npm run typecheck
```

Expected: formatting tests and typecheck pass.

## Task 7: Add Admin MCP Server Presets UI

**Files:**
- Create: `src/components/admin/McpPresetsTab.tsx`
- Create: `src/components/admin/hooks/useAdminMcpPresets.ts`
- Create: `src/components/admin/adminMcpPresetUtils.ts`
- Create: `src/components/admin/adminMcpPresetUtils.test.ts`
- Modify: `src/components/admin/AdminPanel.tsx`
- Modify: `src/utils/api.js`

- [ ] Add `MCP Server Presets` tab beside `Tenants & Users` and `Runtime Monitor`.
- [ ] Add Admin list/table:
  - name/display name
  - transport
  - visibility/tenant
  - Docker compatibility
  - status
  - install count
  - last tested time
- [ ] Add Admin create/edit form:
  - display name
  - preset name
  - description
  - HTTP URL
  - headers as key/value rows or textarea
  - status actions: save draft, test preset, publish, disable
- [ ] Make Admin form explicit that user install mode is one-click and no user configuration is allowed.
- [ ] Reuse existing MCP validation/formatting concepts from `src/components/mcp/**` where practical, but do not keep the provider-specific user Settings flow.
- [ ] Test preset action calls Admin test API and displays success/failure.
- [ ] Publish is disabled until the latest test has succeeded.
- [ ] Admin can disable a preset; disabled presets disappear from user MCP Tools page but remain in Admin.
- [ ] Add unit tests for form payload normalization and secret redaction helpers.

Run:

```bash
npx tsx --test src/components/admin/adminMcpPresetUtils.test.ts src/components/admin/runtimeMonitorUtils.test.ts
npm run typecheck
```

Expected: Admin utilities and typecheck pass.

## Task 8: Retire Settings MCP Management From User-Facing Settings

**Files:**
- Modify: `src/components/settings/view/Settings.tsx`
- Modify: `src/components/settings/view/SettingsMainTabs.tsx`
- Modify: `src/components/settings/hooks/useSettingsController.ts`
- Modify: `src/i18n/locales/*/settings.json`

- [ ] Remove or hide the Settings tab/section that exposes MCP Server configuration to regular users.
- [ ] Keep provider MCP service code in place until no backend route depends on it.
- [ ] Treat this as capability migration, not automatic data migration:
  - Admin MCP Server Presets own new internal MCP configs.
  - Existing provider/user/project MCP configs are legacy and no longer edited from the main user Settings UI.
  - If a deployment needs to preserve existing configs, Admin recreates them as draft presets through the new Admin form.
- [ ] Remove Settings copy that encourages adding GitHub/third-party MCP servers.
- [ ] Ensure Settings still renders API credentials, appearance, notifications, git, plugins, and task settings as currently supported outside the main workspace tabs.

Run:

```bash
npm run typecheck
```

Expected: Settings typecheck passes and no user-facing Settings MCP entry remains.

## Task 9: Update Localization And Labels

**Files:**
- Modify: `src/i18n/locales/en/common.json`
- Modify: `src/i18n/locales/zh-CN/common.json`
- Modify: other locale `common.json` files with English fallback strings if full translation is not available.

- [ ] Add `tabs.mcpTools`.
- [ ] Rename user-facing Tools page copy to MCP Tools.
- [ ] Add Admin MCP preset strings.
- [ ] Add workspace install strings:
  - `Available`
  - `Installed`
  - `Install`
  - `Installing`
  - `Connected`
  - `No user setup`
  - `Docker compatible`
  - `Applies on next Agent turn`
  - `Requires edit access`
- [ ] Remove or stop using strings for user-side `Connect MCP Server`, `Import JSON`, `Probe`, `Headers`, `Needs value`, and manual setup flows.

Run:

```bash
npm run typecheck
```

Expected: i18n consumers compile.

## Task 10: End-To-End Verification

**Files:**
- No new source files required.

- [ ] Run focused backend tests:

```bash
node --test \
  server/database/multitenancy-db.test.js \
  server/services/workspace-tools.test.js \
  server/services/mcp-presets.test.js \
  server/routes/admin-mcp-presets.test.js \
  server/routes/workspace-mcp-tools.test.js \
  server/services/agent-session-runtime.test.js
```

- [ ] Run focused frontend tests:

```bash
npx tsx --test \
  src/components/main-content/utils/mainContentAccess.test.ts \
  src/components/tools-market/utils/toolFormatting.test.ts \
  src/components/admin/adminMcpPresetUtils.test.ts
```

- [ ] Run full typecheck:

```bash
npm run typecheck
```

- [ ] Run the app:

```bash
npm run dev
```

- [ ] Browser smoke test:
  - Open a workspace.
  - Confirm top tabs are only `Chat`, `Files`, `MCP Tools`.
  - Confirm `MCP Tools` lists Admin-published internal presets.
  - Click `Install` and confirm no modal appears.
  - Confirm `.mcp.json` is written at the workspace root.
  - If Docker mode is enabled, confirm the runtime path is `/workspace/.mcp.json`.
  - Open Admin and confirm `MCP Server Presets` exists.
  - Create draft, test, publish, then confirm the user MCP Tools page can install it.

## Implementation Order

1. Database and service contracts.
2. Admin backend routes.
3. Workspace install backend routes.
4. Main workspace tab reduction.
5. User MCP Tools page.
6. Admin MCP presets page.
7. Settings MCP retirement.
8. Docker validation hardening.
9. Localization, typecheck, browser smoke test.

## Risks And Guardrails

- Secret leakage: workspace list APIs must never return raw Admin headers. Admin APIs can return full config only to system admins.
- Existing `.mcp.json` preservation: install/remove must only touch the preset server key and preserve unrelated user/unmanaged entries.
- Docker semantics: do not add a file mount for `.mcp.json`; rely on existing workspace bind mount.
- Legacy active tabs: persisted old tab IDs must fall back to `chat` so users do not land on a blank page after upgrade.
- Runtime activation: install applies next turn; do not restart active containers or interrupt Agent sessions.
- Settings migration: hide user-facing MCP settings after Admin presets are available, not before.

## Done Criteria

- Workspace top tabs are exactly `Chat`, `Files`, `MCP Tools`.
- User MCP Tools page has no manual MCP configuration controls.
- Admin can create, test, publish, disable internal MCP presets.
- Published Admin presets appear as cards to workspace users.
- Clicking `Install` writes `.mcp.json` directly and updates the card state without a modal.
- Docker mode exposes the same config at `/workspace/.mcp.json`.
- Focused backend tests, focused frontend tests, and `npm run typecheck` pass.
