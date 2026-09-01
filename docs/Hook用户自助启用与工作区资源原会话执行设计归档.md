# Hook 用户自助启用、工作区资源与原会话执行设计归档

日期：2026-08-24
状态：已实现，已完成自动化回归与真实 UI 端到端测试

## 1. 最终结论

本轮采用以下最终架构：

1. 不使用独立 Hook Agent，也不保留 Hook Agent 专属运行时、消息类型或数据库字段。
2. 管理员在 Hook 页面配置的是“用户可见范围”，不是替用户直接启用。
3. 普通预置 Hook 由用户在“设置 → Hook”中自行开启；SQL Check 强制校验由用户在工作区“SQL Check”页面单独开启。
4. 用户开启 Hook 时，将 Hook 依赖的完整 Skill 目录和 Hook MCP 运行资源缓存到该工作区的 `.cloudcli/hook-config`，不写入普通 `.claude/skills`、用户 MCP 预置或 `.mcp.json`。
5. `Stop` / `StopFailure` 的 Skill 行为在原 Claude SDK session 中排入下一回合执行，因此可读取完整对话上下文。
6. Skill 所需的 Hook MCP 仅在该恢复回合临时合并；Hook MCP 使用稳定内部别名，和用户自己的同名 MCP 可以同时存在。
7. 直接 `call_mcp_tool` 行为不经过恢复回合，由 Hook runtime 直接调用 Hook MCP；`invoke_skill` 行为则走原会话恢复回合。

这套方案同时满足了上下文完整、Skill 脚本可执行、MCP 临时可用、日常 Skill/MCP 不被污染以及重名隔离。

## 2. 范围与非目标

本轮包含：

- 管理员 Hook 用户可见范围。
- 用户按工作区入口自助开启 Hook。
- SQL Check 专属开启入口。
- 完整 Hook Skill 目录缓存。
- Hook MCP 配置、测试、headers helper、helper 脚本上传和工作区缓存。
- 原会话 Skill 续跑与临时 Hook MCP。
- Hook MCP 重名隔离。
- 执行诊断、分页和聊天内部恢复指令隐藏。
- Hook Agent 代码回滚。

本轮明确不做：

- Hook 手工顺序配置。
- Hook 版本快照。
- 独立 Hook Agent。
- 把 Hook MCP 永久写入用户普通 MCP 配置。
- 把 Hook Skill 写入用户普通 Skill 目录。

## 3. 数据与权限模型

### 3.1 管理员只控制可见范围

普通 Hook 发布后，管理员可配置：

- `users`：只有 `hook_user_scopes` 中选中的用户能在设置页看到。
- `all_users`：全部有效用户都能看到。

管理员调整范围时会清理已经不在范围内的用户启用记录，防止用户失去可见权限后 Hook 仍继续执行。

### 3.2 用户自己决定是否启用

用户开启状态仍写入 `user_hook_bindings`：

- 可见但未启用：设置页可见，运行时不加载。
- 可见且已启用：运行时加载。
- 失去可见范围：不能通过 API 绕过 UI 开启。

当前启用状态属于“用户级”，工作区选择用于确定本次资源落盘位置。SDK 会话启动时会对当前工作区再次按启用状态做资源协调，因此同一用户进入其他工作区时无需管理员再次绑定。

### 3.3 SQL Check 特殊入口

`SQL Check 强制校验` 的 `binding_controller` 为 `sql_check`：

- 不在普通 Hook 设置中启用。
- 管理员 Hook 卡片显示“由用户在 SQL Check 开启”。
- 用户在当前工作区 SQL Check 页面点击“强制校验”后写入同一启用表，并先缓存所需 Hook 资源。

## 4. 工作区资源设计

### 4.1 目录结构

```text
<workspace>/.cloudcli/hook-config/
├── hooks/
│   └── <hook-id>.json
├── skills/
│   └── <skill-id>/<content-sha256>/
│       ├── SKILL.md
│       ├── scripts/
│       ├── references/
│       ├── assets/
│       └── .ccui-resource.json
└── mcp/
    └── <hook-mcp-id>/<content-sha256>/
        ├── server.json
        └── <headers-helper-script>
```

该目录和普通 Skill/MCP 目录完全分开，不参与日常 Skill 自动发现，也不写入 `.mcp.json`。

### 4.2 完整 Skill 缓存

不是只复制 `SKILL.md`，而是递归复制 Skill 根目录，包括 `scripts`、`references` 和 `assets`。实现包含以下约束：

- 内容哈希包含相对路径、权限位和文件内容。
- 同一内容哈希命中后不重复复制。
- 新内容写入 staging 目录后原子 rename。
- 保留脚本执行位。
- 拒绝符号链接和非普通文件。
- 单个 Skill 最多 512 个文件、总计 32 MiB。

