# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

- `npm run dev` — Start both frontend (Vite) and backend (Express) concurrently
- `npm run build` — Production build (client then server)
- `npm run build:client` — Vite build only
- `npm run build:server` — TypeScript compile + tsc-alias for server
- `npm run server:dev` — Run backend via tsx (no build needed)
- `npm run client` — Vite dev server only
- `npm run typecheck` — Type-check both client and server
- `npm run lint` / `npm run lint:fix` — ESLint for src/ and server/
- `npm run test:multitenancy` — Run all multitenancy tests (Node test runner + tsx)
- Node.js 22 required (see `.nvmrc`)

## Architecture

### Dual `@/` Path Alias

Both client and server use `@/` as an import alias, but they resolve to different directories:
- **Frontend** (`tsconfig.json`): `@/*` → `src/*`
- **Backend** (`server/tsconfig.json`): `@/*` → `server/*` (rooted at project root so `@/shared/` also resolves)

The server build uses `tsc-alias` to rewrite these paths in compiled output under `dist-server/`.

### Frontend (src/)

React 18 + Vite + Tailwind CSS. Entry: `src/main.jsx` → `src/App.tsx`.

Context provider nesting order (outer to inner): `I18nextProvider` → `ThemeProvider` → `AuthProvider` → `TenantProvider` → `WebSocketProvider` → `PluginsProvider` → `TasksSettingsProvider` → `TaskMasterProvider`.

Key contexts:
- **WebSocketContext** — Single WebSocket connection per tenant, message dispatch to subscribers
- **TenantContext** — Multi-tenant selection, tenant-scoped API calls and WS connections
- **AuthContext** — JWT auth, user state

State management is a mix of React Context and Zustand stores (`src/stores/useSessionStore.ts`).

### Backend (server/)

Express + WebSocket (ws) + SQLite (better-sqlite3). Entry: `server/index.js`.

- **routes/** — Express route handlers, one file per domain (auth, tenants, workspaces, git, projects, settings, etc.)
- **database/** — SQLite schema and query layer. Two databases: `db.js` (auth + app config) and `multitenancy-db.js` (tenants, memberships, workspaces, sessions)
- **middleware/** — `auth.js` (JWT validation), `tenant-context.js` (tenant resolution from query/header, authorization checks)
- **services/** — Business logic: workspace access control, session ownership, message history, agent session runtime, notifications
- **modules/providers/** — Provider abstraction layer with subdirectories per CLI agent: `claude/`, `codex/`, `cursor/`, `gemini/`. Shared services: `sessions.service.ts`, `provider-auth.service.ts`, `mcp.service.ts`

### Multi-tenancy

Platform mode (`VITE_IS_PLATFORM=true`) enables multi-tenancy. The tenant ID flows through:
1. Client sends `?tenantId=` or `x-tenant-id` header
2. `tenantContext` middleware resolves and validates access
3. Database queries are scoped to the tenant
4. WebSocket connections are tenant-scoped

Tenant data is stored in SQLite via `multitenancy-db.js` with tables for tenants, memberships, workspaces, sessions, and join requests.

### Agent Provider Integration

Each CLI agent (Claude, Codex, Cursor, Gemini) has:
- A top-level integration file in `server/` (e.g., `claude-sdk.js`, `openai-codex.js`)
- A provider module under `server/modules/providers/list/<provider>/`
- Corresponding frontend route handlers

Claude uses the `@anthropic-ai/claude-agent-sdk` directly (no child process). Other providers use `node-pty` for CLI interaction.

### Shared Code (shared/)

`shared/modelConstants.js` — single source of truth for supported AI models (SDK format vs API format).
`shared/networkHosts.js` — host resolution utilities used by both Vite config and server.

## Conventions

- **Commits**: Conventional Commits enforced by commitlint + husky pre-commit (`npx lint-staged`)
- **Linting**: ESLint with typescript-eslint, react-hooks, import-x (import ordering), tailwindcss, unused-imports, boundaries plugins
- **Server language**: Mostly JavaScript with TypeScript being adopted incrementally (`allowJs: true`, `checkJs: false` in server tsconfig). New files can be `.ts`.
- **Tests**: Node.js built-in test runner (`node --test`) for server JS tests, `tsx --test` for TS tests. No Jest/Vitest for server.
- **i18n**: All user-facing strings use react-i18next. Translation files in `src/i18n/`.

## gstack

Use `/browse` from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/qa`, `/design-review`, `/retro`, `/investigate`, `/autoplan`, `/careful`, `/freeze`, `/guard`, `/gstack-upgrade`, `/learn`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
