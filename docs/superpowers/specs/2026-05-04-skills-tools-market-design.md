# Skills 与 Tools 目录需求设计

日期：2026-05-04
状态：Draft for review
高保真稿：`scratch/designs/skills-tools-market/index.html`

## 背景

CloudCLI 当前已经有 `Chat`、`Shell`、`Files`、`Source Control`、`Tasks` 以及插件动态 Tab。文件、终端、Git 都是 workspace 内的一等工作区能力，但“Agent 当前能用哪些技能、哪些工具、哪些 MCP server”仍分散在 Settings、命令扫描、权限配置和 MCP 配置里。

本需求新增 `Skills` 与 `Tools` 两个与 `Files` 平行的目录/Tab：

- `Skills`：查看当前 workspace 中可被 Agent 使用的技能，并支持安装第三方开源技能。
- `Tools`：查看当前 workspace 中用户/Agent 可用的工具，并支持对接 HTTP MCP server。

## 目标

- 让用户能快速回答：“当前 workspace 的 Agent 会什么？”
- 让用户能快速回答：“当前 workspace 的 Agent 能调用哪些工具？”
- 把技能和工具从隐藏配置变成主工作区里的可观察、可管理对象。
- 复用现有 `.claude/skills`、插件技能扫描、权限设置和 MCP 配置写入能力。
- 让新增能力保持 workspace 隔离，符合现有多租户/Workspace 边界。

## 非目标

- v1 不做完整云端 marketplace 后台，也不做远程技能市场列表、评分、排行、审核和下架机制。
- v1 第三方技能只安装到当前 workspace，不提供 user/global 安装入口，也不展示 user-level skills。
- v1 不支持私有 GitHub 仓库，不支持粘贴 GitHub token 或 OAuth 授权安装。
- v1 不执行第三方技能仓库里的脚本、安装脚本或构建命令。
- v1 MCP server 只支持 project/workspace 级配置，不提供 user/local MCP 配置入口。
- v1 MCP 只支持 HTTP transport；不支持 stdio / SSE，也不在 workspace 中启动本地 MCP 命令。
- v1 HTTP MCP endpoint 允许 `http://` 与 `https://` URL。
- v1 HTTP MCP endpoint 允许 localhost、127.0.0.1 和内网地址；UI 必须标记为 local/private endpoint，并提示 Docker runtime 下容器可能无法直接访问宿主机 localhost。
- v1 HTTP MCP 认证不做 OAuth、token refresh 或按人授权；只支持手动填写 headers / token / env values，并保存为 workspace 可见配置。
- v1 Tools 页不展示 Claude / Codex / Gemini / Cursor provider 选择，也不提供跨 provider fan-out；只管理当前 workspace 的 project MCP config。
- v1 Tools 页不直接编辑 built-in tools 权限策略；只展示权限状态，并跳转或打开现有 Settings > Agents > Permissions。
- v1 MCP 支持把连接所需 env/header/token 值保存到当前 workspace 的 project/workspace MCP config；v1 不做密钥脱敏存储、权限隔离或审计。
- v1 不替代 Settings > Agents > MCP；新 Tools 页是主工作区入口，Settings 保留 provider-specific 高级配置入口。
- v1 `Test connection` 需要做真实 MCP probe；工具级 discovery 是 best-effort，失败时必须展示失败原因，不能把该 server 标记为 connected。

## 信息架构

主内容区 Tab 调整为：

```text
Chat | Shell | Files | Skills | Tools | Source Control | Tasks | plugin tabs
```

规则：

- `Skills`、`Tools` 与 `Files` 同级，受当前 selected workspace 影响。
- 本需求不新增、不改造左侧会话侧边栏；高保真稿里的左侧栏只用于承载现有 app shell 上下文。
- `Runtime Monitor` 属于 Admin / Settings 的运行时治理域，不进入主内容区 Tab，也不与 `Skills`、`Tools`、`Files` 平级。
- 权限沿用现有 workspace 权限模型，不新增 Skills / Tools 专属角色。
- Workspace `owner` / `edit` 可安装、启用/禁用、卸载 workspace skills，并可新增、编辑、删除 workspace MCP servers。
- Workspace `view` 可以查看清单、MCP server 配置和值、built-in tool 权限状态，但不能安装、启用/禁用、删除技能，也不能写入 MCP 配置。
- System admin 沿用现有租户/工作区逻辑，获得等效 `edit` 管理能力。
- 移动端继续使用现有横向 pill tab 滚动。
- 插件 Tab 保持在内置 Tab 之后。

## UX 高保真设计

高保真静态稿已放在：

```text
scratch/designs/skills-tools-market/index.html
scratch/designs/skills-tools-market/tools.html
```

`index.html` 是包含 Skills、Tools、安装弹窗的完整评审稿；`tools.html` 是单独展开的 Tools 页面，打开后默认只展示 Tools 设计。

设计包含三组画面：

- `Skills` 主页面：技能列表、搜索、来源筛选、安装入口、右侧详情。
- `Tools` 主页面：内置工具与 MCP server 统一清单、类型/状态过滤、连接入口、右侧详情。
- `Install Skill from GitHub` 弹窗：GitHub URL、安装 scope、manifest 预览、风险提示、确认安装。

视觉原则：

- 延续当前 CloudCLI 的浅色、密集、工具型 SaaS 风格。
- 使用 8px 内的圆角、紧凑列表、右侧详情面板，而不是营销式市场首页。
- 主要操作放右上角：`Install from GitHub`、`Connect MCP Server`。
- 列表卡片强调状态、来源、scope、风险，而不是装饰。

## Skills 页面设计

### 页面结构

- Header：`Skills` 标题、workspace 名称、说明文案。
- Summary：可用技能数、workspace 技能数、disabled 数。
- Toolbar：搜索框、`Installed / Available` 分段筛选、scope chip、`Install from GitHub`。
- List：技能卡片，按 `Workspace` 与 `Built-in & Plugin` 分组。
- Detail panel：当前选中技能详情。

### 技能卡片字段

- `name`
- `description`
- 状态：enabled / disabled / not installed
- 来源：workspace / plugin / bundled
- 标签：debugging、planning、review、frontend 等
- 风险：instruction-only、network-related、filesystem-related、credentials-mentioned

