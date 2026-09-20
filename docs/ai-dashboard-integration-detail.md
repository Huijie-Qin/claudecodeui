# AI 看板项目内专用明细表（用于对外提供数据）

日期：2026-09-17。状态：**专用宽表及原子发布保留；看板核心指标现已切换到五张拆分表**。此前从旧表回填的宽表 36 行保持不变。服务代码需部署／重新加载后使用新查询链路；未重启现有预览或实际后端，未改变定时任务开关。

后续会话汇总改为同样从旧表派生：旧表保留原 276 条业务明细及已有指标，并补入 21 条 `session_usage` 记录和时长完成边界，目前共 297 行。本宽表的 36 行及其指标未变化，详情见 [会话汇总取数说明](ai-session-summary.md)。

**这张表仍建在我们项目自己的 SQLite 业务数据库中**，与现有业务表使用同一个 `DATABASE_PATH`；当前实例为 `/Users/da-group/.cloudcli/ccui/data/auth.db`。对接方通过经授权的接口或导出读取该表的数据，不要求对接方建库，也不把整个业务数据库开放给外部。

当前适用的建表语句见 [项目内 SQLite 专用明细表 DDL](ai-dashboard-integration-detail.sql)。此前 MySQL 版只是误按外部建表理解产生的备选稿，**不作为本项目实施方案**。本次不切换数据库引擎。

DDL 已简化为字段、必要的非空声明和联合主键，不额外配置索引或 CHECK。格式转换、数值合法性和事实去重由投影写入程序负责。

字段名调整：实际库及内部暂存表的 `detail_id` 已原地改为 `id`，36 条记录的标识值和其他字段不变，DDL 与原始样本文件同步更新。`has_ai_interaction`、`skill_publish_count` 和 `refreshed_at` 暂保留，尚未执行删除。前两个用于区分混合明细中的事实；`refreshed_at` 不参与指标计算，可在后续确认精简时仅保留批次级发布时间。

追加实现：现有宽表保留对接和中间投影职责，五张主题表已接入看板取数，分别为 AI、Skill 发布、Skill 调用、SQL 生成、代码提交（AI 按用户／工作区／会话／统计日合并），说明及 DDL 见 [拆分明细表](ai-dashboard-split-detail.md)。主题表复用同批宽表候选，不独立采集；新版夜间发布在原事务内同时更新五张拆分表。

## 看板取数分工

| 看板内容 | 指标来源 |
| --- | --- |
| 整体概览、AI 使用 | `ai_dashboard_ai_detail`（发布概览另取 Skill 发布表） |
| Skill 发布与调用 | `ai_dashboard_skill_publication_detail`、`ai_dashboard_skill_invocation_detail` |
| 生成 SQL 行数、提交代码行数 | `ai_dashboard_sql_generation_detail`、`ai_dashboard_code_submission_detail` |
| Hook 执行、记录性 Hook、Agent 模板 | `ai_usage_report_rows` |

固定分工，不设置切换开关，不在五表缺失或批次不一致时悄悄回退宽表／旧表。权限、批次状态及名称仍可读取元数据／身份表。宽表及五表的所有**指标事实**只由同批旧表候选结果投影，不能分别从原业务表重新算两份。

## 1. 表的范围与粒度

表名：`ai_dashboard_integration_detail`。仅覆盖 AI 使用、Skill 发布与调用、生成 SQL 行数、提交代码行数。不包含通用 Hook 执行、任意 Hook 字段、Agent 模板或生成／提交占比。

没有 `dataset`、`event_type`、`partition_id`；指标直接存原生数值列，不放在 `value_json` 中。外部只查询这一张表，不需要解析 JSON，也不需要关联内部各数据集。

采用稀疏事实宽表：**一条可信来源事实一行，非本行指标留 NULL**。AI 交互与 AI 请求时长独立写行；跨日时长按业务日拆成多行。不是一人一天一行的汇总表，也不强行把一次会话的全部 Skill／SQL／提交记录 JOIN 在一起。这样不会因为一场会话有多个 SQL 记录、多个 Skill 调用而把时长和行数乘倍。

| 写入的事实 | 本行填入的指标 | 必要身份与时间 | 其他指标 |
| --- | --- | --- | --- |
| 有效 AI 交互 | `has_ai_interaction=1` | 可信 `ai_session_id`；交互日与事件时间 | NULL |
| 已完成 AI 请求时长的当日切片 | `ai_active_duration_ms` | `ai_session_id`；切片所属 `stat_date` | NULL |
| Skill 确认首次发布 | `skill_publish_count=1` | `skill_id`、发布者、首次发布时间 | NULL |
| 一次有效 Skill 调用发起 | `skill_call_count=1` | `skill_id`、调用者、可信发布者、调用时间 | NULL |
| 指定 SQL Hook 的业务记录 | `generated_sql_lines` | `sql_record_id`、所属用户／工作区、记录时间 | NULL |
| 可信代码提交记录 | `submitted_code_lines` | `code_submission_id`、仓库、提交用户／工作区、业务提交时间 | NULL |

