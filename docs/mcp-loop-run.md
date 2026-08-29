# MCP 后置循环（`mcp_loop_run`）

`mcp_loop_run` 是 CCUI 内部的 Hook 后置行为，不会作为工具暴露给 Agent。它仅适用于 `PostToolUse`：第一次 MCP 工具调用返回后，CCUI 可暂停当前 Claude 会话，并使用触发时解析出的同一组参数在后台重复调用指定 MCP 工具。

当前版本只支持：

- 每轮使用完全相同的参数；
- 每轮使用一个 Python 脚本判断 `running`、`success` 或 `failed`；
- 一个 Hook 最多配置一个循环行为，且必须是最后一个后置行为。

命中成功、失败或总超时后，CCUI 使用原始 `toolUseId` 将最终工具结果注入 Agent 上下文，然后自动恢复同一 Claude 会话。页面中的原 MCP 工具卡片保留首次返回结果（例如 `running`），循环终态结果单独展示在 Hook 卡片中。每次轮询都是一次独立的短 MCP 调用，轮询间隔内不占用 MCP 连接。

## 20 分钟模拟环境

项目提供两个独立服务：

1. `mcp-loop-demo-task-service.mjs`：任务服务，默认在 20 分钟（1,200,000 ms）后返回 `success`；
2. `mcp-loop-demo-mcp.mjs`：MCP 服务，提供 `execute_task` 和 `get_task_status`。

分别启动：

```bash
pnpm run mock:mcp-loop-task
pnpm run mock:mcp-loop
```

MCP 地址为 `http://127.0.0.1:40131/mcp`。先调用 `execute_task`，再使用返回的 `task_id` 调用 `get_task_status`。

在 `get_task_status` 的 `PostToolUse` Hook 中添加“循环调用 MCP”，建议配置为：

```python
async def run(event, ccui):
    result = event.get("result") or {}
    status = result.get("status")

    if status == "success":
        return {"output": {"status": "success"}}
    if status == "failed":
        return {"output": {"status": "failed"}}
    return {"output": {"status": "running"}}
```

每轮脚本可读取 `event.result`、`event.initial_result`、`event.inputs`、
`event.attempt_count` 和 `event.elapsed_ms`，并可使用受限的
`ccui.workspace` 与 `ccui.log` API。旧版字段等值条件会在读取时自动转换为等价 Python 脚本。

Python Hook 默认禁止模块导入。可通过服务端环境变量配置精确的标准库白名单：

```bash
CCUI_HOOK_PYTHON_IMPORT_ALLOWLIST=json,re,math,datetime
```

只允许名单中的顶层模块；相对导入、子模块、通配符和未列出的模块仍会被拒绝。

自动化端到端测试使用同一个任务服务，但注入 300 ms 的任务时长，避免 CI 真实等待 20 分钟：

```bash
pnpm run test:mcp-loop-e2e
```

如需缩短手动调试时间，可在启动任务服务时设置：

```bash
MCP_LOOP_DEMO_TASK_DURATION_MS=30000 pnpm run mock:mcp-loop-task
```

## 当前边界

- 后台循环由 CCUI 服务进程内的 worker 调度，不占用 Agent/模型执行槽；
- 同一 Claude 会话同时只允许一个活动循环；
- CCUI 服务进程重启后，不保证自动重建尚未完成循环对应的 Agent 恢复上下文；
- Python 使用隔离运行器执行；脚本异常会按轮询错误重试，连续三次异常后循环失败。