### 技能详情字段

- `SKILL.md` 路径
- 来源 URL 与 pinned commit
- 触发词或适用场景
- 包含文件
- 风险说明
- 操作：打开 `SKILL.md`、启用/禁用、卸载、复制路径

### 安装第三方技能流程

1. 用户点击 `Install from GitHub`。
2. 输入 GitHub repo URL、repo 子目录 URL 或直接 archive URL。
3. 后端拉取元数据并验证目标目录存在 `SKILL.md`。
4. UI 展示检测到的 name、description、文件列表、来源与风险提示。
5. 如果检测到同名 unmanaged workspace skill，即 `.claude/skills/<skill-name>` 存在但 `.cloudcli/skills` metadata 中无对应条目，安装被阻止，不允许覆盖。
6. 用户确认 `Install and enable`。
7. 后端安装到当前 workspace 的 `.cloudcli/skills/<skill-name>` 管理目录，并将 enabled skill 物化到 `.claude/skills/<skill-name>`；v1 不写入 user/global skills。
8. 刷新技能列表和命令/技能发现缓存，并提示该变更对下一个 Agent turn 或显式 session reload 生效，不热更新当前正在运行的 Agent turn。

### 安全约束

- 安装第三方技能前必须预览。
- 技能是“会影响 Agent 行为的指令”，UI 需要明确提示。
- 安装阶段不运行仓库脚本、不执行 package manager、不加载动态代码。
- 如果 repo 里有多个技能，用户必须选择明确子目录。
- 删除 workspace 技能会删除本地文件，必须二次确认。
- v1 只支持公开 GitHub HTTPS 来源：repo URL、tree 子目录 URL、release/archive URL。
- v1 不支持 SSH URL、GitLab、Bitbucket、self-hosted Git、本地路径或任意非 GitHub 下载源。
- v1 不支持私有 GitHub 仓库、GitHub token 粘贴、GitHub OAuth 授权或企业 SSO 流程。
- 安装时必须解析并固定到 commit SHA，写入 metadata。
- v1 不做自动更新、一键更新或 remote revision 检查；如果用户用相同 name 重新安装，需要展示覆盖预览并二次确认。
- 同名重新安装允许覆盖，作为 v1 的手动更新路径；覆盖必须先展示已有来源、已有 commit、新来源、新 commit，以及文件级 added / modified / removed 摘要。
- 同名重新安装只适用于 CloudCLI managed workspace skill；如果冲突对象是 unmanaged `.claude/skills/<skill-name>`，v1 阻止安装并展示 `Name conflict with unmanaged workspace skill`。
- 覆盖安装成功后保留原 enabled 状态；原先 enabled 的 skill 重新物化到 `.claude/skills/<skill-name>`，原先 disabled 的 skill 继续不物化。
- 覆盖安装失败不得修改当前已安装版本。
- v1 不支持 merge；如果 managed source 有本地修改，必须提示并要求用户确认覆盖。

## Tools 页面设计

### 页面结构

- Header：`Tools` 标题、workspace 名称、说明文案。
- Summary：工具总数、HTTP MCP server 数、blocked 数。
- Toolbar：搜索框、`All / Built-in / MCP` 分段筛选、workspace 状态 chip、`Connect MCP Server`。
- List：内置工具与 MCP server 统一卡片。
- Detail panel：built-in tool 权限状态详情或 MCP 配置详情。

### 工具类型

- Built-in tools：Read、Write、Edit、MultiEdit、Bash、Glob、Grep、WebFetch、WebSearch、Task 等。
- MCP servers：当前 workspace 已配置的 HTTP server。
- MCP tools：未来可由连接探测返回的 server 暴露工具列表。

### Unsupported MCP 配置边界

- 如果 `<workspace>/.mcp.json` 中已经存在非 HTTP MCP 配置，例如旧的 stdio / SSE server，Tools 页 v1 展示为 `unsupported` 只读卡片。
- unsupported MCP config 不允许 `Test connection`、`Edit config` 或 `Connect server`。
- unsupported MCP config 不计入 HTTP MCP connected 数，也不进入 Agent 可用工具列表的 v1 管理态。
- unsupported MCP config 可以执行 `Remove unsupported config`；二次确认后从 `<workspace>/.mcp.json` 删除，并同步清理同名 status/draft metadata。
- unsupported 详情需要解释：v1 only supports HTTP MCP servers.

### Existing HTTP MCP 配置边界

- 如果 `<workspace>/.mcp.json` 中已经存在手写 HTTP MCP server，但没有 `<workspace>/.cloudcli/mcp/status.json` 对应 probe cache，也没有 CloudCLI draft metadata，Tools 页展示为 `existing HTTP config / unverified`。
- existing HTTP config 已经位于 Agent runtime 可加载配置中，因此必须出现在 MCP 列表里，不能隐藏或当作 draft。
- unverified HTTP config 不展示 healthy、connected tools count 或 last successful probe；只展示 endpoint、transport、scope 和配置值。
- `Test connection` 从真实 Agent runtime context 发起 probe；成功后写入 `<workspace>/.cloudcli/mcp/status.json`，状态切换为 connected/healthy，并展示 discovered tools count。
- existing HTTP config 的 probe 失败不阻止新的 Agent turn，不修改或删除 `<workspace>/.mcp.json`，也不把该 config 变成 draft；Tools 页展示 `probe failed / runtime-loadable`，保留失败阶段、错误摘要和下一步建议。
- existing HTTP config probe 失败后仍不展示 tools count 或 healthy；用户可继续 `Edit config` 或二次确认 `Remove server`。
- 一旦用户通过 Tools 页编辑 existing HTTP config，新配置进入 CloudCLI-managed edit 流程：必须静态校验通过且真实 probe 成功后才能覆盖 `<workspace>/.mcp.json`。
- existing HTTP config 编辑后的新配置 probe 失败时，旧 `.mcp.json` 配置继续保持 runtime-loadable；失败的新配置保存为 update draft，不覆盖旧配置。
- `Edit config` 和 `Remove server` 按 workspace `owner` / `edit` 权限执行；删除仍需要二次确认，并同步清理可能存在的 status/draft metadata。