现有正式表的 AI 交互行可能已按会话和日期去重：写入专用表时可以保留这种交互证明粒度，**不得把行数称为用户消息数或请求次数**。需要消息级审计时，应另接原始可信交互来源，本对接表不承诺恢复已经聚合掉的明细。

没有对应行为就没有该行为的记录；已有 SQL／提交事实但其行数未知时，可用事实 ID 保留一行，行数字段为空。已知零行必须填写 0。不得制造一条全空“占位事实”，不得把缺失、未接入当成 0。

## 2. 字段分组

| 字段组 | 字段 | 约定 |
| --- | --- | --- |
| 公共标识与筛选 | `tenant_id`、`id`、`stat_date`、`occurred_at`、`user_id`、`user_name`、`workspace_id`、`workspace_name` | 始终按租户授权；按 ID 分组、名称展示 |
| AI 使用 | `ai_session_id`、`has_ai_interaction`、`ai_active_duration_ms` | 会话与人数去重计算，不在每种事实上重复记 1 |
| Skill | `skill_id`、`skill_name`、`publisher_user_id`、`publisher_user_name`、`skill_publish_count`、`skill_call_count` | 发布归发布者；调用行为归调用者，调用贡献按发布者计算 |
| SQL 生成 | `sql_record_id`、`generated_sql_lines` | 只取指定 SQL 行数记录，不扩大成所有生成代码 |
| 代码提交 | `code_submission_id`、`repository_url`、`commit_sha`、`submitted_code_lines` | 仅已合并 MR 的 additions，按 merged_at 归属；SHA 仅用于追溯 |
| 刷新信息 | `refreshed_at` | 完整结果的发布时间，不参与业务日期筛选 |

名称为发布结果中的快照，未知名称留空。Skill 发布事实中 `user_id` 与 `publisher_user_id` 都是发布者；调用事实中 `user_id` 是调用者，`publisher_user_id` 是被调用 Skill 的发布者，二者不能混用。当前发布来源没有工作区时，工作区 ID／名称均留空，不能从某次调用反推发布工作区。

## 3. 时间与去重

- 本专用表统一使用 **Asia/Shanghai** 时区，不继承服务器系统时区，不在同一字段内混存 UTC 与北京时间。
- `stat_date` 用 TEXT 保存 `YYYY-MM-DD`，例如 `2026-09-17`；先按上海时区确定业务日期，再执行包含起止日的筛选。
- `occurred_at`、`refreshed_at` 用 TEXT 保存 **`YYYY-MM-DD HH:mm:ss`**，与 MySQL DATETIME 常见格式一致，例如 `2026-09-17 11:56:06`。没有 `T`、`Z`、时区偏移或小数秒；接收方按 Asia/Shanghai 解读，不再自动加 8 小时。
- 来源若是 UTC，例如 `2026-09-17T03:56:06.643Z`，应转换后写为 `2026-09-17 11:56:06`，不是简单替换分隔符。无偏移的源时间必须先确认来源时区；不能直接依赖运行机器的本地时区解析。
- 时间文本保存到秒，舍弃亚秒部分，不四舍五入到下一秒。`ai_active_duration_ms` 仍保存原始毫秒时长，在格式化前用可信源时间计算，不从这两个秒精度文本字段反算。
- SQLite 没有独立的原生日期时间存储类型，因此这里使用 TEXT；MySQL 风格只是字符串格式，不改变数据库引擎。日期格式校验由写入程序负责，行数、次数、时长仍以 INTEGER 参与统计。
- 来源统计结果若使用非上海时区，不可仅改时间文本而沿用其跨日时长或日期汇总；必须按本表上海时区重新切日后写入。现有业务源表和内部报表时间不在本次文档调整中批量改写。
- AI 时长切片：`stat_date` 是切片日，`occurred_at` 是原请求开始时刻。因此跨日第二片的业务日可能与请求开始日不同；按 `stat_date` 查询，不用 `DATE(occurred_at)` 替代。
- 会话 ID 由可信逻辑身份标准化后计算 SHA-256；包括原有提供方隔离维度。旧 Hook 会话字段未必包含提供方，缺少可信关联时不要猜测填入 AI 会话 ID。
- `id` 必须确定性生成：对规范化的“来源命名空间、原始事实身份、必要的日期切片”计算 SHA-256。它不是每次随机生成的批次 ID。来源命名空间仅用于防止主键碰撞，不新增数据集类型列。
- 原字段名 `detail_id` 已改为 `id`；只原地改列名，不重新生成标识、修改指标或更改联合主键的含义。迁移同时覆盖内部暂存表，拒绝在存活统计 Worker 期间改名；只读查询兼容尚未重新创建的预览内存库旧列名，不切换事实数据源。
- 同租户同一 Skill 只写一次确认首次发布；一次有效调用按现有去重结果写一次；SQL 记录按原始记录 ID 去重，内容相同但 ID 不同不擅自合并。
- 原始 ID 大小写按身份语义保持；表默认二进制排序规则防止不同身份被大小写不敏感匹配合并。

