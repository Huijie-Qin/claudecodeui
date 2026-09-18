# 分支到新聊天

Claude 聊天中，已完成回复底部的「分支到新聊天」会创建一个独立会话，继承截至该回复的原生历史。创建后立即切换到新聊天，输入下一条消息即可续聊。原聊天和新聊天使用同一个工作区，文件不会回滚，也不会创建 Git 分支。

首期只支持 Claude。源会话运行或等待工具结果时不能分叉；缺少可靠结束信息的旧记录不显示分叉入口。新聊天顶部提供返回来源聊天的入口。

## 实现

- `POST /api/sessions/:sessionId/fork?tenantId=…&workspaceId=…`，请求体为 `{ provider: "claude", sourceMessageUuid, requestId }`。用户身份来自认证。需要工作区编辑权限，且源会话属于当前用户、租户和工作区。
- `requestId` 用于幂等重试。成功返回 `{ sessionId, parentSessionId, sourceMessageUuid, session }`；前端先登记 `session` 再导航。
- 分叉使用固定版本的 Claude Agent SDK `0.2.141`。独立 worker 通过内存 `sessionStore` 调用 `forkSession`，不启动模型或扫描默认用户目录。只复制源 runtime 中指定消息以前的原生记录，生成新 UUID 并保留 `forkedFrom`。
- 完成位置由原生 `end_turn` 或 `completed-replies.jsonl` 中成功执行的结束标记确认。工具调用需要配对，同一助手响应只允许从最后一块分叉；历史分页后不会重新推断分叉位置。
- 命令显示和完成标记的 sidecar 随前缀截断并映射 UUID；压缩上下文的引用一并映射。继承主会话中的工具调用及结果，首期不复制子代理独立日志/展开明细或文件撤销快照。
- 补充展示记录使用新 ID，防止共享 runtime 的数据库唯一键把源消息移动到分支。数据库登记失败会清理新历史文件。Hook、定时任务和执行事实不会被重放或复制为新执行。
- 会话来源和历史所属的 runtime ID 存入 `session_index.metadata_json.fork`，防止较新的运行目录覆盖旧会话的定位。创建时不改变 runtime 的活跃会话绑定；下一次发送使用现有 `resume` 流程。
- 平台消息、token 和 MCP 工具统计忽略 `forkedFrom` / `inherited` 记录。新分支计为独立会话，分支后的实际请求正常统计；历史继承不产生新的模型请求。

## 验证

```sh
npm run test:session-fork
npm run typecheck
```

专项测试使用临时数据库、临时历史目录和本地模拟模型，不读取真实账号配置或调用外部模型。原生续聊测试需要允许本地端口监听，并安装 SDK 对应平台的可执行文件。

浏览器验收发现并修复了旧 `projects_updated` 在导航时重复消费、覆盖刚创建分支的问题，详见 [页面端到端验收记录](./session-forks-browser-e2e.md)。

合入 `develop` 前，在最新远端基线的独立工作区验证：专项回归 213 项通过，前后端类型检查、相关 ESLint（0 errors）和前后端构建通过。专项包含数据库运行目录隔离、继承统计去重，以及历史分页与子代理展开回归。

本机 Node 24.19.0 / better-sqlite3 12.11.1 的全量数据库测试触发过原生 `RemoveEnvironmentCleanupHook` GC 断言退出；上述 213 项使用 `NODE_OPTIONS=--max-semi-space-size=64 npm run test:session-fork` 通过。该参数仅用于本次验证，未改变生产启动配置。