旧哈希目录不会在开启时立即删除，避免正在运行的会话引用失效；后续可单独增加安全 GC。

### 4.3 Hook MCP 缓存

Hook MCP 的 Server 名生成稳定 ID：

```text
hook-mcp-<server-name-sha256-prefix>
```

运行时再生成内部别名：

```text
ccui-hook-mcp-<stable-id-suffix>
```

工作区 `server.json` 只保存运行所需的非敏感元数据；静态 Headers 和 helper 环境变量不会写入工作区。上传的 helper 脚本会缓存到 Hook 专用目录，因此脚本本身不得包含密钥，敏感值必须放在管理员配置的静态 Header 或 helper 环境变量中。

headers helper 实际执行时：

- Docker 会话通过 `docker exec` 在用户容器内执行，因此能继承该用户容器环境。
- 本地会话继承当前 SDK execution environment。
- helper 输出 JSON Header 对象，再与静态 Headers 合并后连接 MCP。

## 5. 执行链路

### 5.1 发布和用户开启

```text
管理员创建/发布 Hook
  → 配置用户可见范围
  → 用户在设置或 SQL Check 页面开启
  → 服务端校验用户仍在可见范围
  → 完整 Skill 与 Hook MCP 缓存到所选工作区
  → 写入用户启用状态
```

### 5.2 SDK 会话启动

```text
创建用户 Claude SDK session
  → 查询该用户已启用且仍有资格使用的 Hook
  → 协调当前工作区的 Hook 资源缓存
  → 注册对应原生 Claude SDK Hook 回调
```

### 5.3 直接 MCP 后置行为

`call_mcp_tool` 的链路：

```text
Claude SDK Hook 事件
  → Hook matcher / 脚本 / 条件
  → 按 mcpServerId 找到 Hook MCP
  → 执行 headers helper
  → 使用内部别名调用指定 Tool
  → 结果写入 Hook 执行诊断
```

该链路不需要 Claude 再做一次模型推理，适合确定性的校验、记录或通知 MCP。

### 5.4 Skill 后置行为与原会话续跑

`invoke_skill` 的链路：

```text
Stop / StopFailure
  → Hook runtime 命中 invoke_skill
  → 找到工作区完整 Skill 根目录
  → 将恢复回合排入原 session 的 queuedTurns
  → 当前 SDK turn 完成边界关闭
  → 用同一 sessionId 启动下一回合
  → 注入完整 SKILL.md、Skill root 与 Hook 参数
  → 临时合并该 Skill 选择的 Hook MCP
  → Skill 可调用脚本、读取原会话上下文并调用 Hook MCP
```

恢复回合设置 `hookRecovery` 标记。该回合仍会执行一般 Hook 逻辑，但会抑制再次排入 Skill 恢复，避免无限循环。

### 5.5 MCP 重名处理

用户 MCP 仍使用其原始 Server 名；Hook MCP 始终使用 `ccui-hook-mcp-*` 内部别名。即使两者的管理员显示名或原始 Server 名相同，最终 Tool 名也不同：

```text
mcp__user-server__tool
mcp__ccui-hook-mcp-<suffix>__tool
```

Hook 配置持久化稳定 `mcpServerId`，不会靠显示名或 Tool 短名猜测目标，因此不会覆盖、抢占或误调用用户 MCP。

## 6. UI 设计

### 6.1 Admin → Hooks

- “Hook 专用 MCP 管理”对标 MCP 预置页面，支持显示名、Server 名、URL、静态 Headers、headers helper、helper 环境变量、helper 脚本上传、保存、测试和删除。
- Hook 编辑器中的直接 MCP 行为保存 `mcpServerId`。
- Skill 行为可选择多个 Hook MCP，保存为 `mcpServerIds`。
- 原“绑定”入口改名为“用户范围”，只表示哪些用户能在设置中看到。
- SQL Check Hook 显示专属入口说明。
- 执行诊断按事件组分页，支持每页 10/20/50 条和页码切换。

### 6.2 用户设置

“设置 → Hook”提供：

- 工作区选择。
- 当前用户有资格看到的 Hook。
- 每个 Hook 的独立开关。
- 明确提示资源写入 `.cloudcli/hook-config`，不会污染日常 Skill/MCP 配置。

### 6.3 工作区 SQL Check

工作区 SQL Check 页面增加“强制校验”开关，作为 SQL Check 内置 Hook 的唯一用户入口。

### 6.4 原会话内部消息

服务端用 `<ccui-hook-recovery>` 标记内部恢复指令。聊天 UI 将这类内部 user prompt 隐藏，但保留恢复回合中的 MCP、Bash 和 assistant 执行结果，便于用户确认 Hook 实际做了什么。

## 7. Hook Agent 回滚

已删除或移除：