## 4. 指标查询

所有查询必须限定授权租户，以下 `?` 为由调用方绑定的参数。SUM 自动忽略 NULL；没有任何已知数值时保留 NULL，不默认伪装成 0。只有数据覆盖已确认完整且确实没有相应事实时，展示层才能按约定显示 0。覆盖情况在对接任务状态中单独说明，不通过伪造明细表示。

### AI 使用：按用户统计

```sql
SELECT user_id,
       COUNT(DISTINCT CASE WHEN has_ai_interaction = 1 THEN ai_session_id END) AS session_count,
       SUM(ai_active_duration_ms) AS ai_active_duration_ms
FROM ai_dashboard_integration_detail
WHERE tenant_id = ? AND stat_date BETWEEN ? AND ?
  AND (has_ai_interaction = 1 OR ai_active_duration_ms IS NOT NULL)
GROUP BY user_id;
```

活跃使用人数：`COUNT(DISTINCT CASE WHEN has_ai_interaction=1 THEN user_id END)`。DAU 在指定单日计算，MAU 在截止日及前 29 天计算。不能用整表所有行为用户当作 AI 活跃用户，也不能相加每日去重人数或每日会话数得到期间去重合计。按用户展示时不重复显示 0／1 的人数列。

### Skill 发布与调用：按发布者和 Skill 统计

```sql
SELECT publisher_user_id, skill_id,
       SUM(skill_publish_count) AS published_skill_count,
       SUM(skill_call_count) AS skill_call_count,
       COUNT(DISTINCT CASE WHEN skill_call_count=1 THEN user_id END) AS caller_count
FROM ai_dashboard_integration_detail
WHERE tenant_id = ? AND stat_date BETWEEN ? AND ?
  AND (skill_publish_count=1 OR skill_call_count=1)
GROUP BY publisher_user_id, skill_id;
```

该查询返回期间有事实的 Skill；若需保留期间零调用的历史已发布 Skill，应从同表 `skill_publish_count=1 AND stat_date<=截止日` 取 Skill 目录，再关联**已经按 Skill 聚合的**期间调用结果，不能把原始发布行与多条调用行 JOIN 后再累计发布数。首次发布时间从发布事实的 `occurred_at` 读取。累计发布数查询截至日的发布事实，不附加近 30 天开始限制。

### SQL 生成与代码提交：按用户统计

```sql
SELECT user_id,
       SUM(generated_sql_lines) AS generated_sql_lines,
       SUM(submitted_code_lines) AS submitted_code_lines
FROM ai_dashboard_integration_detail
WHERE tenant_id = ? AND stat_date BETWEEN ? AND ?
  AND (sql_record_id IS NOT NULL OR code_submission_id IS NOT NULL)
GROUP BY user_id;
```

这两个数字不能相加成“生成代码总数”。CodeHub 提交都视为 AI 生成只是已约定的业务归因假设，不证明其与某次 SQL 生成一一对应；不计算占比。

## 5. 数据来源与确定口径

| 输出 | 当前可用来源 | 写入条件／限制 |
| --- | --- | --- |
| AI 交互 | 旧表 `interactions` | 可信逻辑会话去重；不按行数当消息数 |
| AI 时长 | 旧表 `turns` | 只取 completed 的非负整数 durationMs；不从格式化后的时间反算 |
| Skill 发布 | 旧表 `skill_publications` | 同 Skill 保留最早确认发布；缺少证据不推断 |
| Skill 调用 | 旧表 `skill_invocations` | 发布者与调用者分开；沿用旧表去重结果 |
| SQL 行数 | 旧表 `hook_records` 的安全字段 | `recordType='sql_response_metrics'` 且字段键为 `sqlLineCount`、type 为 number、值为非负安全整数。按记录类型契约识别，不硬编码当前机器的 Hook ID，不按显示名猜测 |
| 提交代码行数 | `ai_mr_submissions` → 旧表 `code_submissions` → 新表 | 仅 `status='merged'`，取 `additions`，按 `merged_at` 转上海日期；同提交记录 ID 一次 |