### Built-in Tool 权限边界

- v1 Tools 页展示 built-in tools 的当前 permission state：allowed / prompt required / blocked。
- v1 不在 Tools 页提供内联权限编辑器，不复制 Settings > Agents > Permissions 的规则编辑能力。
- built-in tool 卡片操作使用 `Open permissions` 入口，打开现有权限配置页面或对应 Settings 弹层。
- Tools 页可以展示权限摘要、blocked pattern、scope 和来源，但保存权限变更仍由现有权限设置承担。

### 工具卡片字段

- 名称
- 类型：built-in / MCP
- 状态：allowed / prompt required / blocked / connected / needs token / error
- scope：project/workspace
- transport：HTTP
- 暴露工具数和最近连接测试结果
- 配置摘要，v1 可直接展示 env/header/token 值，所有 workspace 成员可见
- 连接参数状态：provided / missing / invalid

### MCP 接入流程

1. 用户点击 `Connect MCP Server`。
2. 默认进入 form mode，输入 server name。
3. scope 固定为当前 workspace 的 project MCP config：`<workspace>/.mcp.json`；v1 不展示 provider、user、local scope 选择。
4. transport 固定为 HTTP；v1 不展示 transport 选择。
5. 填写 URL、headers、env/header/token values，或切换到 JSON import。
6. 点击 `Test connection`，后端先做静态配置校验，再对 HTTP endpoint 做真实 MCP probe，并展示校验、请求、工具发现三类结果。
7. 如果 probe 成功，用户可以确认 `Connect server`，后端写入 `<workspace>/.mcp.json` 并启用。
8. 如果静态校验通过但 probe 失败，用户可以选择 `Save as draft`，后端写入 CloudCLI 管理的 draft metadata，例如 `<workspace>/.cloudcli/mcp/drafts.json`；draft 不写入 `<workspace>/.mcp.json`，因此不会被 Agent runtime 加载。
9. 刷新 Tools 列表，并提示该 server 已保存，但 v1 不对正在运行的 Agent turn 做热更新。
10. 新增 MCP server 对后续 Agent turn 或显式 session reload 生效；UI 提供 `Reload session` / `Start new session` 入口，避免打断当前运行中的 Agent。

### JSON Import 流程

1. 用户在 `Connect MCP Server` 中切换到 JSON import，并粘贴一个 `.mcp.json` 结构。
2. 后端解析 `mcpServers`，一次 import 可以包含多个 server。
3. UI 进入批量 preview，不做静默批量写入。
4. 每个 server 独立展示状态：HTTP valid、unsupported transport、duplicate name、missing token/env/header value、invalid JSON / invalid URL。
5. 只有 HTTP server 可被选择进入连接流程；stdio / SSE / unsupported transport 不可选，不写入 connected 或 draft。
6. duplicate name 不自动覆盖；用户必须进入对应 replace/edit 流程，且仍需二次确认与 probe 成功。
7. 用户选择一个或多个 HTTP server 后，每个 server 独立执行静态校验和 runtime-context probe。
8. 单个 server probe 成功时写入 `<workspace>/.mcp.json` 并刷新 status cache。
9. 单个 server 静态校验通过但 probe 失败时保存为 draft；失败不影响同批次其他 server。
10. 如果 HTTP server 结构有效但缺少 token / env / header value，允许保存为 `needs value` draft；该 draft 不写入 `<workspace>/.mcp.json`，不进入 Agent 可用工具列表。
11. `needs value` draft 必须补齐缺失 key 并真实 probe 成功后，才能物化到 `<workspace>/.mcp.json`。
12. 无效 JSON、无效 URL、unsupported transport、server name 非法等静态结构错误不能保存为 draft。
13. 批量 import 支持 partial success 汇总：connected、drafted、needs value、skipped、blocked 分别计数，并显示每个 server 的下一步动作。

### MCP 编辑流程

1. 用户编辑已经 connected 的 MCP server，或通过 Tools 页编辑 existing HTTP config。
2. 后端对新配置执行与新增流程相同的静态校验和真实 probe。
3. 如果 probe 成功，后端原子替换 `<workspace>/.mcp.json` 中同名 server 配置，并刷新 Tools 列表。
4. 如果静态校验通过但 probe 失败，旧的 connected 或 existing HTTP 配置继续保留在 `<workspace>/.mcp.json` 并保持 Agent 可用。
5. 失败的新配置保存为 update draft，写入 `<workspace>/.cloudcli/mcp/drafts.json`，并标记 `replaces: "<serverName>"`。
6. update draft 重新 `Test connection` 成功后，才能原子替换 `<workspace>/.mcp.json` 中的旧 connected 配置，并删除对应 draft。

### MCP 删除流程

1. 用户点击 connected MCP server 的 `Remove server`。
2. UI 展示二次确认，列出将删除的 runtime config、probe cache、关联 draft 和配置值。
3. 用户确认后，后端从 `<workspace>/.mcp.json` 删除该 server 配置。
4. 后端从 `<workspace>/.cloudcli/mcp/status.json` 删除该 server 的 probe cache。
5. 后端从 `<workspace>/.cloudcli/mcp/drafts.json` 删除同名 create draft，以及 `replaces` 指向该 server 的 update draft。
6. 配置内保存的 env/header/token 值随配置或 draft 一起删除。
7. v1 不保留 tombstone、history 或 audit metadata。

### MCP Probe 要求

