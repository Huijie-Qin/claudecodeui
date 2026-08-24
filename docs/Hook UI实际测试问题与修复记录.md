# Hook UI 实际测试问题与修复记录

日期：2026-08-23

## 1. 测试范围与隔离方式

本轮先对当前 5 条 Hook 配置做真实页面检查，再针对发现的问题完成修复和回归：

| Hook | 事件 | 主要能力 | 修复前实际检查结果 |
| --- | --- | --- | --- |
| 失败通知 | `StopFailure` | 调用内置通知 Skill | 受控失败事件可正常排入 Skill；执行审计成功 |
| HTTP 200 会话恢复 | `StopFailure` | JavaScript 条件判断 + Skill 恢复 | `shouldRecover=true`，恢复回合成功排队 |
| SQL 行数记录 | `Stop` | JavaScript + `write_record` | 成功写入 SQL 行数、语句数等业务数据 |
| SQL Check 强制校验 | `Stop` | JavaScript + MCP | Hook 被触发，但实际 MCP 调用报 `TypeError: fetch failed` |
| 对话正常结束通知 | `Stop` | 独立 Hook Agent 调用 Skill | Hook Agent 约 10.7 秒完成；会话卡片长期停留“执行中”，刷新后才显示完成 |

同时检查了 Hook 列表、编辑器、发布与绑定、业务数据、执行诊断、详情弹窗、复制/创建/删除等页面路径。临时 CRUD 只发生在数据库副本中。

修复后 UI 回归使用以下隔离方式：

- 从当前数据库做 SQLite 一致性备份，放入 `/private/tmp`；只修改副本中的管理员密码。
- 当前前端代码运行在 5174 端口；后端使用项目生产镜像中的 Node 22 和临时数据库，映射到 3101 端口。
- 不保存真实 Hook 配置，不改真实绑定，不删除真实数据。
- 页面验证结束后关闭一次性容器、开发服务器并删除临时数据库及复制的 `.env`。

## 2. 问题一：Hook Agent 已结束，卡片仍显示“执行中”

### 现象与证据

“对话正常结束通知”产生的 Hook Agent 实际在约 10.7 秒后成功结束，执行诊断中状态也已经是 `succeeded`，但会话内紫色 Hook 卡片持续显示“执行中”。只有刷新页面或重新载入历史后才变成“已完成”。

### 原因

同一个 Hook Agent 生命周期使用固定消息 ID。实时通道已经把该 ID 从 `running` 更新为 `succeeded`，但消息合并逻辑始终让服务端历史中的同 ID 消息优先。服务端持久化是异步的，因此短时间内仍可能返回旧的 `running` 记录。

此外，服务端历史刷新时会直接删除所有同 ID 实时消息，导致实时终态在持久化追上之前被提前清掉。

### 修复方案

在 `src/stores/sessionMerge.ts` 中对 `hook_activity` 增加生命周期优先级：

- `queued < running < succeeded/failed`。
- 服务端为 `running`、实时为终态时，合并结果使用实时终态。
- 服务端已经是终态、实时仍是旧状态时，继续使用服务端终态。
- 历史刷新只有在服务端状态追平实时状态后才清理该实时消息。
- 规则仅作用于 `hook_activity`，普通聊天、流式消息和乐观消息仍维持原有服务端优先逻辑。

### 回归证据

新增并通过以下确定性测试：

1. 同 ID 的实时 `succeeded` 覆盖持久化 `running`。
2. 实时旧 `running` 不覆盖持久化 `succeeded`。
3. 历史刷新期间保留领先的实时终态，持久化追平后再清理。
4. 实时缓冲区仍然只保留一个 Hook Agent 卡片并原位更新。

前端 Hook/会话逻辑扩展套件共 50 条，全部通过。

## 3. 问题二：SQL Check 实际 MCP 调用 `fetch failed`

### 现象与证据

SQL Check Hook 的 JavaScript 检测和条件判断正常执行，但后置 MCP 动作在实际会话中失败，错误为 `TypeError: fetch failed`。相同事件中的 SQL 行数记录仍然成功，说明失败点在 MCP 连接而不是 Hook 事件或脚本本身。

### 原因

SQL Check 预置地址为：

```text
http://host.docker.internal:<SERVER_PORT>/mcp/sql-syntax-check
```

这个地址是给 Docker 内的 Claude 会话使用的。Hook 后置动作却由 CCUI Node.js 进程直接执行；在本机开发模式下，`host.docker.internal` 不保证能从宿主进程解析，因此连接在 MCP 初始化前失败。

### 修复方案

在 `server/services/hook-mcp-client.js` 中增加直连地址解析：

- 仅当 MCP Server 名称是内置 `sql-syntax-checker`，且地址主机是 `host.docker.internal` 时，改为 `127.0.0.1`。
- 普通远端 MCP 地址保持不变。
- 用户自定义的 `host.docker.internal` MCP 地址也保持不变，避免误把真实宿主机服务改到 CCUI 容器内部。

### 回归证据

