# CCUI Hook 能力优化与验证报告

> 2026-08-23 的 Hook UI 全量实际页面测试、问题原因与修复回归见《[Hook UI 实际测试问题与修复记录](./Hook%20UI实际测试问题与修复记录.md)》。
>
> 2026-08-24 的最终“用户自助启用 + 工作区完整 Skill/Hook MCP + 原会话执行 + Hook Agent 回滚”方案与 E2E 归档见《[Hook 用户自助启用、工作区资源与原会话执行设计归档](./Hook用户自助启用与工作区资源原会话执行设计归档.md)》。后者代表当前最终架构。

日期：2026-08-18

## 结果摘要

已在当前 CCUI 实例中创建并发布 3 条 Hook，并分别配置三类绑定范围：

1. `SQL 响应指标记录`：正常回答结束时检测 SQL，调用管理员已配置的 MCP Tool 检查语法，并将统计指标写入 `hook_data_records`。
2. `对话正常结束通知`：正常回答结束时调用内置模拟通知 Skill。
3. `失败通知与 HTTP 200 会话恢复`：失败结束时调用同一通知 Skill；错误详情包含精确文本 `HTTP 200` 时，在原 session 中追加恢复回合并重试上一请求。

- `SQL 响应指标记录`：绑定 `Default` 租户，租户后续新增成员会自动生效。
- `对话正常结束通知`：绑定全部有效用户，系统后续新增用户会自动生效。
- `失败通知与 HTTP 200 会话恢复`：仅显式绑定 `root`。

## Claude 模型接入

- 鉴权变量：`ANTHROPIC_AUTH_TOKEN`。密钥只保存在权限为 `600` 的本地 `.env`，未写入源码、Hook、日志或本文档。
- Base URL：`https://ark.cn-beijing.volces.com/api/coding`。
- 用户提供的 `glm-5.1` 在当前 Coding Plan 账户下返回 `UnsupportedModel`；为确保 Claude 可用，当前使用该账户实测 HTTP 200 的 `ark-code-latest` 选择器。
- 真实模型探测和 CCUI WebSocket 模型回合均已成功。

## Hook 配置明细

### 1. SQL 响应指标记录

- 事件：`Stop`
- 执行方式：受控 JavaScript Hook 脚本
- 识别范围：带 `sql` 标签的 fenced code block；未使用 code fence 时，以常见 SQL 起始关键字作为回退判断。
- 数据记录类型：`sql_response_metrics`
- 记录字段：捕获时间、session ID、SQL 块数、总行数、非空行数、语句数、语句类型、字符数。
- 记录方式：脚本只负责识别 SQL 和计算指标；数据库写入由可视化“记录数据”后置行为完成，字段通过下拉变量映射，无需在脚本中调用 `ccui.records.write`。
- MCP 行为：`script.output.detected` 为真时调用 `mcp__sql-syntax-checker__check_sql_syntax`，把 `event.last_assistant_message` 作为输入；具体检查实现由管理员配置的 MCP Server 提供。
- 隐私处理：`hook_data_records` 不保存 SQL 正文；SQL 仅随 Hook 原始事件和 MCP 调用在本次执行中处理。

### 2. 对话正常结束通知

- 事件：`Stop`
- 后置行为：`invoke_skill`
- Skill：`builtin:hook-notification`
- 参数包含：`status=success`、事件名和 session ID。
- Skill 成功执行后，在工作区 `.ccui/hook-notifications.jsonl` 追加 JSONL 记录，并返回标记 `HOOK_NOTIFICATION_SKILL_EXECUTED`。

### 3. 失败通知与 HTTP 200 会话恢复