- 静态校验：server name、transport 必须为 HTTP、URL、headers、env/header/token 名称、JSON 格式、重复 server name。
- URL scheme 允许 `http://` 和 `https://`；其他 scheme 静态校验失败。
- URL host 允许 public domain、localhost、127.0.0.1 和 private IP；localhost/private IP 需要在 UI 中标记 `local/private endpoint`。
- Docker runtime 下，如果 URL 是 localhost / 127.0.0.1，Tools 页需要提示该地址在容器内可能指向容器自身，而不是宿主机；后续实现可复用现有 network host 解析策略。
- 真实 probe：对 HTTP endpoint 尝试 initialize；如果 server 支持工具发现，则继续调用 tools/list。
- probe 必须从真实 Agent 执行上下文发起：local runtime 使用后端本机上下文，Docker runtime 使用容器内或等价 Docker network namespace。
- Docker runtime 下不能只依赖浏览器、前端或宿主机后端 probe，因为 `localhost` / `127.0.0.1` 在容器内可能指向不同目标。
- 如果当前 workspace 使用 Docker runtime 且没有运行中的 session container，v1 启动短生命周期 probe container，复用 Agent runtime 的镜像、网络和必要 workspace mount，只执行 initialize/tools-list，超时后销毁；不需要启动真实 Agent turn。
- v1 不支持 stdio / SSE；JSON import 中出现非 HTTP transport 时静态校验失败，不允许保存为 connected 或 draft。
- JSON import 支持一次预览多个 `mcpServers`，但每个 server 独立静态校验和 probe；不允许静默批量写入。
- JSON import 中 HTTP server 结构有效但缺 token / env / header value 时，可保存为 `needs value` draft；无效 JSON、无效 URL、unsupported transport 不可保存 draft。
- 已存在于 `<workspace>/.mcp.json` 的非 HTTP MCP 配置只展示为 unsupported read-only，不做 probe，不写入 draft，不计入 HTTP connected 数。
- 已存在于 `<workspace>/.mcp.json` 的 HTTP MCP 配置如果没有 probe cache，则展示为 unverified；允许 `Test connection`，但 probe 成功前不能显示为 healthy，也不能展示 tools count。
- 已存在 HTTP MCP 配置的 probe 失败不阻止 Agent runtime 继续使用原 `.mcp.json`；该失败只影响 Tools UI 的健康状态和 status cache。
- probe 必须有短超时，建议 8-15 秒。
- probe 成功时展示发现的 tools 数量和名称预览。
- probe 成功时将 initialize/tools-list 结果、latency、testedAt、probeContext、runtimeMode 持久化到 `<workspace>/.cloudcli/mcp/status.json`；该文件只供 Tools UI 和诊断使用，不供 Agent runtime 加载。
- probe 失败时展示失败阶段、错误摘要和下一步建议；该 server 不能显示为 connected。
- connected server probe 失败时，保留上一份成功的 tools-list 缓存，但在 `<workspace>/.cloudcli/mcp/status.json` 标记 `state: "stale"` 或 `state: "error"`，并记录失败原因与失败时间。
- 静态校验失败时不允许保存，例如 JSON 无效、server name 重复、transport 缺少必填字段。
- 静态校验通过但真实 probe 失败时允许 `Save as draft`；draft server 状态为 `needs setup` / `error`，保存在 `<workspace>/.cloudcli/mcp/drafts.json`，不写入 `<workspace>/.mcp.json`，也不进入 Agent 可用工具列表。
- draft server 必须重新 `Test connection` 成功后，才能从 draft metadata 物化到 `<workspace>/.mcp.json`，切换为 connected 并进入 Agent 可用工具列表。
- 对已 connected server 的编辑如果 probe 失败，必须生成 update draft，不能覆盖 `<workspace>/.mcp.json` 中的旧可用配置。
- 缺少 token/env 时展示缺少的变量名；已填写的值在 v1 按 workspace 可见配置展示。

### MCP 连接值保存要求

- v1 需要支持在 `Connect MCP Server` 流程中保存 env/header/token 值。
- v1 不支持 OAuth 授权跳转、token refresh、按人授权或按用户保存 token。
- HTTP MCP 认证信息由用户手动填写，例如 `Authorization: Bearer <token>`、自定义 headers、env values。
- connected server 的 env/header/token 值随 `<workspace>/.mcp.json` 保存；draft server 的 env/header/token 值随 `<workspace>/.cloudcli/mcp/drafts.json` 保存。
- 两类值都属于当前 workspace 的共享连接配置。
- 所有拥有当前 workspace view access 的用户都可以看到 MCP server 及其配置值；v1 不做 secret reference、mask 展示、按人权限隔离或审计。
- JSON import 中如果包含 env/header/token 值，v1 按原配置保存到 workspace 可见 MCP config 或 draft metadata。
- probe 执行时直接使用当前表单、draft metadata 或 MCP config 中的值；probe 成功/失败结果不需要额外保存密钥状态。
- 移除 connected MCP server 时同步删除 `<workspace>/.mcp.json` 中的 server 配置、其中保存的 env/header/token 值、`<workspace>/.cloudcli/mcp/status.json` 中的 probe cache，以及 `<workspace>/.cloudcli/mcp/drafts.json` 中同名或 `replaces` 指向该 server 的 draft；v1 不保留 tombstone、history 或 audit metadata。

## 功能需求

### Skills