- 聚焦测试启动真实临时 HTTP MCP Server，配置仍使用 `host.docker.internal`，完成 `initialize`、`tools/call` 和结构化结果解析，5/5 通过。
- Node 22 一次性生产容器内，用相同 Docker 地址实际调用 CCUI SQL MCP 端点，返回：`valid=true`、`statementCount=1`、`checker=ccui-simulated-sql-syntax-checker`，规则 ID 也完整透传。
- 额外断言普通远端地址和自定义宿主地址不被改写。

## 4. 问题三：返回列表会直接丢弃未保存修改

### 现象与证据

编辑 Hook 名称、说明、事件、脚本、后置行为或返回字段后，点击“返回列表”会立刻关闭编辑器，没有任何提醒。

### 原因

编辑器的返回按钮直接调用 `onBack`，父组件只执行 `setEditor(null)`；系统没有保存基线，也没有判断可编辑字段是否变化。

### 修复方案

- 为 Hook 的可编辑字段生成稳定签名，只包含名称、说明、事件、 Matcher、脚本、后置行为和 Claude 返回配置。
- 打开编辑器时记录基线；保存或发布成功后更新基线。
- 版本、状态、绑定数量、更新时间等服务端元数据不参与脏数据判断。
- 有未保存修改时，使用应用内 Dialog 提示“继续编辑”或“放弃修改”，不使用浏览器原生 `confirm`。
- 保存绑定时保留编辑器内尚未保存的字段，避免绑定响应顺带覆盖本地编辑内容。

### 实际 UI 回归

1. 打开“SQL 行数记录”并修改“功能说明”。
2. 点击“返回列表”，页面显示“放弃未保存的修改？”对话框。
3. 点击“继续编辑”，修改内容仍在。
4. 再次返回并点击“放弃修改”，回到 Hook 列表。
5. 重新打开该 Hook，临时文字不存在，数据库副本中的原配置未变化。
6. 未做修改时点击返回，直接回到列表，不弹确认框。

## 5. 问题四：执行记录和执行详情缺少明确关闭入口

### 现象与证据

Hook 卡片的“执行记录”会打开外层诊断弹窗；点击某条记录又会打开执行详情弹窗。两层弹窗原来都没有可见关闭按钮，只能依赖遮罩、Esc 或不明显的默认行为。

### 修复方案

- 在外层“执行记录”弹窗右上角增加可见 `X` 按钮，`aria-label=关闭`。
- 在内层“Hook 执行详情”弹窗右上角增加独立 `X` 按钮。
- 调整顶部留白，避免关闭按钮遮挡刷新按钮或标题。

### 实际 UI 回归

- “SQL 行数记录”的执行记录弹窗显示 1 个可见关闭按钮，点击后弹窗消失。
- “SQL Check 强制校验”的执行记录可正常列出历史记录。
- 打开一条执行详情时页面有 2 个关闭按钮；关闭详情后，详情消失、外层记录列表保留且只剩 1 个关闭按钮；再关闭外层后所有诊断弹窗消失。

## 6. 自动化验证结果

| 验证项 | 结果 |
| --- | --- |
| 本次涉及文件 Lint | 通过 |
| 客户端 TypeScript | 通过 |
| 服务端 TypeScript | 通过 |
| Vite 生产构建 | 通过，3569 个模块完成转换 |
| 前端 Hook/会话逻辑 | 50/50 通过 |
| SQL MCP 聚焦测试 | 5/5 通过 |
| 扩展 Hook 服务端套件 | 87 条断言通过；全事件矩阵文件出现运行环境级原生崩溃，见下节 |

## 7. 已知验证环境限制

### Node 24 与 `better-sqlite3` 原生清理崩溃

Codex 自带 Node 24 在运行 `hook-scenarios.test.js` 的 JavaScript/Python 全矩阵以及本地源码后端处理数据库请求时，会在原生模块清理阶段触发：

```text
Assertion failed: (env) != nullptr
Statement::~Statement()
RemoveEnvironmentCleanupHook
```

串行重跑仍可复现。该文件崩溃前，“28 类 SDK Hook 事件”和“真实 SDK 控制通道”两项已经通过，但不能把整个文件记为成功。真实页面回归因此改用项目生产镜像的 Node 22；页面和 SQL MCP 直连验证均正常。

### 全仓 Lint 的既有依赖缺口

全仓 Lint 仍会因 `zod` 和 `shell-quote` 无法解析而失败，并伴随既有 warning。本次涉及文件单独 Lint 为零错误；未把这两个无关依赖问题混入 Hook UI 修复。

### 修复后的实时终态验证边界

修复前的卡片停滞来自真实模型会话。修复后的隔离 UI 环境没有挂载真实运行时和工作区，因此没有再发起一个真实 Claude 回合；终态覆盖、反向保护和刷新竞态由精确复现同一消息序列的 store 测试验证。页面层对 Hook 专属卡片的独立展示与历史恢复已在修复前实际测试中确认。

## 8. 相关文件

