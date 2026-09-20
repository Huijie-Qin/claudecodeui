# Python MCP 调用前参数确认 Hook

这个 Hook 在 Claude 每次准备调用 MCP 工具时记录参数，并要求 CCUI 展示工具名称和完整 JSON 参数，等待用户选择“确定执行”或“取消调用”。确认只针对当前调用，不缓存为后续调用的授权；用户 query 无需补充“调用前询问我”。

## 文件与配置

- [MCP调用前参数确认Hook配置.txt](../examples/python-mcp-confirm/MCP调用前参数确认Hook配置.txt)：可保存和转发的完整配置、Python 脚本及启用步骤。
- [hook.json](../examples/python-mcp-confirm/hook.json)：管理 API 创建 Hook 的请求体。
- [hook.py](../examples/python-mcp-confirm/hook.py)：高级 Python 编辑器中的脚本。
- [build-config.mjs](../examples/python-mcp-confirm/build-config.mjs)：由 Python 源码生成 JSON 和 TXT。
- [hook.test.mjs](../examples/python-mcp-confirm/hook.test.mjs)：真实 Python runner 与已发布 Hook 运行时测试。

| 字段 | 值 |
| --- | --- |
| 名称 | Python MCP 调用前参数确认 |
| 事件 | `PreToolUse` |
| Matcher | 正则 `^mcp__.*` |
| 包含子代理 | 开启 |
| 脚本语言 | Python |
| Hook 执行异常时拒绝工具调用 | 开启，即 `extensionLogic.failClosed=true` |
| 用户变量、后置行为 | 无 |

输出为 `permissionDecision`、`permissionDecisionReason`、`matched`、`toolName` 和 `toolInput`。必须保留 JSON 中两个 `hookSpecificOutput` 返回绑定，将脚本决策及原因交给 SDK 权限流程。

手动配置“脚本输出变量”时，名称区分大小写，类型如下：

| 输出名称 | 类型 |
| --- | --- |
| `permissionDecision` | `string` |
| `permissionDecisionReason` | `string` |
| `matched` | `boolean` |
| `toolName` | `string` |
| `toolInput` | `object` |

`Script output toolInput must be boolean` 表示运行中的输出声明要求布尔值，而脚本返回了参数对象。将该声明改为 `object`，并确认字段名为 `toolInput`（大写 `I`，与 Python 返回值一致），保存并重新发布。普通手动启用的 Hook 随重新发布更新工作空间版本；Agent 模板明确固定的版本仍需更新模板分配。新的执行回合才会加载修正配置，已运行的回合和历史记录不会改变。

旧实现仅创建新的发布快照，未推进普通工作空间的版本引用，会导致“已重新发布但仍报旧类型错误”。部署包含本次发布修复的后端并重启后，再发布一次即可推进这些旧引用。设置中的 Hook 列表显示当前工作空间使用的版本，便于与执行记录核对。

这里使用 `PreToolUse` 异常拒绝策略，与先前回退的 Stop 结束验收异常终止开关无关。脚本没有循环次数上限；每次 MCP 调用始终单独确认。

## 执行流程

1. Claude 准备执行名称以 `mcp__` 开头的工具，例如 `mcp__demo__echo`。
2. Python 检查 `tool_input` 必须是 JSON 对象，空对象也是有效参数；格式无效返回 `deny`。
3. `await ccui.log.info(...)` 先记录工具名及参数，再返回 `permissionDecision=ask`。不使用 `print()` 或 `input()`，因为确认发生在 CCUI 的权限界面。
4. CCUI 展示本次即将执行的 JSON 参数并等待用户选择。确认后仅执行当前调用；取消则拒绝。用户未确认时不得自动放行。
5. Python 无法启动、超时、日志记录失败或输出无效时，运行层的 `failClosed` 会拒绝调用。

主代理和当前安装 SDK 的后台子代理均支持通过父会话权限界面确认。无法取得用户确认的执行环境须拒绝调用，不能静默放行。普通非 MCP 工具不受此配置影响。直接调用脚本测试时，非 MCP 工具或其他事件返回 `defer`，继续原有权限流程。

