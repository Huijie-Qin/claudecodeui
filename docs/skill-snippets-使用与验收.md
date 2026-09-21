# 公共片段：使用与验收

实现依据：[第一阶段功能说明第 8 节](skill-market-第一阶段-功能说明.md)、[详细设计第 4 节](skill-market-第一阶段-详细设计.md)。交付公共库管理与文件编辑插入；2026-09-21 按追加需求将“我的技能”和“MCP 工具”名称插入纳入交付。会话创建时的 AI 自动匹配尚未接入。

## 使用

- **技能 → 片段管理**：所有已登录用户可浏览、搜索名称/用途/正文，并查看 Markdown 正文。搜索即时过滤；清空按钮保留输入焦点；结果不再包含所选片段时清空选择。
- **平台管理员**：新增、编辑、删除片段。名称、用途和正文必填。删除弹框明确说明“不影响已插入的技能”。普通用户和租户管理员无法写入公共库。
- **我的技能 → 文件 → 编辑 Markdown → 快速插入**：左侧选择片段，右侧仅预览正文；底部点击“确认”插入，点击“取消”或右上角关闭图标退出。未选择片段、加载中或加载失败时禁用确认。替换当前选区或写入光标处；光标/选区起点位于 frontmatter 时追加到正文末尾。未闭合的 frontmatter 必须先修复。
- 插入只是一次可撤销的编辑，焦点回到文件编辑器；点击保存才通过现有文件接口写入工作区。插入时检查目标文件和内容是否改变。只读工作区不提供编辑与插入。
- 插入后只有普通 Markdown，不保存片段 ID 或运行时引用。公共库后续更新或删除不会回写任何技能。

### 我的技能与 MCP 工具插入

快速插入提供“片段 / 我的技能 / MCP 工具”三个页签。后两项为可搜索名称列表，没有右侧正文预览，使用相同的底部取消/确认按钮。切换类型、关闭后重开会清空选择与搜索，避免误用另一类型的选择；搜索无结果、加载中、接口失败时不能确认。支持刷新、重试、一次撤销及原文件选区保护。

- 我的技能：只读取当前授权工作区的本地清单，包含本地创建和市场已导入的副本；排除系统技能和正在编辑的技能。插入实际 `name`，不插入展示名称、斜杠命令或整套技能文件。
- MCP 工具：读取当前租户公共 MCP 目录中在当前工作区已安装、当前用户已启用的工具，插入 `mcp__<server>__<tool>` 完整名称。列表显示服务来源和工具说明，便于区分同名工具。未安装或用户禁用的工具不在列表内。
- 名称插入不自动安装、启用或执行任何工具，不改变工具偏好，不触发连接探测或凭据助手。仍需用户保存当前技能文件。

新增只读接口 `GET /api/workspaces/:workspaceId/mcp-tools/insertion-catalog`，复用租户和工作区访问校验，返回 `{workspaceId, tools: [{name, description, serverName, serverDisplayName}]}`。只读取已登记的工具元数据，不返回 MCP 配置、凭据或输入 schema。已有 MCP 管理页的实时探测行为保持原样。

公共内容对所有租户可见，不应存入私有上下文、生产凭据或内部数据。预览不解析原始 HTML，不加载 Markdown 远程图片，链接沿用安全 URL 过滤并在新窗口打开。片段内容不会触发工具执行。

## 数据与接口

自动在现有 CCUI SQLite 数据库创建 `skill_snippets` 和 `skill_snippet_audit`；没有 tenant_id。审计只记录操作、操作者、摘要及时间，不存正文历史。数据库备份需包含这两张表。

| 方法 | 路径 | 权限 / 响应 |
| --- | --- | --- |
| GET | `/api/skill-snippets?q=...` | 已登录；`{snippets, canManage}`，搜索覆盖三项文本，大小写不敏感，通配符按普通字符处理 |
| GET | `/api/skill-snippets/:id` | 已登录；`{snippet}` 和 ETag |
| POST | `/api/admin/skill-snippets` | 平台管理员；`201 {snippet}` 和 ETag |
| PATCH | `/api/admin/skill-snippets/:id` | 平台管理员；`200 {snippet}` 和新 ETag |
| DELETE | `/api/admin/skill-snippets/:id` | 平台管理员；成功 204 |

创建提交 `{title, description, markdown}`；PATCH 可只提交变更字段。服务端忽略客户端角色、操作者及 ID 字段。字段均为非空字符串，UTF-8 上限依次为 120、2000、65536 字节。正文原样保存；名称和用途去除首尾空白。不强制片段名称唯一。

PATCH/DELETE 必须带 `If-Match: "<contentHash>"`，缺失返回 428，摘要过期返回 412，不存在返回 404，字段错误返回 400，超限返回 413。摘要是内部并发令牌，不是用户可见版本。管理员遇到冲突时可复制保留草稿，关闭编辑框并刷新，确认最新内容后重新编辑。读取和写入均返回 `Cache-Control: no-store`。

## 验证

```sh
node --test server/services/skill-snippets.test.js server/routes/skill-snippets.test.js
node_modules/.bin/tsx --test src/components/skills-market/snippets/insertion.test.ts
node_modules/.bin/tsx --test src/components/skills-market/snippets/insertionCatalog.test.ts
node --test server/routes/workspace-mcp-tools.test.js server/services/workspace-mcp-tools.test.js
npm run typecheck
```

浏览器验收夹具：`node scripts/skill-snippets-browser-fixture.mjs`，打开 `http://127.0.0.1:5189`。只监听本机，用真实片段路由、独立内存 SQLite 和内存工作区文件，不读写生产数据，重启重置。默认管理员；`?role=member` 为普通用户，`?role=member&readonly` 为只读工作区。夹具的身份切换仅用于本地验收，不接入生产服务器。

已验收：管理员创建/编辑保存、完整预览、无结果清空选择、搜索清空后焦点、frontmatter 保护、插入后未保存状态、一次撤销/恢复、文件保存预览、普通用户隐藏维护入口、只读工作区隐藏编辑入口。服务端测试另覆盖伪造角色、缺少鉴权、跨租户读取、过期编辑/删除、删除后 404、正文搜索及大小限制。