- `src/stores/sessionMerge.ts`
- `src/stores/useSessionStore.test.ts`
- `server/services/hook-mcp-client.js`
- `server/services/sql-syntax-mcp-server.test.js`
- `src/components/admin/HookConfigsTab.tsx`
- `src/components/admin/hook-config/HookConfigEditor.tsx`
- `src/components/admin/hook-config/HookDiagnosticsPanel.tsx`
- `src/components/admin/hook-config/editorUtils.ts`
- `src/components/admin/hook-config/editorUtils.test.ts`
- `src/i18n/locales/zh-CN/admin.json`
- `src/i18n/locales/en/admin.json`

## 9. 2026-08-24 补充：启用的 Hook 与会话展示不完整

### 现象与实际证据

同时启用全部预置 Hook 和 SQL Check 强制校验后，执行诊断中能看到多个 Hook 已执行，但会话中只显示了“发送通知”产生的后置消息；设置页的“辅助功能”列表也没有显示已经启用并执行的 SQL Check Hook。

修复前在真实页面复现时，“辅助功能”只列出 4 条普通 Hook，SQL Check 页面则明确显示强制校验已启用。执行记录和设置列表因此出现了不一致。

### 原因

问题由三条数据链路不一致共同导致：

1. 设置页的可用 Hook 查询只返回 `binding_controller=admin` 的配置，而运行时会同时加载 `binding_controller=sql_check` 的配置。因此 SQL Check 能执行，却被设置页过滤掉。
2. 会话事件只在 Hook 后置动作是 `invoke_skill` 或 `send_agent_message` 时生成 `hook_activity`。脚本、`write_record`、`call_mcp_tool` 以及 SQL Check 自身的执行只写入审计表，没有发送会话卡片。
3. 单纯修复实时事件只能覆盖新执行；既有会话加载历史时没有把 `hook_executions` 审计记录还原为 Hook 卡片，所以刷新旧会话仍然缺失。

### 修复方案

- Hook 运行时现在为每一次执行统一报告 `running -> succeeded/failed` 生命周期，不再依赖是否产生后置消息。
- 会话中把“Hook 执行”和“后置消息”作为两类卡片：
  - “Hook 执行”展示 Hook 名称、事件、状态、脚本以及 MCP 调用、写入记录、调用技能、发送 Agent 消息等动作类型。
  - “后置消息”继续表示 Hook 生成并送入下一轮对话的内容，避免把执行记录和模型消息混为一谈。
- 会话历史加载时从 `hook_executions` 恢复通用 Hook 执行卡片，并按稳定 ID 去重。这样修复前已经产生的执行记录也能在旧会话中补显。
- 设置页的可用列表纳入已发布的 SQL Check Hook。SQL Check 行显示“SQL Check 强制校验管理”标记，并保持开关只读，防止绕过专用 SQL Check 页面中的校验与配置流程。
- 所有活动上报和历史恢复均采用 fail-open：UI 辅助展示失败不会中断 Hook 本身或会话执行。

### 实际 UI 回归

使用最终生产镜像和现有测试会话完成真实页面验证：

1. “辅助功能”由原来的 4 条恢复为 5 条：失败通知、HTTP 200 会话恢复、SQL 行数记录、SQL Check 强制校验、对话正常结束通知。
2. SQL Check 行显示已启用、开关只读，并带有“SQL Check 强制校验管理”标记。
3. 重新加载修复前已有执行记录的旧会话后，页面恢复出 4 张 Hook 执行卡片，不需要重新运行 Hook。
4. 两次 SQL Check 记录均显示“Stop / 脚本 / MCP 调用 / 已完成”；两次正常结束通知记录均显示“Stop / 调用技能 / 已完成”。
5. Hook 执行卡片和后置消息使用不同标题，用户可以明确判断一条会话内容来自执行审计还是 Hook 生成的后续对话。

### 补充自动化验证

| 验证项 | 结果 |
| --- | --- |
| Hook 配置、运行时、历史恢复聚焦测试 | 52/52 通过 |
| 前端消息归一化与会话 Store 测试 | 39/39 通过 |
| Hook 服务端主套件 | 72/72 通过 |
| 28 类 SDK Hook 事件与行为矩阵 | 3/3 通过 |
| Workspace 路由聚焦测试 | 1/1 通过 |
| 客户端与服务端 TypeScript | 全部通过 |
| 本次涉及文件 Lint、JSON 解析、`git diff --check` | 全部通过 |
| Vite 生产构建、Docker 生产镜像构建与健康检查 | 全部通过 |

### 本次补充涉及文件

- `server/claude-sdk.js`
- `server/services/hook-configs.js`
- `server/services/hook-runtime.js`
- `server/services/session-message-history.js`
- `server/shared/types.ts`
- `src/components/chat/hooks/useChatMessages.ts`
- `src/components/chat/types/types.ts`
- `src/components/chat/view/subcomponents/MessageComponent.tsx`
- `src/components/settings/view/tabs/HookSettingsTab.tsx`
- `src/stores/useSessionStore.ts`
- `src/i18n/locales/zh-CN/chat.json`
- `src/i18n/locales/en/chat.json`