- 展示 `<workspace>/.cloudcli/skills/**/SKILL.md` 中由 CloudCLI 管理的 workspace skills。
- 将 `<workspace>/.claude/skills/**/SKILL.md` 视为 Claude Code CLI 可见的 workspace skill 目录；其中 CloudCLI 管理的 enabled skills 由 metadata 生成/同步。
- 如果 `<workspace>/.claude/skills/<skill-name>` 存在，但 `<workspace>/.cloudcli/skills` metadata 中没有对应条目，v1 识别为 `unmanaged workspace skill`，只读展示，不允许 enable/disable/uninstall。
- CloudCLI 的 enable/disable/uninstall 只能作用于自己管理的 `<workspace>/.cloudcli/skills` 条目，不能覆盖或删除 unmanaged workspace skill 文件。
- v1 不提供 unmanaged skill import；后续可新增 `Import into workspace management`。
- 展示 enabled plugin install path 下的 `skills/**/SKILL.md`，作为只读能力来源。
- 展示 bundled/system skills，作为只读能力来源。
- v1 不扫描、不展示、不管理 `~/.claude/skills/**/SKILL.md` 等 user-level skills。
- 解析 frontmatter：`name`、`description`、可选 tags。
- 解析失败的技能不能静默消失，需要展示 invalid 状态和错误原因。
- 支持从公开 GitHub HTTPS 安装 workspace 级技能。
- 从 GitHub 安装的 v1 写入目标固定为当前 workspace，不提供 user/global scope 选择。
- 支持 workspace 级技能启用/禁用；启用状态必须真实影响 Agent 运行时技能发现结果。
- 支持 workspace 级技能卸载。
- v1 不支持 workspace 技能自动更新或一键更新。
- plugin / bundled skills 只读展示，不支持从 Skills 页启用、禁用、更新或卸载。
- plugin / bundled skills 详情页只保留 `View details`、`Copy path` 等只读操作。
- 安装新 workspace skill 后默认 `enabled: true`，安装确认弹窗必须提示该技能会影响 Agent 行为。
- `enabled: false` 的 workspace skill 保留文件和 metadata，但不进入 Agent 可用 skill 列表；列表中仍显示为 `disabled`，并支持重新启用。
- Docker runtime 模式下，当前 workspace 中 `enabled: true` 的 skill 必须能被容器内 Claude Code CLI 加载到；host 与 container 的 workspace skill 视图不能不一致。
- 安装、启用、禁用、卸载 workspace skill 后，workspace 文件状态立即更新，但 v1 不热更新当前正在运行的 Agent turn。
- Skills 变更只对下一个 Agent turn、显式 `Reload session` 或 `Start new session` 生效；UI 需要展示 `Applies on next turn or reload`。
- v1 采用 managed source + runtime-visible directory 模型：`.cloudcli/skills` 是 CloudCLI 管理源，`.claude/skills` 是 Claude Code CLI 当前可见目录。
- v1 必须提供确定性 reconcile：根据 `.cloudcli/skills/skills.json` 和 managed skill 目录同步 `.claude/skills` 中的 CloudCLI managed 条目。
- reconcile 触发时机：打开 Skills 页、安装/启用/禁用/卸载后、Agent turn 启动前。
- reconcile 规则：metadata 中 `enabled: true` 的 managed skill 必须物化到 `.claude/skills/<skill-name>`；`enabled: false` 的 managed skill 必须从 `.claude/skills/<skill-name>` 移除；uninstall 的 managed skill 必须删除管理源和物化副本。
- reconcile 只能处理 CloudCLI managed 条目；不得删除、覆盖或重命名 unmanaged `.claude/skills/<skill-name>`。
- reconcile 失败时 Skills 页展示 `sync error`，列出失败文件路径和错误摘要，并提供 `Repair sync` 手动重试入口。
- Agent turn 启动前 reconcile 失败时必须 fail closed：阻止新的 Agent turn 启动，展示 `Skill sync failed` 和 `Repair sync`，避免 disabled skill 仍被加载或 enabled skill 缺失。
- Agent turn 启动前 reconcile 失败不打断已经运行中的 Agent turn；只阻止新的 turn / reload / start new session。
- disable workspace skill 时，从 `.claude/skills/<skill-name>` 移除物化副本，但保留 `.cloudcli/skills/<skill-name>` 源文件和 metadata。
- enable workspace skill 时，将 `.cloudcli/skills/<skill-name>` 同步/物化到 `.claude/skills/<skill-name>`。
- uninstall workspace skill 时，同时删除 `.cloudcli/skills/<skill-name>` 源文件、metadata 和 `.claude/skills/<skill-name>` 物化副本；v1 不保留 tombstone、history 或 audit metadata。
- 对 unmanaged workspace skill，disable / uninstall 操作不可用；CloudCLI 不删除 `.claude/skills/<skill-name>` 中的手动文件。

### Tools

- 展示现有 built-in tool permission list。
- built-in tool permission 在 Tools 页只读展示；修改权限时打开现有 Settings > Agents > Permissions，不在 Tools 页直接保存。
- 展示当前 workspace 可见的 HTTP MCP servers。
- 只读展示 `<workspace>/.mcp.json` 中的非 HTTP MCP configs 为 unsupported，允许删除，不允许编辑或 test。
- 即使没有 MCP server，也展示 built-in tool inventory。
- 支持添加 project/workspace 级 HTTP MCP server。
- 支持 form 与 JSON 两种输入。
- 支持保存 MCP server 所需的 env/header/token 值。
- v1 对 workspace 成员直接展示已保存的 env/header/token 值；不做 mask 或 secret reference 管理。
- v1 Tools 页将 `<workspace>/.mcp.json` 作为唯一 Agent runtime 可加载写入目标；不写 user/local MCP config，也不向 Claude / Codex / Gemini / Cursor 多 provider 配置 fan-out。
- 只有 probe 成功且 connected 的 MCP server 才写入 `<workspace>/.mcp.json`；draft server 只写入 `<workspace>/.cloudcli/mcp/drafts.json`。
- 删除 connected MCP server 时，彻底清理 `.mcp.json`、`.cloudcli/mcp/status.json`、相关 `.cloudcli/mcp/drafts.json` entry 和配置值；v1 不保留 tombstone、history 或 audit metadata。
- 可复用 Settings > Agents > MCP 中 project scope 的后端读写逻辑，但需要通过 workspace-level adapter 固定到当前 workspace。

## 数据设计

### Workspace Skill Metadata

第三方技能内容保持现有 `SKILL.md` 兼容目录结构，但 v1 使用两层目录：

- 管理源：`<workspace>/.cloudcli/skills/<skill-name>/`
- Claude CLI 可见 enabled view：`<workspace>/.claude/skills/<skill-name>/`

安装元数据单独保存在 CloudCLI 管理目录下：

```json
{
  "skills": {
    "gh-address-comments": {
      "enabled": true,
      "source": {
        "type": "git",
        "url": "https://github.com/mattpocock/skills",
        "subpath": "skills/gh-address-comments",
        "commit": "abc123"
      },
      "installedAt": "2026-05-04T00:00:00.000Z",
      "installedBy": 1
    }
  }
}
```

推荐位置：

```text
<workspace>/.cloudcli/skills/skills.json
```

技能文件位置：

```text
<workspace>/.cloudcli/skills/<skill-name>/SKILL.md
<workspace>/.claude/skills/<skill-name>/SKILL.md   # enabled materialized copy
<workspace>/.claude/skills/<manual-name>/SKILL.md  # unmanaged workspace skill, read-only in v1
```