- `server/services/hook-agent.js` 及对应测试。
- Hook Agent 独立 session/runtime 创建逻辑。
- `hook_agent` / `hook_activity` / `runtime_role` 相关生产逻辑、迁移残留和监控字段。
- 前端 Hook Agent 专属实时卡片依赖。

最终代码检索不再出现 `HookAgent`、`hook_agent`、`runtimeRole` 或 `runtime_role`。

## 8. UI 端到端测试

### 8.1 测试配置

- 用户：`admin`
- 租户：平台租户，运行时 ID `1`
- 工作区：`sql-hook-demo-ui`，运行时 ID `3`
- 会话：`dde7e724-8de8-4636-8754-d45c85f89450`
- Hook MCP：`SQL Check Hook MCP（原会话 E2E）`
- 测试 Tool：`check_sql_syntax`
- helper 命令：`python3 ccui-hook-user-env-headers-helper.py`
- 完整 Skill：`Hook 完整目录 E2E`
- 完整 Skill Hook：`完整 Skill 原会话 E2E`

### 8.2 UI 操作覆盖

1. 在 Admin Hook 页面创建和编辑 Hook MCP。
2. 上传 headers helper 脚本，并从 UI 点击“测试”；成功发现 1 个 Tool。
3. 上传包含 `SKILL.md` 和 `scripts/record.py` 的完整 Skill 文件夹。
4. 通过 UI 创建、发布 Hook，选择 admin 用户范围，并为 Skill 选择 Hook MCP。
5. 在“设置 → Hook”选择工作区并开启 Hook。
6. 在工作区 SQL Check 页面开启强制校验。
7. 在真实 Claude 会话输出 SQL，触发 SQL Check。
8. 再次结束回合，触发完整 Skill 原会话续跑。
9. 从 Admin 执行诊断查看 SQL Check 记录和分页。
10. 测试完成后恢复 MCP 地址和测试开关。

### 8.3 实际结果

SQL Check 直接 Hook：

- 输入 SQL：`SELECT 4242 AS hook_env_e2e;`
- MCP 返回：`valid=true`。
- 执行记录显示 checker 为 `ccui-hook-env-e2e`。
- headers helper 读到当前用户 `admin`。

完整 Skill 原会话 Hook：

- Skill 在原会话中调用临时 Tool：
  `mcp__ccui-hook-mcp-c23c1f4a120833d5__check_sql_syntax`
- Tool 输入：`SELECT 5150 AS hook_skill_mcp_e2e;`
- Tool 观察到环境：`user=admin`、`tenant=1`、`workspace=3`。
- Tool 返回：`valid=true`。
- Skill 从以下专用缓存执行脚本：
  `/workspace/.cloudcli/hook-config/skills/builtin-hook-full-folder-e2e/<hash>/scripts/record.py`
- 工作区生成 `.ccui/hook-full-folder-e2e.json`：
  `{"executed": true, "skill": "hook-full-folder-e2e", "user": "admin"}`。
- 最终输出：`HOOK_FULL_FOLDER_E2E_EXECUTED`。
- 原始 `<ccui-hook-recovery>` 指令未出现在聊天 UI。

资源隔离检查：

- 完整 Skill、脚本、MCP manifest 和 helper 均存在于 `.cloudcli/hook-config`。
- 未创建普通 `.mcp.json`。
- 未写入普通 `.claude/skills`。
- 工作区 `server.json` 不含静态 Header 和 helper 私有环境变量。

## 9. 测试发现的问题、根因与修复

### 9.1 全事件场景测试仍注入普通租户 MCP

现象：架构改为 Hook MCP catalog 后，场景测试仍准备旧租户 MCP 预置，导致 Hook 找不到 `mcpServerId`。

根因：测试 fixture 没有随运行时边界调整。

修复：场景测试注入独立 Hook MCP catalog，并让 Hook 行为显式持久化稳定 Server ID；保留 28 类 SDK Hook 事件的完整矩阵。

### 9.2 Node 24 + better-sqlite3 清理阶段断言崩溃

现象：断言全部执行后，Node 24 在 `Statement::~Statement()` / `RemoveEnvironmentCleanupHook` 清理阶段原生退出。

根因：测试隔离 worker 退出与当前 better-sqlite3 原生对象回收组合存在运行环境兼容问题，不是 Hook 断言失败；项目正式工作流使用 Node 22。

修复：Hook 聚焦套件使用 `--test-isolation=none --test-force-exit`，并让场景 fixture 在测试生命周期内保留 Statement wrapper；测试可稳定完成并保留覆盖。

### 9.3 测试脚本依赖不可用的 npx

现象：当前 Codex bundled runtime 有 Node、pnpm 和项目 `tsx`，但没有 `npx`，后端测试通过后前端 Hook 测试无法启动。

根因：`test:hooks` 无必要地通过 `npx tsx` 调用本地依赖。

修复：改成直接执行项目本地 `tsx --test`。

