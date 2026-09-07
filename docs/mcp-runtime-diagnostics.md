# MCP 会话日志（PM2 后端 + Docker workspace）

更新代码后，在部署目录重新构建后端，并重启实际的 PM2 应用：

```bash
npm run build:server
pm2 restart <应用名称或ID>
pm2 logs <应用名称或ID> --lines 200
```

在目标 workspace 启动一次新的 Claude 查询，搜索 `[MCP Runtime]`。
这些是后端接收的实际会话日志，不是 Admin 的 MCP 探测日志。

| event | 查看内容 |
| --- | --- |
| `config` | `configPath` 是本次读取的 workspace 配置路径；`serverNames` 是最终传给 SDK 的服务器；`disallowedMcpTools` 是被禁止的 MCP 工具或模式。 |
| `sdk_init` | SDK 初始化时的服务器状态；`advertisedToolCount` 是初始化工具清单中匹配的数量，不能当作全部工具数量（可能有延迟发现的工具）。 |
| `sdk_status` | 初始化后异步查询一次 SDK，获得实际连接状态、`toolCount` 和 `errorCategory`。 |
| `status_unavailable` | SDK 不支持状态查询、查询失败或 5 秒内未返回。它表示诊断查询未完成，不表示 MCP 服务器一定不可用。 |

通过 `requestId`、`workspaceId`、`runtimeId` 和 `sessionId` 关联同一次查询。
首次 `config` 的 `sessionId` 可能为空，因为 SDK 尚未创建会话。

- `config.serverNames` 中没有目标 MCP：检查该路径的配置及现有 `Error loading MCP config` / `Failed to parse` 日志。
- `sdk_status` 为 `failed` 或 `needs-auth`：按错误类别检查 workspace 容器内的网络、证书或认证环境。
- `connected` 但 `toolCount: 0`：SDK 在该次快照中未返回工具。
- `connected` 且工具数量大于零：继续检查 `disallowedMcpTools`、Agent 工具选择和延迟工具发现。
- `missingFromSnapshot` 表示传入 SDK 的服务器未出现在该次快照中；初始化可能仍在进行，不能单凭它判定最终连接失败。
- `toolCount: null` 表示 SDK 未提供工具清单，和零个工具不同。

错误只输出 `authentication`、`timeout`、`tls`、`dns`、`network`、`protocol`、`process_or_file` 或 `other` 等分类，不输出原始错误正文。分类是启发式提示，不是最终根因。
日志不序列化服务器配置、URL、认证头、环境变量、helper 命令、工具描述或返回正文。
状态查询不阻塞会话，也不自动重连或更改 MCP 配置。此日志覆盖普通 Claude 会话的 SDK 查询入口，不覆盖 Codex 或独立 Agent Graph 运行入口。
