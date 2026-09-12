# 子 Agent MCP 循环：Docker 真实页面回归

日期：2026-09-12。入口：`http://localhost:3001`，Docker 服务 `ccui-cloudcli-1`。

本轮使用真实 CCUI 页面、主/子 Agent、HTTP MCP、Python 终止脚本和 SQLite 审计。模拟任务时长为 **30 秒**，不将本轮结果计为 20 分钟长时验收。此前长时测试记录见 `2026-09-11-subagent-mcp-loop-20min-e2e.md`。

## 最终结果

- [修复后实时验收会话](http://localhost:3001/session/ce4db39e-275d-4414-bf4f-f569a4b9d909)
- 测试标识：`child-loop-display-20260912`
- 任务：`4652b640-0878-457c-91c2-d7cdb37c869d`
- 子 Agent：`ab9d9bf3338634a25`
- Hook 执行：`efc415a5-ae67-4dc2-ab59-1f4a89f897ed`
- 循环作业：`1662a6c0-c4a0-4a83-ae3b-211ba6823951`
- 原工具调用：`call_dd9d15a25db447b89c3daf8a`

子 Agent 只执行 `execute_task(should_fail=false)` 和一次 `get_task_status(task_id)`，无 Bash、sleep 或手动重复查询。主 Agent 仅启动子 Agent 并汇总报告。

首次状态为 `running`（任务已运行 1,624 ms）；后台轮询 3 次，最终为 `success`（任务已运行 34,174 ms）。首次判断及 3 次轮询的脚本均执行完成，判断依次为 `running / running / running / succeeded`。

真实页面确认：

- 等待期间出现带子 Agent 身份的「等待异步任务完成」Hook 卡片，状态为「执行中」。
- 完成后 Hook 卡片展示最终业务结果 `success`。
- 不刷新页面，打开子 Agent 侧栏 → `get_task_status / Details`，仍展示首次 `running` 和 `elapsed_ms: 1624`。
- 子 Agent 后续报告实际收到 `success`，主 Agent 汇总相同状态。
- 子 Agent 显示 2 次工具调用、约 38 秒。

## 本轮发现与修复

首次两次页面尝试没有触发循环。检查发现该 Hook 已发布、对 root 可见，但尚未在 `hook-verification` 工作区启用。仅重建镜像并不能解决未启用的问题；已通过「设置 → 辅助功能」启用本工作区的「等待异步任务完成」。

启用后，[第一次成功循环会话](http://localhost:3001/session/ce24236c-a0e4-44b1-9644-46e712c23e7a) 暴露了展示缺口：子 Agent 的 CLI 工具历史已经包含替换后的最终结果，侧栏因而展示 `success`，没有保留首次 `running`。

修复方式：

1. `server/claude-sdk.js` 将触发 Hook 的 `tool_use_id` 带入实时 Hook 活动。
2. `server/services/session-message-history.js` 从执行记录恢复相同工具身份，兼容旧活动缺少该字段的情况。
3. `src/components/chat/hooks/useChatMessages.ts` 按会话 ID 与工具调用 ID 精确关联子 Agent 循环的 `initialResult`；仅用于工具卡片、嵌套侧栏和历史工具列表的展示。
4. 最终结果仍留在 Hook 卡片，模型接收的 `updatedMCPToolOutput` 和持久化模型历史不变。转换过程不修改 session store 输入。

Docker 重建后回到第一次成功会话，已验证历史恢复将原工具详情显示为 `running`。随后再通过新会话验证实时路径，结果如上。

## 管理员核查入口

「Admin → Hooks → 等待异步任务完成 → 执行记录 → 具体执行」。

第一次成功循环执行 `c973a446-e9c5-48cf-94fe-a2d0de178644` 已在真实页面展开核对：

- 「循环脚本轮次（4）」包含第 0 轮首次判断及第 1～3 轮后台轮询。
- 每轮可以展开查看真实脚本 `event` 与输出；末轮 `result.status=success`、`initial_result.status=running`。
- 「返回 Claude」明确含 `hookSpecificOutput.updatedMCPToolOutput` 的最终成功结果。

注意：该第一次成功会话的模型报告曾因返回值仍为标准 JSON 而声称“未被 Hook 替换”。这是模型推测错误；是否替换应以执行记录中的真实输入与返回 Claude 字段为准。最终回归提示只要求模型报告所收到的事实，不要求它猜测不可见的 Hook 实现。

## 回归与边界

- 聊天转换及历史恢复：61 项通过。
- SDK 与子 Agent 时间线：48 项通过。
- 前后端 TypeScript 检查通过，`git diff --check` 通过。
- 修改文件 ESLint 无错误；历史文件已有 2 条 import 顺序警告。
- Docker 构建并启动成功；构建仍有已有 CSS/包体积及依赖审计警告，本轮未扩大范围处理。
- 本轮未重新测试 20 分钟等待、100 并发或循环中途重启服务。子 Agent 原生回调仍依赖运行中的 SDK 进程。
- 本轮未提交或推送 Git；工作区其他未提交修改保持原状。

## 后续调整：子代理 Hook 归入子代理活动

按用户要求，子代理 Hook 卡片已移入所属「子代理活动」时间线，主对话不再重复展示；主代理 Hook 保留原位。

关联优先使用父 Agent 工具调用 ID，其次使用触发 Hook 的工具 ID（包括实时消息、完整历史和旧版紧凑工具历史），最后使用精确子代理 ID。不会按代理类型猜测归属。尚无法关联的记录暂时保持可见，后续收到所属调用数据后重新归属，避免丢失记录。兼容旧 Task/Agent 别名，且 Hook 更新会参与侧栏滚动状态计算。

重建 Docker 后，已刷新上述会话验证历史归属。随后在同一会话通过真实页面发送 `child-hook-panel-20260912`，创建第二个 general-purpose 子代理「Hook 卡片侧栏归属验证」：

- 新子代理 ID：`ad7edd9de56a0e454`。
- 新任务 ID：`a2962b41-f76b-43fb-940b-02e36615d39b`。
- 子代理仅 2 次工具调用，约 40 秒完成；收到最终 `success`。
- 新子代理侧栏内含自己的 Hook 最终结果 `success`，原 MCP 工具结果仍为 `running`（`elapsed_ms: 1374`）。
- 切换回旧子代理，仍仅显示旧任务 `4652b640-0878-457c-91c2-d7cdb37c869d` 的 Hook，无新子代理卡片混入。
- 主对话仅保留主代理 Hook，无子代理 Hook 重复卡片。

相关 SDK、聊天转换与时间线测试 95 项通过，前后端类型检查与修改文件 Lint 通过，`git diff --check` 通过。此次页面观察验证了完成态和历史恢复；执行中状态及并行归属由新增自动化用例覆盖。
