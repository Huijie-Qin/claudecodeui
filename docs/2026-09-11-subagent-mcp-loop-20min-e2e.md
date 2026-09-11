# 子代理 MCP 循环：20 分钟端到端验收

状态：通过。2026-09-11 完成真实 20 分钟浏览器端到端验收，独立验证器 `passed: true`。最终成功运行使用修复后的完整构建，未压缩任务时间。

## 验收结果

| 指标 | 实际结果 |
| --- | --- |
| 提交时间（北京时间） | 16:37:04.109 |
| 观测到成功 | 16:57:14.205 |
| 真实任务耗时 | 1,210,096 ms，20 分 10.096 秒 |
| Hook 等待耗时 | 1,210,186 ms |
| 子代理提交任务 | 1 次 |
| 子代理调用 `get_task_status` | 1 次 |
| Hook 后续轮询 | 119 次；加上原始调用共 120 次实际查询 |
| 等待期间额外子模型回合 | 0 |
| 主代理 MCP 调用 / 父会话循环作业 | 0 / 0 |
| 原工具结果 | `running` |
| 替换后原工具结果 | 相同任务 ID 的 `success`，无工具错误 |
| 子代理与主代理最终状态 | 均为 `success` |

浏览器同时确认 Hook 卡片、子代理原状态工具调用以及主代理最终回复为成功。运行中刷新可恢复两次工具记录，等待状态正确；完成后再次刷新，成功结果、子代理身份及两次工具历史均保留。

