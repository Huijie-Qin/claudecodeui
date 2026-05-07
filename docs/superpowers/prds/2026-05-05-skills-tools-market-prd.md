# Skills 与 Tools 目录 PRD

日期：2026-05-05
状态：Ready for implementation planning
关联设计稿：`scratch/designs/skills-tools-market/index.html`、`scratch/designs/skills-tools-market/tools.html`
关联需求设计：`docs/superpowers/specs/2026-05-04-skills-tools-market-design.md`
Notion issue：`https://www.notion.so/357880c33ce681a4a8eec842cd4a06d7`

## Problem Statement

CloudCLI 的 workspace 已经把文件、终端、Git、任务等能力放在主工作区里，但 Agent 当前“会什么技能”和“能调用哪些工具”仍分散在 Settings、MCP 配置、权限配置、插件扫描和运行时文件中。用户在一个 workspace 内工作时，无法快速判断当前 Agent 可以使用哪些 skills、哪些 built-in tools、哪些 MCP servers，也无法用一个主工作区入口安全地安装 workspace 级 skill 或连接 HTTP MCP server。

这会带来三个问题：

- 可见性不足：workspace 成员无法一眼确认 Agent 的能力边界。
- 管理入口分散：skills、MCP、permission state、running session reload 语义分散在不同位置。
- 安全语义不清：手写 `.claude/skills`、手写 `.mcp.json`、Docker runtime、probe cache、draft config、workspace 权限之间没有统一产品规则。

## Solution

在主内容区新增与 `Files` 平行的 `Skills` 与 `Tools` Tab。

`Skills` 用于查看当前 workspace 中 Agent 可用的 skills，包括 CloudCLI managed workspace skills、plugin / bundled read-only skills，以及手写 unmanaged workspace skills。v1 支持从公开 GitHub HTTPS 安装 workspace 级 skills，安装后写入 CloudCLI 管理目录，并物化 enabled skills 到 Claude Code CLI 可见目录。v1 不展示 user-level skills，不做 user/global 安装。

`Tools` 用于查看当前 workspace 可用的 built-in tools 权限状态和 HTTP MCP servers。v1 支持通过 form 或 JSON import 连接 HTTP MCP server，并执行真实 runtime-context probe。probe 成功后写入当前 workspace 的 project MCP config；probe 失败时按场景保存 draft、展示 stale/error，或保留已有 runtime-loadable 配置。v1 不展示 Claude / Codex / Gemini / Cursor provider 选择，不做 user/local MCP 管理，不支持 stdio / SSE，也不做 OAuth、secret mask、按人权限隔离或审计。

两个 Tab 都沿用现有 workspace 权限模型：`owner`、`edit`、system admin 可管理；`view` 可查看但不能写入。

## User Stories

1. As a workspace member, I want to open `Skills` next to `Files`, so that I can see what skills the Agent can use in the current workspace.
2. As a workspace member, I want to distinguish workspace, plugin, bundled, and unmanaged skills, so that I understand which skills I can manage.
3. As a workspace editor, I want to install a public GitHub skill into the current workspace, so that the Agent can use project-specific instructions without affecting other workspaces.
4. As a workspace editor, I want to preview a GitHub skill before installing it, so that I can inspect the name, description, files, source URL, pinned commit, and risk.
5. As a workspace editor, I want public GitHub HTTPS to be the only v1 install source, so that install behavior is predictable and does not require private credentials.
6. As a workspace editor, I want installs to pin a commit SHA, so that the workspace can reproduce which skill version was installed.
7. As a workspace editor, I want installed workspace skills to be enabled by default, so that a successful install immediately becomes useful on the next Agent turn.
8. As a workspace editor, I want to disable a managed workspace skill, so that it stays installed but no longer appears in the Agent runtime skill set.
9. As a workspace editor, I want to re-enable a disabled managed workspace skill, so that it is restored to the runtime-visible skill directory.
10. As a workspace editor, I want to uninstall a managed workspace skill, so that CloudCLI removes the source, metadata, and materialized copy without leaving tombstones.
11. As a workspace editor, I want reinstall of a managed skill with the same name to show an overwrite preview, so that I can manually update a skill without silent replacement.
12. As a workspace editor, I want failed reinstall to preserve the old installed version, so that a broken update does not degrade the Agent.
13. As a workspace member, I want unmanaged `.claude/skills` directories to appear read-only, so that manually maintained workspace skills are visible but protected.
14. As a workspace editor, I want GitHub install to block if the target name conflicts with an unmanaged skill, so that user-created files are not overwritten.
15. As a workspace member, I want plugin and bundled skills to be read-only, so that I know CloudCLI is not managing their lifecycle from this page.
16. As a workspace member, I want invalid skills to appear with parse errors, so that broken `SKILL.md` files are not silently ignored.
17. As a workspace member, I want CloudCLI to reconcile managed skill metadata with the runtime-visible skill directory, so that the UI and Agent runtime do not drift.
18. As a workspace member, I want reconcile to leave unmanaged skill directories untouched, so that manual assets are never deleted by CloudCLI.
19. As a user starting an Agent turn, I want skill reconcile failures to block only new turns, so that disabled skills are not accidentally loaded and enabled skills are not missing.
20. As a user with an already running Agent turn, I do not want a reconcile failure to interrupt the running turn, so that in-flight work is not disrupted.
21. As a workspace member, I want skill changes to clearly say they apply on the next Agent turn or session reload, so that I understand current running turns are not hot-updated.
22. As a Docker runtime user, I want enabled workspace skills to be visible inside the container, so that Claude Code CLI loads the same workspace skill set as the host UI.