- 事件：`StopFailure`
- 后置行为：`invoke_skill`
- Skill：`builtin:hook-notification`
- 参数包含：`status=failure`、错误类型、错误详情和 session ID。
- 所有失败都会产生通知；只有参数中同时出现 `status=failure` 和精确文本 `HTTP 200` 时，Skill 才重试失败前的用户请求。
- “重启会话”的实现含义是使用原 `session_id` 向 CCUI 输入队列追加下一优先级恢复回合，而不是重启 Docker 容器或创建无上下文的新会话。
- 每个 Hook/行为在单次 runtime 中有恢复去重键，避免递归触发形成无限循环。

## 发现的能力缺口与优化

### 内置 Hook Skill 来源

原实现存在发布与运行不一致：

- 发布阶段强制要求 Skill 来自另行配置的公共租户 Skill 市场。
- 运行阶段实际只读取当前工作区 `.claude/skills/<name>/SKILL.md`。
- 未配置公共市场时，管理员无法发布任何 `invoke_skill` Hook，即使本地 Skill 已存在。

优化后：

- Hook 配置只使用 `builtin:<name>` 内置 Skill，不再查询或展示公共租户 Skill 市场。
- 创建/更新草稿、发布和运行三个阶段都会拒绝非 `builtin:` Skill，不能通过绕过页面恢复公共市场或工作区 Skill。
- 内置 Skill 使用服务端固定注册表，只接受小写连字符名称、目录名与 manifest 名完全一致的 Skill。
- 发布时验证 Skill ID 与运行名；运行时按 ID 加载随服务构建的只读 Skill，不接受用户工作区路径。
- 管理员 Hook 编辑器明确标注“内置 Hook Skill”，并说明其服务端来源。

### 内置 Hook Skill 清单

当前只有 1 个：

- `builtin:hook-notification`：模拟通知落盘；失败参数同时包含 `status=failure` 和精确文本 `HTTP 200` 时，指示模型在原会话恢复并重试。

### 如何增加内置 Hook Skill

管理员可直接在“Admin → Hooks → 内置 Hook Skill 管理”上传 Skill 文件，无需重建镜像。推荐沿用标准 `SKILL.md` 格式：

```markdown
---
name: my-hook-skill
description: Describe what this Hook follow-up Skill does.
---

Write concise execution instructions here. Payload: $ARGUMENTS
```

管理员上传策略：

1. CCUI 不校验扩展名、文件大小、UTF-8 合法性、frontmatter 字段、名称格式或正文内容，由管理员自行保证 Skill 正确性。
2. 名称优先读取 `frontmatter.name`；没有时使用原文件名推导。再次上传同名 Skill 会原子更新；管理员上传的同名 Skill 可覆盖镜像内置 Skill 的运行时选择。
3. 文件原样持久化到 `CLOUDCLI_HOOK_SKILLS_ROOT` 指定的安全隔离目录；未配置时默认使用 `CLOUDCLI_DATA_ROOT/hook-skills`。服务和镜像重建后仍保留，上传成功后立即进入 Hook Skill 下拉框。
4. 路径隔离、禁止符号链接和“必须实际收到一个文件”仍属于系统安全边界，不是 Skill 内容校验。
5. 当前 Hook 运行器只把 Skill 文件正文注入恢复回合，不会把 Skill 目录下的 `scripts/`、`references/` 或 `assets/` 传入 agent 容器；确定性逻辑应放在 Hook 高级脚本或 MCP 行为中。

需要随镜像交付的系统 Skill 仍可通过代码增加：在 `server/skills/<name>/SKILL.md` 创建文件，并在 `server/services/hook-builtin-skills.js` 的 `BUILTIN_HOOK_SKILL_REGISTRY` 注册后重新构建镜像。

### “记录数据”后置行为

管理员可在任意 Hook 的“后置行为”中直接添加“记录数据”，无需在高级脚本里调用记录 API：

1. 填写记录类型，例如 `sql_response_metrics`。
2. 可选择一个布尔变量作为执行条件；不选择则每次执行都记录。
3. 通过下拉框把事件字段、环境变量、脚本输出或前序行为输出映射成记录字段。
4. 运行时将数据写入 `hook_data_records`，并把 `{ recorded, id, type }` 放入当前行为输出，供后续行为和审计使用。

