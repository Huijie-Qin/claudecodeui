# Skill 发布打点与代码产出来源

## Skill 发布打点

用户确认发布、请求通过租户和工作区权限检查后，由服务端记录操作；首次上传发布和已有 Skill 的发布更新都覆盖。打开发布预览、取消确认、下载、导入和普通保存不计作发布操作。

原始事件表：`ai_skill_publish_events`，位于项目配置的 SQLite 数据库（`DATABASE_PATH`），不是浏览器本地存储。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| id | TEXT | 服务端生成的一次发布请求 ID；同一请求的状态更新不重复插入 |
| tenant_id | INTEGER | 当前租户 ID |
| user_id | INTEGER | 发起发布的平台用户 ID，取自认证上下文 |
| workspace_id | INTEGER | 发布所在工作区 ID，取自权限校验后的上下文 |
| skill_id | TEXT | 市场 Skill ID；首次保存成功前可能为空 |
| skill_name | TEXT | 本次发布的本地 Skill 名称 |
| publish_kind | TEXT | `create` 首次上传发布；`update` 已有 Skill 发布更新 |
| status | TEXT | `requested` 已请求；`succeeded` 远端已确认成功；`failed` 明确失败；`unknown` 远端结果不确定 |
| requested_at | TEXT | 服务端接收到发布操作的时间 |
| published_at | TEXT | 服务端收到远端发布成功确认的时间；未确认成功为空 |
| finished_at | TEXT | 本次请求得到成功、失败或不确定结果的时间 |
| published_version | INTEGER | 发布版本；无可靠值时为空 |
| failure_code | TEXT | 通用失败类别，不保存远端错误正文、Token 或 Skill 内容 |

源事件时间沿用现有内部事实表的带时区 ISO 时间格式；夜间对接表、主题表沿用 Asia/Shanghai 的 `YYYY-MM-DD HH:mm:ss` 格式。

### 看板统计规则

本次先保留已有指标定义：

- “累计发布 Skill 数量”：确认首次上传并发布成功的 Skill ID 去重数。
- “期间新增发布数”：上述首次发布发生在筛选日期内的 Skill ID 去重数。
- `update` 事件保留发布操作历史和可信发布者证据，但不会把旧 Skill 算作新发布，也不改写旧首次发布时间。
- `failed`、`unknown`、尚未结束的 `requested` 不计入成功发布。远端成功后，本地写绑定失败不能把已确认的远端成功改为失败。
- 新打点与原有 `ai_skill_publications` 同时存在时，同一次发布只进入一条看板发布事实。新增事件保留工作区信息；旧记录缺失的工作区不猜测补齐。
- 没有历史记录的 Skill 不从当前市场状态或导入时间推断首次发布时间；打点上线前的历史不会凭空补出。

### 数据链路与生效时间

`发布确认 → ai_skill_publish_events → 夜间统计 → ai_usage_report_rows → ai_dashboard_integration_detail → ai_dashboard_skill_publication_detail → AI 看板`

打点实时落库，看板仍使用成功发布的夜间统计快照。普通“刷新结果”只读取最近快照，不立即运行统计。配置版本升级后，下一次允许执行的批次会重新建立来源索引；后续按事件变更增量处理。新旧正式结果同事务发布，权限和导出范围沿用现有规则。

无需新增环境变量。后端正常初始化时创建事件表，即使夜间统计未启用也可记录发布操作；看板更新仍需启用并运行现有 `AI_USAGE_ENABLED` 任务。

打点失败会输出 `[AiUsage] Skill ... requires reconciliation` 日志，不重试市场发布、也不把已经成功的发布业务改为失败。进程退出或响应丢失可能留下 `requested/unknown`，这些记录不自动认定成功；当前没有自动核对外部市场的补偿任务。

## 代码产出来源（2026-09-24 更新）

“生成 SQL 行数”现已改为夜间扫描会话中各轮 AI 回复，不再从 Hook 业务记录取数，也不需要绑定或启用 SQL 记录 Hook。来源、文本识别和去重规则见 [AI 使用报表统计口径](ai-usage-metric-definitions.md#sql-提取与去重)。数据仍先进入 `ai_usage_report_rows`，再投影到 SQL 明细表；CodeHub 仍按已合并 MR 的 `additions` 统计。

### 旧 SQL Hook 的业务记录配置（不再计入代码产出）

以下配置仅用于保留的 Hook 业务字段统计，不是代码产出页的取数要求：

| 配置 | 要求 |
| --- | --- |
| Hook 后置行为类型 | 写入业务记录（`write_record`） |
| 记录类型 | `sql_response_metrics` |
| 记录字段 | `sqlLineCount`，值来自 SQL 统计脚本输出 |
| 报表开放字段 | 勾选 `sqlLineCount`，类型为 `number` |
| 值约束 | 非负安全整数；缺失、类型不符、不可用不按 0 计算 |

配置入口：系统管理员在 **Admin → Hook 配置**；租户管理员在 **租户管理 → Hook 配置**，只能编辑本租户拥有的配置。保存并发布 Hook，按既有绑定规则启用后，其执行写入的业务记录才能在后续夜间统计中进入看板。

内置示例是“SQL 行数记录”（`sql-line-record`），事件为 `Stop`，后置行为 `record-sql-response-metrics` 将 `script.output.sqlLineCount` 写入业务记录。只统计该脚本实际识别出的 SQL，不代表所有 AI 生成的代码。示例存在不代表已在实际租户绑定、启用或产生真实记录。

原始记录位于 `hook_data_records.data_json`。夜间按记录对应的 Hook 发布版本提取已开放字段，写入 `ai_usage_report_rows` 供 Hook 业务报表使用，不再投影到 `ai_dashboard_sql_generation_detail`。读取的是历史发布配置，而不是最新草稿。旧内置 SQL 示例未声明 `reportFields` 时有兼容白名单；新配置应显式开放字段。

多个 Hook 的记录分别在 Hook 业务报表中统计，不会再次加到会话 SQL 的生成量中。

“提交代码行数”是另一条来源：`ai_mr_submissions` 中 `status='merged'` 的 `additions`，按合并时间统计，**与 Hook 无关**。