- [验收会话](http://127.0.0.1:3911/session/b19f3a17-a1f0-4c55-a64c-9ff46cf8fbbc)
- [独立验证报告](../.tmp/hook-subagents-e2e/loop20-v4-independent-report.json)
- [完整证据](../.tmp/hook-subagents-e2e/loop20-v4-independent-evidence.json)
- [逐分钟监测](../.tmp/hook-subagents-e2e/loop20-v4-independent-monitor.json)

## 验收流程

使用两个独立 HTTP 服务：任务服务与 MCP 服务。MCP 仅公开 `execute_task` 和 `get_task_status`。任务服务从收到提交请求开始计时，经过真实的 1,200,000 毫秒后才把状态从 `running` 变为 `success`；`should_fail` 分支支持返回 `failed`。真实验收不注入时钟，也不压缩任务时间。

浏览器创建并发布 Hook「E2E 子代理等待 20 分钟任务」，然后新建会话：

1. 主代理启动一个真实 general-purpose 子代理。
2. 子代理调用一次 `execute_task`，取得真实任务 ID。
3. 子代理调用一次 `get_task_status`，首次 MCP 返回 `running`。
4. `PostToolUse` Hook 每 10 秒使用相同任务 ID 查询状态，并执行 Python 终止判断。
5. 任务完成后，Hook 将最终结果通过 `updatedMCPToolOutput` 替换原工具结果。
6. 子代理读取该工具调用的最终结果，报告任务 ID 和状态，再由主代理汇总。

Hook 配置：

| 字段 | 值 |
| --- | --- |
| 事件 | `PostToolUse` |
| 同时对子代理生效 | 开启 |
| Matcher | `mcp__qa_subagent_loop20__get_task_status` |
| 轮询间隔 | 10,000 ms |
| 单次调用超时 | 15,000 ms |
| 最长等待 | 3,600,000 ms |
| 终止条件 | `success` 或 `failed`；其他状态继续等待 |

## 环境与证据

隔离实例为 `ccui-hook-subagents-e2e`，浏览器入口为 `http://127.0.0.1:3911`，只读证据入口为 `http://127.0.0.1:3912/evidence`。任务服务与 MCP 服务分别使用容器内 40140、40141 端口，没有发布额外的宿主机端口。

真实执行部分包括 CCUI、SQLite、容器内 Claude Agent SDK 0.2.116、Claude CLI 2.1.221、子代理、MCP 请求、Hook、Python 终止脚本以及 20 分钟时间跨度。本地构建使用的 SDK 开发依赖为 0.2.141，运行时版本已在验收容器内单独核对。模型响应使用本地确定性服务；它读取真实工具结果，不提前返回成功，不自行代替 Hook 轮询。

服务记录实例 ID、启动时间、任务创建时间和每次 MCP 请求、任务观测时间。独立验证器检查原始 `running`、Hook 最终替换结果、子代理后续模型请求中的工具结果、提交次数、查询次数和主子代理隔离。

相关脚本：

- `scripts/mcp-loop-demo-task-service.mjs`
- `scripts/mcp-loop-demo-mcp.mjs`
- `scripts/hook-subagents-e2e.mjs`
- `scripts/verify-subagent-loop-e2e.mjs`

接入检查修复了两个测试夹具问题：容器内 MCP 地址被按宿主机地址改写，以及 Claude CLI 在 JSON 工具结果后追加提示文本。首次尝试仅提交了任务，未进入循环，不计作长时验收通过。

第二次尝试发现并修复了产品兼容问题：Claude CLI 的 `PostToolUse.tool_response` 可以是 JSON 字符串，而循环终止脚本需要对象。原实现直接传入字符串，导致 Python 的 `result.get("status")` 报错。`normalizeMcpLoopResult` 现在先解析合法 JSON 字符串，再执行原有 MCP 结果归一化；普通文本和非法 JSON 保持原样。第三次运行使用修复后的服务和重新提交的完整 20 分钟任务。

第三次运行在真实 1,209,786 ms 后观测到远端 `success`，执行了 120 次状态查询（原调用 1 次、Hook 轮询 119 次），但最终子代理收到 `e.reduce is not a function` 工具错误。实际 CLI 将 `updatedMCPToolOutput` 直接用作工具消息内容，只接受字符串或内容块数组。已修复原生出口：返回 `[{"type":"text","text":"<最终业务 JSON>"}]`，审计和聊天 Hook 卡片仍保留业务对象。独立验证器新增输出格式和 `is_error` 检查，避免把仅远端成功当作端到端通过。

[官方 Hook 文档](https://code.claude.com/docs/en/hooks#posttooluse-decision-control) 要求替换值匹配工具的输出形状；本轮另以实际 CLI 代码和真实 SDK/CLI 格式契约确认该版本的内容格式。

修复后的真实 SDK/CLI 格式契约已通过：子代理及父代理的实际后续模型输入均包含替换后的成功状态。该快速格式探针主动构造终态文本，只验证 CLI 合同，不计作 20 分钟任务成功；正式验收另用新任务完整等待。

## 回归与中途检查

- 真实 HTTP + Python 子代理循环集成及相关服务回归：18/18 通过。该快速测试使用短任务，独立于真实 20 分钟验收。
- CLI 工具结果解析回归：3/3 通过。
- 独立验收器回归：12/12 通过，包含第三次运行暴露的裸对象和 CLI 工具错误故障。
- 原生返回格式修复后，Hook Runtime 与 HTTP/Python 集成回归：37/37 通过。
- 历史与路径安全回归：16/16；Claude Provider：30/30；前端聊天转换：40/40 通过。
- 前后端类型检查与构建通过；修改文件 ESLint 无错误，历史文件原有 import 警告保留；`git diff --check` 通过。
- 第三次真实任务运行约 5 分钟时刷新浏览器，会话重新连接并恢复「执行中」的子代理 Hook 卡片；随后后台记录已达 37 次同一任务状态查询，仍为 `running`，模型请求没有增加。

中途刷新同时暴露了既有历史恢复缺口：父 Agent 调用尚未结束时，没有父 `tool_result.agentId`，因此界面未加载已写入子代理 JSONL 的两次工具调用。恢复逻辑现通过同会话子代理 `.meta.json.toolUseId` 关联父工具调用，并按父工具 ID 分别传给 Provider。它只恢复已持久化事实，不生成工具结果或提前完成任务；包含并行代理隔离、完成历史兼容和异常元数据回归。第四次运行开始约 1 分钟后刷新浏览器，已实测恢复两次工具调用，状态查询与 Hook 仍在执行。

最终成功运行标识：`loop20_20260911_success_v4`，任务 `f4d05c63-ea70-4b45-80cf-54907e34d508`，子代理 `a241de1f9354ccefd`，Hook 执行 `68e5b775-df0e-4ef5-9eb0-6a07355b298c`。第三次失败证据保存在 `.tmp/hook-subagents-e2e/loop20-v3-independent-evidence.json` 与对应 `-report.json`，未被成功运行覆盖。

## 复现与验证

按 [原子代理验收说明](2026-09-10-hook-subagents-e2e.md) 启动隔离实例，同时设置 `HOOK_SUBAGENTS_E2E_LOOP_DEMO=1`。这会启动全新的任务服务和 MCP 服务，并注册两个 MCP 工具。`/state` 中的 `loopDemo` 提供实际工具名称、浏览器测试提示词和 Hook 配置样例。

在浏览器发布上述 Hook 后，新建会话发送带唯一 `HOOK_SUBAGENTS_E2E RUN=loop20_<唯一名称>` 标识的测试提示词。等待任务完成后执行：

```sh
node scripts/verify-subagent-loop-e2e.mjs \
  --run loop20_<唯一名称> \
  --output .tmp/subagent-loop-verification.json
```

验证器默认读取 `http://127.0.0.1:3912/evidence`；也可使用 `--evidence <已保存的 JSON 文件>` 离线复查。验证未完成的运行会失败，不会将仍在等待的任务判为成功。

## 覆盖边界

本轮覆盖一个前台子代理的真实 20 分钟成功路径和浏览器中途重连。任务服务的 `failed` 状态、循环取消、总截止时间和连续三次 MCP 错误另有自动化回归；没有将这些回归描述为真实 20 分钟浏览器场景。

子代理循环驻留服务进程，服务重启不能恢复；最终成功运行期间没有重启服务。多个并行长循环、后台子代理和 40 分钟真实运行不属于本轮覆盖范围。当前 MCP 不使用鉴权 helper；现有 `headersHelper` 的准备耗时不计入单次 MCP 请求超时，循环的总截止时间仍独立生效。