当前 Docker 部署的 SQLite 文件位于 `DATABASE_PATH` 指向的位置，本机实际为 `/Users/da-group/.cloudcli/ccui/data/auth.db`。查看方式：返回“Admin → Hooks”列表，点击目标 Hook 卡片上的“数据记录”，可查看最近 50 条记录的类型、时间、session ID 和 JSON 内容；服务端接口为 `GET /api/admin/hooks/:hookId/data-records`。

SQL 指标 Hook 已迁移到该后置行为：高级脚本只识别 SQL、计算行数等指标；`script.output.detected` 为真时，后置行为完成数据库写入。

### Hook 按用户绑定

Hook 需要同时覆盖精细授权和自动扩展场景，因此启用范围不能只依赖显式用户行，也不能把发布本身等同于全量启用。

优化后：

1. 发布只生成可用版本，不等同于启用；管理员发布后进入独立的绑定范围配置。
2. 绑定弹窗提供互斥的“指定用户 / 按租户 / 全部用户”三种模式。
3. 指定用户模式写入 `user_hook_bindings`，新用户不会自动加入。
4. 按租户模式写入 `hook_tenant_bindings`；运行时动态关联有效的 `tenant_users`，所以新成员加入租户后立即自动生效。
5. 全部用户模式使用 `activation_scope=all_users` 动态匹配全部有效用户，未来新增并激活的用户自动生效。
6. 保存采用事务整组替换三类范围，避免残留范围叠加；租户和用户均在写入前校验存在且有效。
7. Hook 卡片直接展示“已绑定 N 人”“N 个租户（动态）”或“全部用户（动态）”，并额外展示已配置的 MCP Tool 名称，避免配置存在但列表不可见。

管理 API：

- `GET /api/admin/hooks/:hookId/bindings`：返回当前范围、全部账户、全部租户及各自绑定状态。
- `PUT /api/admin/hooks/:hookId/bindings`：提交 `scope` 以及对应的 `userIds` 或 `tenantIds`，原子替换当前范围。

动态范围验证：

- 创建 5 个 Hook 测试用户和 `Hook QA` 测试租户。
- `hook-test-future-tenant` 加入 Default 前不命中 SQL Hook，加入后立即命中。
- `hook-test-future-global` 在全量范围保存后才创建，无显式绑定也能命中通知 Hook。
- 不属于 Default 的 `hook-test-bob` 不会误命中 SQL Hook。

### 开箱即用的场景示例

“Admin → Hooks”提供“创建场景示例”入口，一次生成 3 个可编辑草稿：

1. `示例 · SQL 响应指标记录`：预置 SQL 识别脚本、统计输出、“调用 MCP 工具”和“记录数据”行为；MCP Tool 与入参映射保持为空。
2. `示例 · 对话正常结束通知`：预置 `Stop` 事件和通知参数模板；Skill 保持为空。
3. `示例 · HTTP 200 错误恢复`：预置 `StopFailure` 事件和完整错误上下文参数模板；Skill 保持为空，由管理员上传实现 HTTP 200 判断与恢复逻辑的 Skill 后选择。

示例始终以草稿创建，MCP Tool 或 Skill 未补齐时发布校验会阻止误发布。创建操作按名称幂等：再次点击只返回已有示例，不覆盖管理员修改。除页面入口外，也可调用 `POST /api/admin/hooks/examples`，或执行 `npm run seed:hook-examples`；在已构建的服务容器内可执行 `npm run seed:hook-examples:db` 直接写入当前数据库。

### SQL 检查 MCP 接入

本地验收环境已在“Admin → MCP Server 预置”创建并发布：

- 预置名称：`sql-syntax-checker`
- 显示名称：`SQL 语法检查 MCP`
- URL：`http://host.docker.internal:3001/mcp/sql-syntax-check`
- Tool：`check_sql_syntax`
- 状态：`published` / `healthy`
- 预安装范围：`all_workspaces`；当前 `hook-verification` 工作区已安装并写入 `.mcp.json`。