23. As a workspace member, I want to open `Tools` next to `Files`, so that I can see built-in tools and MCP servers for the current workspace.
24. As a workspace member, I want built-in tool permission state to be visible, so that I can see which tools are allowed, blocked, or prompt-required.
25. As a workspace member, I want built-in tool permission editing to remain in Settings, so that Tools is an inventory and connection surface rather than a second permission editor.
26. As a workspace editor, I want to connect an HTTP MCP server for the current workspace, so that the Agent can use project-specific external tools.
27. As a workspace editor, I want `http://` and `https://` endpoints to be allowed, so that local and private MCP servers can be used in development.
28. As a Docker runtime user, I want localhost/private endpoints to show a Docker reachability warning, so that I understand container networking semantics.
29. As a workspace editor, I want all MCP connection values to be stored visibly in workspace config for v1, so that the team shares the same connection without secret-management complexity.
30. As a workspace member, I want to see saved header/env/token values, so that workspace-visible configuration is explicit.
31. As a workspace editor, I want v1 to reject stdio and SSE connects, so that Tools cannot start arbitrary local commands or promise unsupported transports.
32. As a workspace member, I want existing non-HTTP `.mcp.json` config to appear as unsupported read-only, so that legacy config is visible without being treated as v1-managed.
33. As a workspace editor, I want unsupported existing config removable with confirmation, so that old incompatible entries can be cleaned up safely.
34. As a workspace member, I want existing hand-written HTTP `.mcp.json` config to appear as unverified, so that runtime-loadable config is visible even before CloudCLI has probe metadata.
35. As a workspace editor, I want to test an existing HTTP config, so that CloudCLI can cache discovered tools and mark it healthy only after real runtime-context probe.
36. As a workspace editor, I want a failed probe on existing HTTP config not to block Agent turns, so that Tools does not silently change runtime semantics for hand-written config.
37. As a workspace editor, I want editing existing HTTP config through Tools to require a successful probe before replacement, so that old working config is protected.
38. As a workspace editor, I want failed edits to become update drafts, so that I can retry without losing the active runtime-loadable config.
39. As a workspace editor, I want JSON import to preview every `mcpServers` entry, so that I can choose valid HTTP servers without silently importing bad entries.
40. As a workspace editor, I want JSON import to reject unsupported transports, so that stdio/SSE entries are not imported as v1 managed config.
41. As a workspace editor, I want JSON import entries with missing token/env/header values to become `needs value` drafts, so that I can save setup progress without connecting broken config.
42. As a workspace editor, I want invalid JSON or invalid URL to be blocked from drafts, so that draft metadata stays structurally meaningful.
43. As a workspace editor, I want each selected import entry to probe independently, so that one bad server does not block unrelated valid servers.
44. As a workspace member, I want partial import results summarized, so that I can see connected, drafted, skipped, and blocked outcomes.
45. As a workspace editor, I want runtime-context probe rather than browser-only probe, so that Docker networking and localhost semantics match the Agent runtime.
46. As a Docker runtime user, I want probe to run from a container-equivalent network context, so that a host-only success does not falsely mark a server healthy.
47. As a workspace editor, I want probe success to cache initialize/tools-list results, latency, tested time, runtime mode, and probe context, so that Tools can show useful diagnostics.
48. As a workspace member, I want stale probe cache to retain the last successful tools list, so that a temporary failure does not erase useful inventory.
49. As a workspace editor, I want delete of a connected MCP server to remove config, probe cache, related drafts, and saved values, so that no hidden metadata remains.
50. As a workspace member, I want MCP changes to apply on the next Agent turn or reload, so that running turns are not disrupted.
51. As a view-only workspace member, I want to inspect Skills and Tools but see disabled management controls, so that I understand my permission boundary.
52. As a system admin, I want Skills and Tools writes to follow existing workspace edit logic, so that admin behavior is consistent with the rest of CloudCLI.

## Implementation Decisions