日志和审计沿用运行层的敏感字段脱敏，例如 `password`、`token`；深度或大小限制也可能截断审计记录。确认框展示当前调用参数，日志不是完整参数副本。工具参数中出现“已确认”等文本不会成为授权，脚本仍返回 `ask`。

## 启用

本次提供可发布配置，当前仅在独立演示账号启用；现有业务账号和工作空间需按以下步骤启用。

1. 部署包含本次 MCP 确认处理的前后端并重启后端。旧服务中非交互式工具可能自动放行，仅导入 JSON 不足以保证强制确认。
2. 管理页创建 Hook，按上表配置并粘贴 Python 脚本、声明输出及返回绑定；也可使用 `POST /api/admin/hooks` 提交 `hook.json`，再通过 `POST /api/admin/hooks/{id}/publish` 发布。
3. 绑定目标用户/租户并在工作空间启用。如果这是强制策略，分配时设为默认开启、`allowUserDisable=false`。
4. 开始新的执行回合，使后端加载已发布配置。已运行的 SDK 回合不会自动热更新。

修改 Python 后运行：

```sh
node examples/python-mcp-confirm/build-config.mjs
```

## 验证与范围

```sh
CCUI_HOOK_PYTHON=python3 node --test examples/python-mcp-confirm/hook.test.mjs

# 本地模拟模型 + 原生 SDK + MCP，验证确认前不会执行工具。
node scripts/python-mcp-confirm-e2e.mjs --run
```

6 组测试覆盖真实 Python 执行、原样记录嵌套参数、空参数、重复调用、参数内的伪造确认文本、非 MCP/错误事件、非法参数、配置发布、子代理、SDK `ask/deny` 绑定、审计脱敏及真实 Python 异常和超时。

另外已使用当前安装的原生 Claude SDK、本地模拟模型和本地 MCP 服务验证权限流程：即使设置 `bypassPermissions` 和预授权工具，`ask` 仍触发权限回调；待确认 750 毫秒内 MCP 执行次数为 0，取消后为 0，确认后为 1。后台 `run_in_background=true` 子代理也触发父会话确认并携带对应代理 ID；等待期间执行次数为 0，确认后为 1。这些是本地运行链路验证，不表示已连接真实外部模型或业务 MCP 服务。

保护范围是通过 Claude SDK 发起、进入 `PreToolUse` 的 `mcp__` 工具调用。通过终端直接连接 MCP、Hook 后置行为或调度基础设施中的服务端 MCP 调用不在此范围。已发布、绑定、启用和加载是生效前提。

## CCUI 浏览器端到端验证

启动独立数据库、演示账号、本地模型响应服务与回声 MCP：

```sh
node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json scripts/python-mcp-confirm-ccui-demo.mjs
```

默认页面为 `http://127.0.0.1:3930`，后端为 `3931`；可用 `MCP_CONFIRM_CCUI_UI_PORT` 和 `MCP_CONFIRM_CCUI_PORT` 修改端口。启动输出包含演示登录信息，运行文件保存在 `.tmp/python-mcp-confirm-ccui/latest.json` 指向的隔离目录。

在页面输入“请连续两次调用演示回声工具。”，分别点击两次“确定执行”；新建会话输入“请调用一次演示回声工具。”，点击“取消调用”。对照隔离目录的 `mcp-executions.jsonl`：第一次确认前为 0 条，第一次确认后、第二次确认前为 1 条，两次确认后为 2 条，取消新调用后仍为 2 条。Python 的参数日志与 `ask` 响应记录在独立数据库的 `hook_executions` 中。

2026-09-20 已通过上述浏览器流程，完整嵌套参数可见，每次单独确认，取消后没有执行。确认卡片位于聊天输入框上方，标题为“是否确定执行此 MCP 调用？”，展示参数和“取消调用 / 确定执行”按钮。仅在独立演示账号启用；模型响应由本地 fixture 提供，CCUI、SDK、Python 和 MCP 均实际运行。