同步不变量：

- `.cloudcli/skills/skills.json` 是 CloudCLI managed skills 的 source of truth。
- `.claude/skills` 是 Claude Code CLI 运行时可见目录，可能同时包含 CloudCLI managed 物化副本和 unmanaged 手动目录。
- CloudCLI reconcile 只维护自己在 metadata 中拥有的 managed entries。
- 如果 `.claude/skills/<managed-name>` 缺失但 metadata 为 enabled，reconcile 重新物化。
- 如果 `.claude/skills/<managed-name>` 存在但 metadata 为 disabled，reconcile 移除该 managed 物化副本。
- 如果 `.claude/skills/<name>` 没有 metadata owner，reconcile 只读识别为 unmanaged，不做破坏性操作。

### Tool Inventory

Tools 页由以下来源组合：

- built-in tool catalog
- permission settings，built-in tool 权限只读展示
- `<workspace>/.mcp.json` 中的 project/workspace-visible MCP config，包括 env/header/token 值
- `<workspace>/.cloudcli/mcp/drafts.json` 中的 draft MCP config，包括 env/header/token 值、probe 错误摘要、lastTestedAt
- `<workspace>/.cloudcli/mcp/status.json` 中的 MCP probe cache，包括 tools-list、latency、testedAt、state、lastError

### Workspace MCP Draft Metadata

Draft MCP server 是 CloudCLI 管理态，不是 Agent runtime 配置。它可以是新 server 的 create draft，也可以是替换现有 connected server 的 update draft。推荐位置：

```text
<workspace>/.cloudcli/mcp/drafts.json
```

示例：

```json
{
  "drafts": {
    "github": {
      "mode": "create",
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp",
      "headers": {
        "Authorization": "Bearer ghp_example"
      },
      "status": "needs setup",
      "lastProbe": {
        "ok": false,
        "stage": "initialize",
        "message": "401 Unauthorized",
        "testedAt": "2026-05-04T00:00:00.000Z"
      },
      "updatedAt": "2026-05-04T00:00:00.000Z",
      "updatedBy": 1
    },
    "context7": {
      "mode": "update",
      "replaces": "context7",
      "transport": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "Authorization": "Bearer ctx7_new_key"
      },
      "status": "error",
      "lastProbe": {
        "ok": false,
        "stage": "tools/list",
        "message": "Server initialized but tools/list timed out",
        "testedAt": "2026-05-04T00:00:00.000Z"
      },
      "updatedAt": "2026-05-04T00:00:00.000Z",
      "updatedBy": 1
    }
  }
}
```

### Workspace MCP Probe Status Metadata

Probe status 是 CloudCLI 管理态，不是 Agent runtime 配置。推荐位置：

```text
<workspace>/.cloudcli/mcp/status.json
```

示例：

```json
{
  "servers": {
    "context7": {
      "state": "connected",
      "transport": "http",
      "lastProbe": {
        "ok": true,
        "latencyMs": 182,
        "testedAt": "2026-05-04T00:00:00.000Z"
      },
      "tools": [
        {
          "name": "resolve-library-id",
          "description": "Resolve a package or library name to a Context7 library id"
        },
        {
          "name": "get-library-docs",
          "description": "Fetch documentation for a resolved Context7 library id"
        }
      ]
    },
    "github": {
      "state": "stale",
      "lastSuccessfulProbe": {
        "testedAt": "2026-05-03T00:00:00.000Z",
        "toolCount": 8
      },
      "lastError": {
        "stage": "initialize",
        "message": "401 Unauthorized",
        "testedAt": "2026-05-04T00:00:00.000Z"
      },
      "tools": [
        { "name": "search_issues" },
        { "name": "create_issue" }
      ]
    }
  }
}
```

## API 设计

新增建议：

```text
GET    /api/workspaces/:workspaceId/skills
POST   /api/workspaces/:workspaceId/skills/preview
POST   /api/workspaces/:workspaceId/skills/install
DELETE /api/workspaces/:workspaceId/skills/:name

GET    /api/workspaces/:workspaceId/tools
POST   /api/workspaces/:workspaceId/tools/mcp/test
POST   /api/workspaces/:workspaceId/tools/mcp
POST   /api/workspaces/:workspaceId/tools/mcp/drafts
DELETE /api/workspaces/:workspaceId/tools/mcp/drafts/:serverName
DELETE /api/workspaces/:workspaceId/tools/mcp/:serverName
```

复用已有 API：

```text
POST /api/commands/list
Existing MCP config read/write services behind a workspace-level adapter
```

Tools 页的 workspace-level adapter 必须固定写入当前 workspace 的 `<workspace>/.mcp.json`，不暴露 provider 参数，也不调用 existing global add-to-all-providers API。draft 读写由 CloudCLI 自己管理，不能复用 Agent runtime 可加载的 `.mcp.json` 作为 draft 容器。

## 前端实现边界

新增：

```text
src/components/skills-market/
  SkillsPanel.tsx
  SkillCard.tsx
  SkillDetailPanel.tsx
  InstallSkillDialog.tsx
  hooks/useWorkspaceSkills.ts
  utils/skillFormatting.ts

src/components/tools-market/
  ToolsPanel.tsx
  ToolCard.tsx
  ToolDetailPanel.tsx
  ConnectMcpDialog.tsx
  hooks/useWorkspaceTools.ts
  utils/toolFormatting.ts
```

修改：

- `src/types/app.ts`：`AppTab` 增加 `skills`、`tools`。
- `MainContentTabSwitcher.tsx`：加入 Skills 与 Tools tab。
- `MainContentTitle.tsx`：加入 tab title。
- `MainContent.tsx`：挂载 `SkillsPanel` 与 `ToolsPanel`。
- Settings 的 MCP 页面保留，可复用其 MCP form 组件；Tools 页需要隐藏 provider、user/local scope 和 global add-to-all-providers 入口。
- Settings > Agents > Permissions 保留为 built-in tool 权限编辑入口；Tools 页只调用跳转或打开现有权限 UI，不新增平行权限编辑器。

## 权限与安全

