# SQL Check：Write 写入前校验

SQL Check 强制校验预置使用 `PreToolUse`，工具匹配为 `^Write$`。校验来自本次 `event.tool_input.content`，不读取最后一条回复或工具返回值。

- `.sql` 文件按完整内容校验，保留引号、注释及原始 SQL，拼错语句起始关键字也会送检。
- 其他文件从写入内容提取 SQL 代码块、JSON SQL 字段及原有支持的 SQL 格式；没有识别到 SQL 时继续原有权限流程。
- MCP 参数 `rule_ids` 使用当前工作空间生效的目录，包含 Agent 模板继承和用户个人选择。
- `check_sql_syntax` 必须返回对象及布尔字段 `valid`。`valid: true` 返回 `defer`，继续原有权限检查；`valid: false` 返回 `deny`，拒绝当前 Write，并将 `issues[].message` 反馈给模型。
- 脚本失败、MCP 不可用、返回格式错误或必要的审计记录失败时拒绝 Write。启用 `extensionLogic.failClosed: true`，服务不得退回不带必要 Hook 的 SDK 调用。
- 匹配范围只包含 Write。Edit、Bash、失败后事件及 Stop 不属于此次校验；不是对所有文件修改方式的统一拦截。预置保留仅主代理的范围，可通过现有子代理设置调整。

完整配置和脚本见 `examples/sql-check-write/hook.json`、`examples/sql-check-write/hook.js`。必须先部署支持 SQL Check verdict 映射的运行时，再更新原 Hook 的事件、匹配器、脚本、MCP 参数和 Claude 响应字段并发布。运行时会将 MCP 结果扩展为 `permissionDecision` 和 `permissionDecisionReason`，供配置引用。

升级保留原 Hook ID、启用范围、用户偏好、历史发布版本和执行记录。Agent 模板锁定的版本不会自动覆盖。已经开始的回合可能仍持有旧配置，后续回合加载新版本。