验收时使用了副作用为零的本地模拟 Server，不连接或执行数据库，只做静态结构检查。该模拟 Server 仅用于验证 Hook 的通用 MCP 调用链路，按交付要求不纳入本次源码提交；正式环境保持 Tool 契约不变，由管理员配置真实 SQL Parser MCP。

为确保只在检测到 SQL 时调用，本次给 `call_mcp_tool` 后置行为补充了可视化“执行条件”：

1. 条件可绑定布尔类型事件字段或脚本输出。
2. 条件为假时不解析工具入参，也不连接 MCP Server，行为输出为 `{ called: false, reason: "condition_false" }`。
3. 条件为真时按原有方式调用 Tool，Tool 的结构化结果继续写入 `hook_executions.actions_json`，供执行审计查看。

### Docker Python Hook runner

原生产镜像没有复制 `hook-python-runner.py`，且编译后路径仍指向不存在的 `/app/server/...`，导致 Python Hook 报 `spawn python3 ENOENT`。

优化后：

- 构建时把 runner 复制到 `dist-server/server/services`。
- 执行器从当前模块目录解析 runner，源码模式与编译模式使用相同相对关系。
- 完整 Hook 测试矩阵中的 JavaScript 和 Python 分支均已通过。

## 验证证据

真实 CCUI 模型回合：

- 模型按要求返回 1 个 SQL 块，共 3 行、1 条 `SELECT` 语句、38 个字符。
- `SQL 响应指标记录` 写入结构化数据库记录，执行状态为 `succeeded`。
- 通知 Skill 实际执行，使用 Bash 写入：
  `/Users/da-group/Documents/CloudCLI-Workspaces/default/admin/hook-verification/.ccui/hook-notifications.jsonl`
- 会话消息中观察到 `HOOK_NOTIFICATION_SKILL_EXECUTED`。

受控失败场景：

- 输入事件：`StopFailure` / `server_error`。
- 错误详情包含 `HTTP 200`。
- Hook 成功加载通知 Skill，并为 `verification-http-200-session` 排入恢复回合。
- Hook 审计状态为 `succeeded`。

自动回归：

- 生产前后端构建成功。
- 本次提交范围内 Hook/MCP 后端测试：42/42 通过；前端 Hook catalog 测试：6/6 通过。
- 覆盖真实 Claude Agent SDK 控制通道、28 类 Hook 事件、JavaScript/Python 脚本、Skill 恢复去重、MCP 行为和审计数据。

SQL MCP 运行验证：

- 有效 SQL：执行成功，`valid=true`、`issues=[]`。
- 错误 SQL：执行成功，`valid=false`，识别出 `unclosed_parenthesis` 和 `trailing_comma`。
- 无 SQL：执行成功，MCP 行为与数据记录行为均因 `condition_false` 跳过。

## 相关实现文件

- `server/services/hook-builtin-skills.js`
- `server/services/hook-skill-catalog.js`
- `server/services/hook-examples.js`
- `server/services/hook-runtime.js`
- `server/services/hook-script-executor.js`
- `server/skills/hook-notification/SKILL.md`
- `src/components/admin/hook-config/HookConfigEditor.tsx`
- `scripts/configure-requested-hooks.mjs`
- `scripts/verify-requested-hooks.mjs`

## 运维说明

- 管理员可在“Admin → Hooks”查看三条配置、逐条维护生效用户、查看执行审计和 SQL 数据记录。
- 模拟通知文件按工作区隔离；正式环境可新增受控内置通知 Skill，或使用 Hook 的 MCP 通知工具行为。
- API 密钥曾出现在聊天消息中，建议完成验收后在火山控制台轮换，并只更新本地 `.env`。
- GitHub 在当前网络下需使用仓库已配置的 `http://127.0.0.1:7897` 代理；代理链路已验证可用。