- Add `Skills` and `Tools` as built-in workspace tabs in the main content area, before plugin tabs and alongside `Files`.
- Preserve the existing app shell and sidebar; this feature does not redesign the left navigation.
- Keep `Runtime Monitor` in Admin / Settings governance surfaces, not in the main content tab set.
- Use workspace access roles as the sole v1 authorization model.
- Treat CloudCLI managed workspace skills as a source-plus-materialized-view model: CloudCLI metadata and source files are the management source; Claude Code CLI's workspace skill directory is the runtime-visible view.
- Detect unmanaged workspace skills from the runtime-visible directory and show them read-only.
- Reconcile managed skills deterministically on Skills page load, skill management operations, and Agent turn startup.
- Fail closed before new Agent turns when skill reconcile fails, while leaving already running turns alone.
- Restrict v1 skill install sources to public GitHub HTTPS URLs and archive URLs that can be pinned to commits.
- Do not run third-party skill scripts, package managers, build commands, or dynamic code during skill install.
- Block installs that conflict with unmanaged workspace skill names.
- Preserve old managed skill versions when reinstall fails.
- Preserve current Agent turn behavior for skill changes; skill updates apply to subsequent turns or explicit reload/start-new-session actions.
- Build `Tools` as a workspace inventory and connection page, not as a provider-specific MCP settings page.
- Use the current workspace project MCP config as the only v1 write target.
- Do not expose provider fan-out, user/local MCP scope, OAuth, token refresh, secret masking, per-user auth, or audit in v1.
- Support only HTTP MCP transport in the Tools page. Existing non-HTTP config can be displayed and removed, but not tested or edited.
- Allow public, localhost, loopback, and private HTTP endpoints with Docker reachability warnings.
- Save MCP header/env/token values in workspace-visible config or draft metadata.
- Treat existing hand-written HTTP config as runtime-loadable but unverified until CloudCLI probe succeeds.
- Do not let a failed probe on existing hand-written HTTP config block Agent turns or alter runtime config.
- Once an existing HTTP config is edited through Tools, require successful probe before replacing runtime config.
- Keep failed create/update configs in CloudCLI draft metadata rather than runtime config.
- Let valid HTTP JSON import entries with missing values become `needs value` drafts.
- Block invalid JSON, invalid URL, unsupported transport, and invalid server names from draft persistence.
- Run MCP probe from the effective Agent runtime context: local backend context in local mode; Docker container or equivalent network namespace in Docker mode.
- Use short-lived Docker probe containers when Docker mode has no active session container.
- Persist probe status only for Tools UI and diagnostics; Agent runtime reads runtime config, not probe cache.
- Keep Settings > Agents > MCP available for provider-specific advanced flows.

## Testing Decisions

- Test observable behavior, not implementation details. Good tests assert visible state transitions, file outputs, API responses, and runtime-start blocking behavior.
- Backend unit tests should cover skill metadata parsing, install preview, unmanaged detection, name conflict blocking, enable/disable/uninstall, reconcile idempotency, and fail-closed Agent startup behavior.
- Backend MCP tests should cover workspace-scoped `.mcp.json` reads/writes, unsupported transport detection, existing HTTP unverified/probe-failed behavior, JSON import preview classification, needs-value drafts, update drafts, delete cleanup, and status cache updates.
- Route tests should cover workspace view/edit access: view can read inventory, edit/owner can mutate, and view receives 403 for writes.
- Probe tests should use injected probe runners rather than live network by default, with separate integration coverage for runtime-context dispatch.
- Docker probe behavior should be tested at the command/build-args boundary with injected Docker clients; full container integration can be manual or gated.
- Frontend tests should cover tab access, view-only disabled controls, import preview formatting, state badges, and API client request shapes.
- Every release-blocking acceptance scenario must include a Computer Use regression pass in the running app. The pass must record the browser URL, workspace, role, action path, expected visible state, and observed result from `get_app_state` / click / type interactions.
- Existing prior art includes Node test runner backend tests, `tsx --test` frontend helper tests, workspace access tests, provider MCP tests, and main content tab access tests.

## Out of Scope

- Full cloud marketplace backend, ranking, reviews, takedown workflows, or curated remote catalog.
- User-level skill management and cross-workspace user skill reuse.
- Private GitHub skills, GitHub tokens, GitHub OAuth, or enterprise SSO for skill installation.
- Running third-party install scripts or package managers during skill installation.
- Automatic skill updates, update checks, or merge workflows.
- User/local MCP config management.
- Provider fan-out from the Tools page.
- stdio/SSE MCP connection from the Tools page.
- Starting local MCP server commands from the workspace UI.
- HTTP MCP OAuth, token refresh, per-user authorization, secret masking, permission isolation, or audit logs.
- Hot-updating currently running Agent turns after skill or MCP changes.

## Further Notes

- The PRD intentionally separates product inventory state from Agent runtime state. Runtime-loadable config can exist before CloudCLI has healthy probe metadata.
- The safest implementation path is to add focused backend services for workspace skills and workspace tools, then expose thin routes and UI hooks.
- The high-fidelity mockups are static review artifacts, not production implementation files.
- Future iterations should add user-level skill management, user/local MCP scope management, secret handling, and OAuth once the workspace-level model is proven.
