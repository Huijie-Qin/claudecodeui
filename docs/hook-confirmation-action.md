# Hook 后置行为：请求用户确认

在 `PreToolUse` Hook 的后置行为中添加“请求用户确认”，即可让 MCP 工具在执行前展示参数并等待用户确认。无需 Python、脚本输出声明或 `permissionDecision=ask` 返回绑定。

“后置”指 Hook 脚本及前序后置行为执行完成之后，原 MCP 工具此时仍未执行。每个 Hook 最多添加一个确认行为，并放在列表最后。如果前面配置了 `call_mcp_tool` 等行为，它们会先执行；这个确认保护的是触发 Hook 的原工具调用。

## 可直接使用的配置

- [hook.json](../examples/mcp-confirmation-action/hook.json)：完整配置，可作为 `POST /api/admin/hooks` 的请求体。
- [MCP调用前确认后置行为配置.txt](../examples/mcp-confirmation-action/MCP调用前确认后置行为配置.txt)：配置和启用步骤，便于保存、转发。
- [build-config.mjs](../examples/mcp-confirmation-action/build-config.mjs)：生成 JSON 与 TXT。

| 配置项 | 值 |
| --- | --- |
| Hook 事件 | `PreToolUse`（工具调用前） |
| Matcher | 正则 `^mcp__.*` |
| 包含子代理 | 开启 |
| 高级脚本 | 无 |
| 后置行为 | `request_confirmation`（请求用户确认） |
| 执行条件 | 留空，每次触发都确认 |
| 确认提示 | 即将调用 MCP 工具，参数已展示。请确认是否执行本次调用。 |
| Claude 返回绑定 | 无 |

后置行为结构：

```json
{
  "id": "confirm_mcp_call",
  "type": "request_confirmation",
  "config": {
    "condition": null,
    "messageTemplate": "即将调用 MCP 工具，参数已展示。请确认是否执行本次调用。"
  }
}
```

运行层记录工具名称和参数，再将确认请求交给 CCUI。聊天输入框上方的确认卡片展示完整 JSON 参数以及“取消调用 / 确定执行”。每次调用单独确认，不记住上一次授权；未确认时不得执行，取消后拒绝当前调用。审计日志按现有规则脱敏，不能将日志当作完整参数副本。

执行条件可填写布尔固定值或引用布尔变量，运行时必须得到布尔值；无法解析或类型不正确时拒绝调用。条件为 `false` 时跳过确认，因此需要每次强制确认时应留空。确认文案支持现有模板引用，例如 `即将调用 {{event.tool_name}}，是否继续？`；不必把参数重复写进文案，卡片自动展示参数。

## 启用与升级

1. 部署支持此后置行为及 MCP 确认卡片的前后端并重启后端。旧版仅导入配置不能实现强制确认。
2. 管理页创建上述 Hook，保存并发布；也可通过管理 API 创建、发布 JSON 配置。
3. 绑定目标用户或租户，在目标工作空间启用。需要强制执行时，分配为默认开启且不允许用户关闭。
4. 开始新的执行回合以加载发布版本。已运行的回合不会自动加载修改。

已有 [Python MCP 确认 Hook](python-mcp-confirm-hook.md) 仍可使用。迁移时启用本配置，再停用原 Python Hook，避免同一调用重复触发检查。本示例无需配置 Python 环境。

此行为仅覆盖 Claude SDK 中进入 `PreToolUse` 的 MCP 工具调用，非 MCP 工具自动跳过。上述配置同时包含子代理；终端直连 MCP、Hook 后置行为及调度基础设施的服务端 MCP 调用不在此配置保护范围。

## 本地验证

使用本地模型响应和回声 MCP，不连接外部模型或业务工具：

```sh
# 原生 SDK + 已发布 Hook 运行时：检查等待、取消和确认路径。
node scripts/python-mcp-confirm-e2e.mjs --run --post-action

# CCUI 浏览器演示：独立数据库、演示账号与工作空间。
node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json scripts/python-mcp-confirm-ccui-demo.mjs --post-action
```

浏览器演示默认地址为 `http://127.0.0.1:3930`，登录信息见启动输出；如端口已被占用，可设置 `MCP_CONFIRM_CCUI_UI_PORT` 与 `MCP_CONFIRM_CCUI_PORT`。运行状态写入 `.tmp/mcp-confirmation-action-ccui/latest.json`。演示账号为 `mcp-post-action-demo`，项目为“MCP后置行为逐次确认演示”。

输入“请连续两次调用演示回声工具。”，确认第一个调用后应出现第二次确认；未确认第二次时，`mcp-executions.jsonl` 只能有一条记录。取消第二次后记录数应保持不变。新会话输入“请调用一次演示回声工具。”并确认，才会新增一条工具执行记录。审计记录保存在隔离数据库的 `hook_executions` 表中。

重新生成配置文件：

```sh
node examples/mcp-confirmation-action/build-config.mjs
```

2026-09-20 已通过 CCUI 浏览器验证：在管理页添加本行为、修改提示、保存并重新发布到 v2；无需脚本或返回绑定，聊天卡片显示新提示和完整参数。第一次确认前执行 0 次，确认后执行 1 次；第二次仍单独询问，取消后总执行次数保持 1 次。
