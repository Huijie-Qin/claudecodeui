# CCUI v1：后台任务可查看

日期：2026-09-22

本次增加后台任务查看，沿用主会话和子代理现有的紧凑入口。范围包括后台任务详情、状态和历史恢复，不包含执行概览、待处理总览或问答/审批流程改动。

## 当前实现

- 后台通知使用与子代理一致的紧凑可点击入口：状态图标、任务标题和侧栏图标，点击打开详情。主会话不渲染任务卡片或日志摘要，明确区分运行、等待、完成、失败、停止和未知状态。
- 详情支持查看命令、输入、真实事件、已回传日志、输出路径和退出码，并可定位源消息或所属子代理。没有开始通知的后台命令也能从对应Bash记录旁打开。
- 按任务ID/工具ID合并生命周期；晚到运行事件不覆盖终态。恢复CLI的任务通知附件并持久化SDK任务事件，刷新后可继续查看。
- TaskOutput或对准确输出路径的成功Read可补充真实日志。运行环境临时路径无法直接预览时显示原因，不新增任意文件读取接口。
- 窄屏采用抽屉，Esc关闭后焦点返回任务入口。此面板只提供查看和定位。

## 真实样例

会话：http://localhost:3001/session/4588adec-ce2c-41ca-b9d5-c2f249fc74c9

两项后台命令使用演示数据，模型调用、进程和输出文件均为真实执行：汇总任务约70秒、退出0，生成3条区域数据，总额30000；受控失败任务约35秒、退出7。修复后的追加12秒后台任务也已验证刷新前后日志和状态保留。

## 回归验证

- `src/components/chat/execution/*.test.ts(x)`：状态与日志聚合、来源定位、入口去重和详情渲染。
- `src/components/chat/hooks/useChatMessages.test.ts`：通知合并及晚到事件的终态保护。
- `src/components/chat/hooks/useChatSessionState.test.ts`：刷新时保留后台通知。
- `server/modules/providers/list/claude/claude-sessions.provider.test.ts`：恢复CLI已投递的后台通知附件。
- `server/services/session-message-history.test.js`：SDK后台生命周期持久化。