### 9.4 Hook Agent 残留

现象：主实现已改回原会话，但数据库迁移、运行时监控测试和类型中仍存在 `runtime_role` / `runtimeRole` 残留。

根因：前一版 Hook Agent 跨数据库、运行时和前端多层实现，首次回滚遗漏外围引用。

修复：删除迁移、索引、类型、监控字段和对应断言，并以仓库全文检索作为回归门槛。

### 9.5 内部恢复 prompt 显示在聊天中

现象：原会话续跑成功，但用户能看到完整 `<ccui-hook-recovery>` 内部指令。

根因：聊天内部消息过滤只识别已有系统标记，没有识别新的 Hook 恢复协议标记。

修复：将 `<ccui-hook-recovery>` 加入保留内部消息规则；新增工具函数和消息 Hook 测试。MCP、脚本与最终结果继续可见。

### 9.6 Hook MCP helper 页面提示与实际落盘相反

现象：页面复用普通 MCP 预置文案，显示“工作区用户无法浏览此文件”，但 Hook 开启后 helper 脚本会被复制到 `.cloudcli/hook-config`。

根因：Hook MCP 编辑器复用了 `mcp.helperScript.description`。

修复：增加 Hook MCP 专属说明，明确脚本会复制到工作区、脚本本身不得包含秘密，并引导敏感值使用静态 Header 或 helper 环境变量。

### 9.7 本地构建命令依赖 npm

现象：当前环境没有系统 `npm`，顶层 `pnpm run build` 内部再次调用 `npm run ...` 会失败。

根因：项目历史构建脚本固定依赖 npm；不是本轮 Hook 实现问题。

处理：使用项目 Vite、TypeScript、tsc-alias 和 Node 直接执行等价前后端构建。该通用脚本问题未在本轮扩大修改范围。

## 10. 自动化回归结果

| 验证项 | 结果 |
| --- | --- |
| 前后端 TypeScript typecheck | 通过 |
| Hook 核心后端测试 | 69/69 通过 |
| 完整 Claude SDK Hook 场景矩阵 | 3/3 通过，覆盖 28 类事件 |
| Hook 前端 catalog 测试 | 8/8 通过 |
| 会话/用户路由回归 | 81/81 通过 |
| 前端会话状态回归 | 33/33 通过 |
| 内部 Hook 恢复消息过滤 | 17/17 通过 |
| Vite 生产构建 | 通过 |
| 服务端 TypeScript + alias + Python runner 构建 | 通过 |
| 真实 UI 完整 E2E | 通过 |

最终 `test:hooks` 将核心后端、完整场景矩阵和前端 Hook catalog 串成单一命令。

## 11. 测试后环境恢复

- Hook MCP URL 已从临时测试地址恢复为 `http://127.0.0.1:3017/mcp/sql-syntax-check`，UI 重新测试连接正常。
- 本轮额外开启的“完整 Skill 原会话 E2E”和“对话正常结束通知”已关闭。
- 本轮额外开启的 SQL 强制校验已关闭。
- 测试前已经开启的“SQL 行数记录”保持开启。
- 测试 Hook、Skill、执行诊断和内容哈希缓存保留，作为验收证据；不会自动运行。

## 12. 已知边界与后续建议

1. 用户启用状态当前是用户级；工作区选择决定即时缓存位置，其他工作区在会话启动时懒协调。若未来需要每工作区不同启用状态，应增加 `workspace_id` 维度，而不是复用当前表。
2. 内容哈希旧版本目前不即时 GC。建议增加只删除无运行引用旧哈希的后台清理任务。
3. 恢复回合中的工具和 assistant 输出保留可见，这是可诊断性设计；只隐藏内部控制 prompt。
4. Hook MCP helper 脚本会进入用户工作区，不得把 Token 写进脚本正文。
5. Hook 顺序与版本快照按本轮决策暂不实现；发生冲突时依靠执行组、Hook 名称、时长、脚本输出、动作输出和错误详情定位。

## 13. 主要实现文件

- `server/claude-sdk.js`
- `server/services/claude-turn-boundary.js`
- `server/services/hook-configs.js`
- `server/services/hook-mcp-catalog.js`
- `server/services/hook-mcp-client.js`
- `server/services/hook-runtime.js`
- `server/services/hook-workspace-resources.js`
- `server/routes/admin.js`
- `server/routes/workspaces.js`
- `server/database/hook-config-schema.js`
- `src/components/admin/HookConfigsTab.tsx`
- `src/components/admin/hook-config/HookConfigEditor.tsx`
- `src/components/admin/hook-config/HookDiagnosticsPanel.tsx`
- `src/components/settings/view/tabs/HookSettingsTab.tsx`
- `src/components/sql-check/SqlCheckPanel.tsx`
- `src/components/chat/utils/internalMessages.ts`
