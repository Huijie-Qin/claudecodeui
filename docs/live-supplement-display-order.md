# 即时补充输入的显示顺序

目标顺序：当前 Claude 回复（已显示内容及同条回复后续内容）→ 补充消息 → Claude 后续的新回复。

输入仍通过现有 `pushClaudeSupplement` 立即进入 SDK 输入流，保持 `priority: now`；不等待 result、Stop 或回合结束，不分割回复文本。

## 数据与处理

- `assistantMessageId`：来自 Anthropic `message.id`，在 `message_start`、增量事件、完整回复和历史 JSONL 之间保持一致。子 Agent 按 `parent_tool_use_id` 隔离。
- `displayAfterAssistantId`：收到补充输入时记录当时主 Agent 回复的标识，仅影响显示。客户端乐观消息先引用已显示回复，服务端确认携带权威关联。
- `supplementSequence`：同一运行中的补充消息接收序号，用于同一回复后的多条输入排序。
- 在已有私有 `display-commands.jsonl` 中保存显示关联，与原始 transcript 分离，不修改模型上下文。普通输入也允许仅记录关联，不增加显示文案。
- 实时合并和服务端历史分页前共用排序函数。完整回复替换流式占位后，补充消息仍放在同一 `assistantMessageId` 的最后一个显示块后。
- 历史尚未包含显示元数据时保留实时关联；完整刷新后从文件恢复。缺失或尚未加载的关联保持原位置，不丢弃消息。

## 验证

覆盖同条回复追加、完整回复替换、相同内容的新回复、连续补充、历史刷新与分页、子 Agent 隔离，以及当前回合尚未结束时 SDK 立即读到补充输入。

已有历史没有保存关联，无法仅根据文本或时间戳可靠推断发送时是哪条流式回复；不对这类历史猜测性重排。