CodeHub 口径已由用户确认：使用主表的 additions（用户称 add），只统计 merged。

- MR 主表可能保存多个 commit 的累计 additions；SHA 可能只是头 SHA。不同 MR 即使 SHA 相同仍是不同记录，不承诺消除跨 MR 的重叠 commit。
- 未合并、失败、关闭等状态不计入。缺少有效 merged_at 不用 created_at 代替。
- 已合并记录存在缺失／非法合并时间或 additions 时，来源覆盖标为 partial；未知行数保留 NULL，不用 0 掩盖缺失。
- 主表和逐文件表不能重复相加；不计 deletions，也不使用 additions−deletions。
- 创建／修改／删除只加入变更队列；下一批先重算旧表受影响日期，再投影新表。没有新增变化也会在跨日后纳入此前尚未到统计截止日的记录。
- 当前实际库的 `ai_mr_submissions` 为 0 行。此次回填来源是旧批次，因此 submittedCode 覆盖暂为 unavailable，未伪造 0 或模拟提交；新版闲时任务完成采集后才宣告其覆盖情况。

## 6. 发布与对接约定

延续已确认的“先刷好，再进入正式明细”：先计算并校验完整候选结果，成功后在同一事务内替换相应租户正式数据。对接方只读本表；不新增结果版本分区列。候选结果可在内部暂存区处理，不要求对接方访问第二张明细表。

具体流程：旧表候选 `ai_usage_report_staging` 全部算完 → 生成新表候选 `ai_dashboard_integration_staging` → 生成五张拆分表候选 → 一个 SQLite 事务替换两张原有正式表及五张拆分表、更新批次及成功时间。投影中途失败可断点续跑；发布任一步失败，七张表和批次一起回滚。正式明细都不存历史结果版本分区。

AI 的 DAU／MAU 从新表交互证明重新按用户去重，不能把其他行为用户算进来。新表缺少 provider 列，因此新表查询明确拒绝已经从页面移除的模型来源筛选／分组，不悄悄忽略。旧 Hook 和 Agent 查询保持原有字段能力。

一次多查询读取用一致性只读事务，分页导出固定批次，刷新后拒绝混合批次。当前为完整快照替换，不承诺仅凭 `refreshed_at` 实现删除增量同步。新增 `GET /api/ai-usage/code`、`/code-records` 沿用现有租户鉴权；未增加外部公开接口或第三方授权。

迁移工具：`scripts/migrate-ai-dashboard-integration.mjs /绝对路径/auth.db` 默认只读检查，加 `--apply` 才备份并回填；拒绝存活 Worker 租约，校验旧正式行及当前批次不变。实际迁移已校验旧 276 行不变，新 36 行中的 SQL 行数合计 41，数据库 integrity_check=ok。回填不代表这 36 行都是新发生的业务，里面保留原批次的历史测试记录。

部署后第一次闲时任务会按新 calculationVersion 重新采集，包括已有 MR。不得让旧 Worker 与新版查询长期混跑；部署后需重新加载实际后端，当前未为此停止或重启任何已有服务。

对外不要提供原始对话、Hook 全文、凭据或完整 `auth.db`。租户权限在服务端／数据库授权中落实，不能仅依赖前端传入 `tenant_id`。

## 7. 本次验证与尚未执行的步骤

- 服务回归：158 项通过；HTTP 与租户角色测试：9 项通过；前端已有测试：60 项通过。客户端构建、前后端类型检查通过。
- 新增专项覆盖：SQL 数值／上海时间格式、发布者与调用者隔离、新旧查询分工、分页合计、NULL、MR 合并状态与跨日、50→40 更正、删除、重复运行、暂停恢复、双表发布失败回滚。
- 独立无头 Chrome 验证了真实 `CodeReport` 组件：桌面和窄屏渲染、提交弹窗、名称筛选、重置、图表图例、固定概览不随筛选改变，以及 20 行分页下导出全部 40 个分组。数据库和 API 均为本机隔离样本；测试只移除了 fixture 响应头对旧模拟组件的选择，未伪造响应数据。样本 SQL=13,800，已合并 MR=50+40=90，opened 的 9,999 不计。
- 本机 Node 24 / better-sqlite3 的独立 Worker 冒烟测试仍遇到原生清理钩子断言 `node::RemoveEnvironmentCleanupHook (env != nullptr)`，**未判定通过**。服务测试使用仅测试进程的语句保留预加载规避该环境异常，没有往生产代码注入该规避逻辑。上线前仍需在实际部署 Node／原生依赖环境复验 Worker。
- 当前只完成源码实现和项目数据库回填，没有重启实际后端、强行在白天跑业务采集或修改统计开关。后端重新加载和下一次新版闲时批次属于后续上线步骤；原 4401 预览保持运行。
