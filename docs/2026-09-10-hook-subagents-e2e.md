# Hook 自动对子代理生效：实现与浏览器验收

2026-09-10，本地隔离测试环境。

2026-09-11 补充：[子代理 MCP 循环真实 20 分钟浏览器端到端验收](2026-09-11-subagent-mcp-loop-20min-e2e.md) 已通过，包含原 `running` 结果替换为 `success`，以及运行中和完成后刷新历史的验证。

## 使用方式

在「系统管理 → Hooks → 编辑」的事件选择区域开启「同时对子代理生效」，然后发布。无需填写子代理名称或逐个维护代理配置；符合 Matcher 的主代理和所有子代理分别执行同一份已发布 Hook。

支持 Stop、PreToolUse、PostToolUse、PostToolUseFailure、PermissionRequest、PermissionDenied。Stop 会同时注册 SubagentStop，脚本收到真实的 `hook_event_name`、`agent_id` 和 `agent_type`。SessionStart、UserPromptSubmit 等没有对应子代理回调的事件不显示这个开关。原生 SubagentStart/SubagentStop 配置保持原有语义。

新建 Hook 默认关闭。迁移时保留旧配置及旧发布版本的实际行为：旧 Stop 不自动扩展到子代理，旧工具类 Hook 继续覆盖原来能收到的子代理回调。复制、草稿、发布版本以及 Agent 模板固定版本和快照均保留开关值。

子代理结束校验的消息和 Skill 内容返回触发它的子代理，让其继续自己的任务。并行子代理的去重和纠正保护按代理 ID 分开。子代理 MCP 循环等待自己的工具结果，并将最终结果返回原工具调用；支持超时、取消和失败结果。主代理保留原有的后续回合和调度行为。

聊天卡片、执行记录和运行诊断显示主代理或子代理及其 ID，刷新历史后保留身份和子代理 MCP 循环结果。脚本若自行按 `session_id` 存储状态，仍需使用 `agent_id` 区分同一会话的多个子代理。

## 浏览器端到端结果

全部配置均通过浏览器创建或复制、修改开关、发布并设置测试用户启用范围；会话也通过浏览器输入并发送。每次运行由主代理执行一次 Bash，再启动两个并行的 general-purpose 子代理，各执行自己的 Bash。

| 用例 | 已发布开关 | 实际结果 |
| --- | --- | --- |
| `ui_on`：Stop 结束校验 | 开启 | 两个子代理各触发一次未通过校验，收到自己的纠正消息，执行一次纠正 Bash 后通过；共 4 次 SubagentStop、1 次主代理 Stop。 |
| `ui_off`：Stop 对照 | 关闭 | 两个子代理各执行一次 Bash 后完成，无纠正消息、无子代理 Hook；仅 1 次主代理 Stop。 |
| `tool_on`：PreToolUse，Matcher=Bash | 开启 | 3 次 PreToolUse，分别属于主代理和两个不同 ID 的子代理；主代理 Stop 仍执行。 |
| `tool_off`：PreToolUse 对照 | 关闭 | 子代理仍正常执行 Bash，但不执行此 Hook；仅 1 次主代理 PreToolUse 和 1 次主代理 Stop。 |

上述执行记录均成功。模型请求日志独立确认：纠正反馈仅进入对应子代理，没有进入主代理请求。刷新后完整会话和子代理 Hook 标识一致。

验收使用真实 CCUI 服务、SQLite、Claude Agent SDK、Claude CLI、Agent 和 Bash 工具执行；仅 Anthropic 模型响应由本地确定性服务提供，便于重复触发并行与纠正流程。此次浏览器覆盖 Stop 消息纠正和 PreToolUse 开关；Skill 内容处理、MCP 循环及其他事件由针对性自动化测试覆盖，不计作浏览器实测。

## 复查与复现

测试入口：`http://127.0.0.1:3911/admin`。独立容器为 `ccui-hook-subagents-e2e`；本次没有部署或修改生产实例。

浏览器验收会话：

- `ui_on`：`b4b0d50f-fc8e-4210-bcd4-d526eb5b3dd4`
- `ui_off`：`6d376a7e-bf41-4b76-806f-6c61a166ef87`
- `tool_on`：`88cb313f-eb2b-44b4-94bc-00bfe829473d`
- `tool_off`：`a2585760-1cff-48cf-9d45-3c53f90789f9`

独立证据位于 `.tmp/hook-subagents-e2e/ccui-hook-subagents-DAKwnf/`，包括 `ui-on-independent-evidence.json`、`ui-off-independent-evidence.json`、`tool-on-independent-evidence.json`、`tool-off-independent-evidence.json` 和真实模型请求、会话转录。

Fixture 为 `scripts/hook-subagents-e2e.mjs`。源码运行：

```sh
node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json scripts/hook-subagents-e2e.mjs --serve --smoke
```

使用构建产物时设置 `HOOK_SUBAGENTS_E2E_DIST=1`，以 Node 运行同一脚本。可以通过 `HOOK_SUBAGENTS_E2E_ROOT` 指定隔离证据目录，通过 `HOOK_SUBAGENTS_E2E_PORT` 和 `HOOK_SUBAGENTS_E2E_MODEL_PORT` 调整端口。服务模式重启会复用测试数据库；`--fresh` 创建另一份独立测试数据。浏览器发送 `HOOK_SUBAGENTS_E2E RUN=<唯一用例名>` 即可触发主代理与两个子代理的流程。

自动化验证覆盖配置迁移和版本兼容、模板固定版本、路由、SDK 回调、并行隔离、子代理消息与 Skill、MCP 循环的取消/超时/结果、聊天转换及历史重放。后端去重后 213 项测试通过，最终 MCP 结果展示调整后的 SDK/历史 61 项定向复验通过；前端 62 项测试通过。前后端类型检查、构建和变更文件格式检查通过。

测试日志保存在 `.tmp/hook-subagents-e2e/`：`regression-summary.json` 列出后端去重后的用例，`final-sdk-scheduler-node22.log` 包含完整的 42 项 SDK 与 4 项既有调度器测试，`final-frontend-regression.log` 包含最终前端用例。早期带 `--test-force-exit` 的合并运行未完成全部 SDK 用例，已用单独无强制退出的完整运行补齐；计数没有重复累计。