- 权限沿用现有 workspace 权限模型；v1 不新增单独的 Skills admin / Tools admin / MCP admin 角色。
- 查看技能/工具：workspace view access。
- 查看 MCP server 配置和值：workspace view access。
- 查看 built-in tool 权限状态：workspace view access。
- 安装、启用/禁用、卸载 workspace 技能：workspace owner 或 edit access。
- 修改 project MCP 配置：workspace owner 或 edit access。
- 删除 project MCP server、删除 unsupported MCP config、删除 draft：workspace owner 或 edit access。
- System admin 按现有逻辑获得 workspace edit 等效权限。
- View-only 用户看到只读 inventory、配置值和状态；管理按钮 disabled，并展示 `Requires workspace edit access`。
- 修改 built-in tool 权限：沿用现有 Settings > Agents > Permissions 权限模型，不在 Tools 页新增权限模型。
- 删除技能和移除 MCP server 均需要二次确认。
- v1 不做 MCP secret mask、权限隔离或审计；这些能力留到后续迭代。

## 状态设计

Skills：

- Empty：没有 workspace 技能，显示 `Install from GitHub`。
- Invalid：展示 parse error 和文件路径。
- Unmanaged workspace skill：`.claude/skills` 中存在但 `.cloudcli/skills` metadata 不存在；只读展示，不能 disable/uninstall，标注 `unmanaged` 和 `.claude/skills` 来源。
- Unmanaged name conflict：安装 GitHub skill 时，如果目标 name 已存在 unmanaged `.claude/skills/<name>`，阻止安装，不覆盖文件；提示用户手动处理现有目录。
- Pending skill reload：skill install/enable/disable/uninstall 已写入 workspace 文件状态，但当前运行中的 Agent turn 不热更新；提示下一个 Agent turn 或 reload 后生效，并提供 `Reload session` / `Start new session`。
- Sync mismatch：metadata 与 `.claude/skills` runtime-visible 目录不一致；自动 reconcile 先尝试修复，修复成功后刷新列表。
- Sync error：reconcile 失败，展示失败路径与原因，并提供 `Repair sync` 重试；失败期间不删除 unmanaged 文件。
- Skill sync failed：Agent turn 启动前 reconcile 失败；阻止新的 Agent turn，展示失败路径、错误摘要和 `Repair sync`。已运行 turn 不被中断。
- Preview error：展示 missing `SKILL.md`、URL 无效、重复 name、host 不支持等原因。
- Private repo error：展示 `Private repositories are not supported in v1. Use a public GitHub repository.`
- GitHub rate limit：提示稍后重试；v1 不要求用户输入 token。
- Reinstall conflict：同名 workspace skill 已存在时展示覆盖预览，并要求二次确认。
- Reinstall failure：覆盖安装失败时保留当前版本，并展示失败原因。

Tools：

- View-only workspace：展示清单、配置值和 probe/status cache；`Connect MCP Server`、`Edit config`、`Remove server`、`Delete draft`、`Remove unsupported config` 等写操作 disabled，并提示 `Requires workspace edit access`。
- Empty MCP：仍展示 built-in tools，并引导 `Connect MCP Server`。
- Built-in permission read-only：built-in tool 详情展示权限状态和摘要，主操作为 `Open permissions`。
- Existing HTTP config / unverified：`.mcp.json` 中已有 HTTP MCP config 但没有 CloudCLI probe cache；展示为 runtime-loadable but unverified，允许 `Test connection`，probe 成功后写入 `status.json` 并切换为 connected/healthy。
- Existing HTTP config / probe failed：手写 HTTP `.mcp.json` config 的 runtime-context probe 失败；仍展示 runtime-loadable，不阻止新的 Agent turn，不写 draft，不改写 `.mcp.json`，只展示错误和修复入口。
- Existing HTTP config edited：通过 Tools 页编辑后纳入 CloudCLI-managed edit 流程；新配置 probe 成功才覆盖，probe 失败则旧 `.mcp.json` 继续 runtime-loadable，新配置保存为 update draft。
- JSON import preview：一次粘贴多个 `mcpServers` 时展示逐 server 状态；只允许选择 HTTP server，unsupported / duplicate / missing value 状态需要先处理。
- Needs value draft：HTTP server 结构有效但缺少 token / env / header value；可保存为 draft，不写入 `.mcp.json`，补齐缺失值并 probe 成功后才能 connected。
- Partial import success：批量 import 中部分 server connected、部分 drafted、部分 skipped；显示汇总和逐项下一步，不回滚已成功项。
- Unsupported transport：JSON import 或旧配置中出现 stdio / SSE 时，解释 v1 仅支持 HTTP。
- Unsupported existing MCP config：旧的非 HTTP `.mcp.json` 配置只读展示；操作仅保留 `Remove unsupported config`，且不计入 HTTP MCP connected 数。
- Local/private endpoint：HTTP MCP URL 使用 localhost、127.0.0.1 或内网地址时，显示 local/private 标记，并提示 Docker runtime 访问语义。
- Runtime-context probe：`Test connection` 从当前 workspace 的 Agent runtime context 发起；Docker 模式展示 `Docker runtime network`，并在无 session container 时使用短生命周期 probe container。
- Draft MCP：静态校验通过但 probe 失败，配置保存到 `<workspace>/.cloudcli/mcp/drafts.json`，不写入 `<workspace>/.mcp.json`；展示 `Retry test`、`Edit config` 和 `Delete draft`。
- Update draft：编辑 connected server 的新配置 probe 失败，旧配置继续 connected；展示 `Retry update`、`Edit draft`、`Discard draft`，并标注 `Current config still active`。
- Stale probe cache：connected server 最近一次 probe 失败，但仍有上一份成功 tools-list；展示 cached tool list、last successful test、latest error，并提示需要重新测试。
- Remove MCP server：二次确认后彻底删除 connected config、probe cache、相关 draft 和配置值；不保留 tombstone/history/audit。
- Missing value：展示缺少的 env/header/token key。
- Saved value：展示已保存的 env/header/token 值，提示这是 workspace 可见配置。
- OAuth unsupported：用户导入或尝试配置 OAuth 时，提示 v1 仅支持手动 headers/token/env values。
- Auth failed：probe 返回鉴权失败时提示检查或替换对应 env/header/token 值。
- Pending session reload：probe 成功且配置已保存，但当前运行中的 Agent turn 不会被热更新；提示下一个 Agent turn 或 reload 后可用，并提供 `Reload session` / `Start new session`。
- Connection error：展示连接测试摘要和下一步建议。

## 验收标准

- 主内容区 Tab 出现 `Skills` 与 `Tools`，并与 `Files` 平行。
- `Skills` 能列出 workspace skills，并只读展示 plugin / bundled skills。
- `Skills` v1 不展示 user-level skills。
- `Skills` 对 `.claude/skills` 中非 CloudCLI metadata 管理的手动技能只读展示为 unmanaged workspace skill，不覆盖、不删除。
- `Skills` 安装 GitHub skill 时，如果同名 unmanaged workspace skill 已存在，必须阻止安装并提示冲突；不得覆盖 `.claude/skills/<name>`。
- `Skills` 能从公开 GitHub HTTPS 安装 workspace 级技能，安装前有预览确认。
- workspace skill 的 enable/disable 会真实影响 Agent 可用技能列表。
- workspace skill 的 install/enable/disable/uninstall 不热更新当前正在运行的 Agent turn；UI 会说明其对下一个 Agent turn 或 session reload 生效。
- `Skills` 会在打开页面、管理操作后、Agent turn 启动前 reconcile `.cloudcli/skills` metadata 与 `.claude/skills` runtime-visible 目录；reconcile 只处理 CloudCLI managed entries，不碰 unmanaged 手动目录。
- reconcile 失败时展示 `sync error` 与 `Repair sync`，并保留当前文件状态。
- Agent turn 启动前 reconcile 失败时 fail closed，新的 Agent turn 不启动；已运行 turn 不被中断。
- Docker runtime 模式下，workspace 已启用 skill 能被容器内 Claude Code CLI 加载到。
- `Tools` 能列出 built-in tools 与 HTTP MCP servers；built-in tool 权限状态只读展示，编辑通过现有 Settings > Agents > Permissions。
- `Tools` 能通过 form 或 JSON 接入 HTTP MCP server，并在启用前执行真实 MCP probe。
- JSON import 支持多个 `mcpServers` 的批量 preview；每个 server 独立选择、校验和 probe，成功才写入，失败保存为 draft 或 blocked，不做静默批量写入。
- JSON import 中缺 token / env / header value 的有效 HTTP server 可保存为 `needs value` draft；结构无效或 unsupported transport 不能保存 draft。
- `<workspace>/.mcp.json` 中已有的 HTTP MCP 配置如果没有 CloudCLI probe cache，会以 unverified 状态展示；用户执行真实 runtime-context probe 成功后才展示 connected/healthy 和 tools count。
- `<workspace>/.mcp.json` 中已有的 HTTP MCP 配置如果 probe 失败，Tools 页不阻止新的 Agent turn，也不改写运行配置；只标记 `probe failed / runtime-loadable`。
- 通过 Tools 页编辑 existing HTTP MCP 配置后，新配置必须 probe 成功才能覆盖 `.mcp.json`；probe 失败时旧配置保持可加载，新配置保存为 update draft。
- `Tools` 的 `Test connection` 必须从真实 Agent 执行上下文发起；Docker runtime 下需要从容器内或等价 Docker network namespace probe，不能仅使用浏览器或宿主机后端结果作为 connected 判定。
- `Tools` v1 不提供 HTTP MCP OAuth 流程；认证只通过手动 headers/token/env values 配置。
- `Tools` 允许 HTTP MCP URL 使用 public、localhost、127.0.0.1 和内网地址；本地/内网地址必须标记 local/private，并提示 Docker runtime 可达性风险。
- `<workspace>/.mcp.json` 中已有的非 HTTP MCP 配置会以 unsupported 只读状态展示，不允许 test/edit，也不计入 HTTP MCP connected 数；用户可以二次确认删除。
- `Tools` 新增且 probe 成功的 MCP server 只写入当前 workspace 的 `<workspace>/.mcp.json`，不展示 provider 选择，也不写入 user/local 或多个 provider 配置。
- 新增或修改 MCP server 不会打断正在运行的 Agent turn；UI 会说明其对下一个 Agent turn 或 session reload 生效。
- 静态校验通过但 probe 失败的 MCP server 可以保存为 draft；draft 存在 `<workspace>/.cloudcli/mcp/drafts.json`，不能进入 `<workspace>/.mcp.json` 或 Agent 可用工具列表。
- 编辑 connected MCP server 时，如果新配置 probe 失败，旧配置仍保留在 `<workspace>/.mcp.json` 并继续可用；失败的新配置只保存为 update draft。
- `Tools` 持久化 MCP probe 成功结果到 `<workspace>/.cloudcli/mcp/status.json`；probe 失败时保留上一份成功 tools-list，并标记 stale/error。
- 删除 connected MCP server 会同步清理 `<workspace>/.mcp.json`、`<workspace>/.cloudcli/mcp/status.json`、相关 `<workspace>/.cloudcli/mcp/drafts.json` entry 和配置值，不保留 tombstone/history/audit。
- `Tools` 能保存 MCP server 所需 env/header/token 值，并对当前 workspace 成员可见。
- Settings > Agents > MCP 仍可使用。
- Skills / Tools 写操作沿用现有 workspace 权限模型：owner、edit、system admin 可管理；view-only 可查看但不能修改。
- 移动端横向 tab 和单列布局可用。

## 待定问题

- v1 已确定不包含完整 marketplace，只支持从公开 GitHub HTTPS 安装开源技能；后续是否增加 curated examples 另行设计。
- 后续新增 user-level skill 管理，解决同一用户跨 workspace 重复安装相同 skill 的问题。
- 后续新增 user/local MCP config 管理；v1 只做 project/workspace 级 MCP 配置。
- 后续新增 MCP secret mask、权限隔离和审计；v1 中 workspace 级 MCP 连接和值对 workspace 成员可见。
- 后续新增 HTTP MCP OAuth、token refresh 和按人授权；v1 只支持 workspace 级手动 headers/token/env values。
