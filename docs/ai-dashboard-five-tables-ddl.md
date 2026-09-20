# AI 看板五张明细表结构（字段注释与真实样本）

更新：2026-09-17（上海时区）。此五表方案替代此前的三张主题表，现已接入看板查询。原有宽表、旧报表和对接会话表保留；Hook／Agent 仍走旧报表，详见 [取数分工](ai-dashboard-split-detail.md#3-看板和对接查询)。

数据库：SQLite。日期为 `YYYY-MM-DD`，时间为上海时区 `YYYY-MM-DD HH:mm:ss`，在 SQLite 中保存为 TEXT；计数使用 INTEGER，AI 时长使用 REAL，以秒保存并保留原毫秒精度（最多三位小数）。正式明细不含 `dataset`、`event_type`、`partition_id`、`batch_id` 或逐行发布时间。

下列样本直接读取项目 SQLite 的五张正式明细表，包含 `hook-verification` 工作区的历史验证数据，并非全部为生产业务。表格横向为字段，每条记录占一行；完整标识不截断，`NULL` 为空值，不等于 0。没有记录的表只展示列头，不编造数据。

## 1. AI 交互与时长明细表

表名：`ai_dashboard_ai_detail`。同一租户、用户、工作区、会话、统计日合并为一行。当日交互标记取是否存在交互；时长只累加已完成且有可靠时长的记录。跨日续算的当天若无新交互，标记为 0。

```sql
CREATE TABLE ai_dashboard_ai_detail (
  id TEXT NOT NULL, -- 由租户、用户、工作区、会话、统计日生成的稳定分组 ID
  tenant_id INTEGER NOT NULL, -- 所属租户 ID
  stat_date TEXT NOT NULL, -- 统计归属日期，格式 YYYY-MM-DD；筛选起止日期使用此字段
  occurred_at TEXT, -- 当天最早交互时间；仅有时长时为最早原请求开始时间，可早于统计日
  user_id INTEGER, -- 使用 AI 的用户 ID
  user_name TEXT, -- 行为用户的用户名快照
  workspace_id INTEGER, -- 所属工作区 ID；未知时为 NULL
  workspace_name TEXT, -- 工作区名称快照；未知时为 NULL
  ai_session_id TEXT, -- 会话标识；会话数按此字段去重
  has_ai_interaction INTEGER, -- 当日有交互：1 表示有，0 表示仅有跨日等时长记录
  ai_active_duration_seconds REAL, -- 当日已知的已完成请求时长之和，单位秒，保留三位小数精度；未知为 NULL
  PRIMARY KEY (tenant_id, id) -- 同租户内唯一，不混用不同租户的数据
);
```

### 实际数据展示

当前共 24 条。以下展示 3 条真实记录（最近两条及最近一条有已知时长的记录）。

| `id` | `tenant_id` | `stat_date` | `occurred_at` | `user_id` | `user_name` | `workspace_id` | `workspace_name` | `ai_session_id` | `has_ai_interaction` | `ai_active_duration_seconds` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| f3975a54c9c88b1d5007647b953865198144a825b0066de5812e62e050e5f258 | 1 | 2026-09-16 | 2026-09-16 17:21:29 | 1 | root | 1 | hook-verification | bbd57089cc3022480e51f56eed8c6e3989dc32b20171b0226d291bf145293b6d | 1 | NULL |
| 3c75da643e0de93675c99f7140e9614ad671e4398e1c2631c4c576b040dc7eb7 | 1 | 2026-09-16 | 2026-09-16 16:54:08 | 1 | root | 1 | hook-verification | 8a6ae4db694c0dd2aa68d2c49a23615a2d25284d4023c0bdd242e4dce7ce89f2 | 1 | NULL |
| 63d82c931d6d17d5c0da2d69f467baf76c9c9e71e79cc59297a81333b613b698 | 1 | 2026-09-12 | 2026-09-12 10:09:42 | 1 | root | 1 | hook-verification | a45bb0d08e7c423966960c89f5f0a0ae069d592d3b49e8adbbcc04bedb484df5 | 1 | 453.607 |

## 2. Skill 发布明细表

表名：`ai_dashboard_skill_publication_detail`。一个确认首次发布的 Skill 一行，重复发布不新增；直接 COUNT(*) 统计发布数量，无需首次发布标记。发布用户通过 publisher_user_id 展示。

```sql
CREATE TABLE ai_dashboard_skill_publication_detail (
  id TEXT NOT NULL, -- 明细唯一标识，沿用原宽表稳定 ID
  tenant_id INTEGER NOT NULL, -- 所属租户 ID
  stat_date TEXT NOT NULL, -- 统计归属日期，格式 YYYY-MM-DD；筛选起止日期使用此字段
  occurred_at TEXT, -- 首次发布时间，上海时区 YYYY-MM-DD HH:mm:ss
  workspace_id INTEGER, -- 所属工作区 ID；未知时为 NULL
  workspace_name TEXT, -- 工作区名称快照；未知时为 NULL
  skill_id TEXT, -- Skill 标识
  skill_name TEXT, -- Skill 名称快照
  publisher_user_id INTEGER, -- Skill 发布者的用户 ID
  publisher_user_name TEXT, -- Skill 发布者的用户名快照
  PRIMARY KEY (tenant_id, id) -- 同租户内唯一，不混用不同租户的数据
);
```

### 实际数据展示

当前共 0 条。当前已发布结果没有对应记录，不代表业务源中一定不存在此类行为。

| `id` | `tenant_id` | `stat_date` | `occurred_at` | `workspace_id` | `workspace_name` | `skill_id` | `skill_name` | `publisher_user_id` | `publisher_user_name` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 3. Skill 调用明细表

表名：`ai_dashboard_skill_invocation_detail`。一次去重后的有效调用一行，直接 COUNT(*) 统计调用次数，无需调用标记。user_id 是调用者，publisher_user_id 是发布者。

```sql
CREATE TABLE ai_dashboard_skill_invocation_detail (
  id TEXT NOT NULL, -- 明细唯一标识，沿用原宽表稳定 ID
  tenant_id INTEGER NOT NULL, -- 所属租户 ID
  stat_date TEXT NOT NULL, -- 统计归属日期，格式 YYYY-MM-DD；筛选起止日期使用此字段
  occurred_at TEXT, -- 调用发生时间，上海时区 YYYY-MM-DD HH:mm:ss
  user_id INTEGER, -- 实际调用者的用户 ID；不是发布者 ID
  user_name TEXT, -- 行为用户的用户名快照
  workspace_id INTEGER, -- 所属工作区 ID；未知时为 NULL
  workspace_name TEXT, -- 工作区名称快照；未知时为 NULL
  skill_id TEXT, -- Skill 标识
  skill_name TEXT, -- Skill 名称快照
  publisher_user_id INTEGER, -- Skill 发布者的用户 ID
  publisher_user_name TEXT, -- Skill 发布者的用户名快照
  PRIMARY KEY (tenant_id, id) -- 同租户内唯一，不混用不同租户的数据
);
```

### 实际数据展示

当前共 0 条。当前已发布结果没有对应记录，不代表业务源中一定不存在此类行为。

| `id` | `tenant_id` | `stat_date` | `occurred_at` | `user_id` | `user_name` | `workspace_id` | `workspace_name` | `skill_id` | `skill_name` | `publisher_user_id` | `publisher_user_name` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 4. SQL 生成明细表

表名：`ai_dashboard_sql_generation_detail`。一条 SQL 业务记录一行，仅统计 sql_response_metrics 中的 sqlLineCount，不推断其他代码产出。

```sql
CREATE TABLE ai_dashboard_sql_generation_detail (
  id TEXT NOT NULL, -- 明细唯一标识，沿用原宽表稳定 ID
  tenant_id INTEGER NOT NULL, -- 所属租户 ID
  stat_date TEXT NOT NULL, -- 统计归属日期，格式 YYYY-MM-DD；筛选起止日期使用此字段
  occurred_at TEXT, -- SQL 记录时间，上海时区 YYYY-MM-DD HH:mm:ss
  user_id INTEGER, -- SQL 生成记录所属用户 ID
  user_name TEXT, -- 行为用户的用户名快照
  workspace_id INTEGER, -- 所属工作区 ID；未知时为 NULL
  workspace_name TEXT, -- 工作区名称快照；未知时为 NULL
  sql_record_id TEXT, -- 原 SQL 记录标识
  generated_sql_lines INTEGER, -- SQL 记录的 sqlLineCount 数值；未知为 NULL
  PRIMARY KEY (tenant_id, id) -- 同租户内唯一，不混用不同租户的数据
);
```

### 实际数据展示

当前共 9 条。以下展示 3 条真实记录（按统计日期、发生时间倒序）。

| `id` | `tenant_id` | `stat_date` | `occurred_at` | `user_id` | `user_name` | `workspace_id` | `workspace_name` | `sql_record_id` | `generated_sql_lines` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1f8d1ce9c94102e2544c19f2c7e679b6ed53320d78784b42e7bc7f0503788b2d | 1 | 2026-09-03 | 2026-09-03 20:32:34 | 1 | root | 1 | hook-verification | 96c56b86-c801-4dd1-afd6-688c8f19a0fe | 31 |
| b2373c8dcc3a6273f07d332e11ae98f82a1909a2b001d1219818c76a705293dc | 1 | 2026-08-27 | 2026-08-27 19:18:00 | 1 | root | 1 | hook-verification | aa65d35d-2311-4892-ab4b-13f5a995393d | 1 |
| 6685e668891eb797d7510de64183ccfe3b367e4095955c93b20c9c008cce7f21 | 1 | 2026-08-18 | 2026-08-18 16:24:10 | 1 | root | 1 | hook-verification | a606417b-a43a-43b1-a28e-70ed3bbf078a | 1 |

## 5. 代码提交明细表

表名：`ai_dashboard_code_submission_detail`。一条已合并的 CodeHub MR 记录一行。只纳入 ai_mr_submissions.status='merged'，提交行数取 additions；不计算提交／生成占比。

```sql
CREATE TABLE ai_dashboard_code_submission_detail (
  id TEXT NOT NULL, -- 明细唯一标识，沿用原宽表稳定 ID
  tenant_id INTEGER NOT NULL, -- 所属租户 ID
  stat_date TEXT NOT NULL, -- 统计归属日期，格式 YYYY-MM-DD；筛选起止日期使用此字段
  occurred_at TEXT, -- MR 合并时间，上海时区 YYYY-MM-DD HH:mm:ss
  user_id INTEGER, -- MR 提交记录所属用户 ID
  user_name TEXT, -- 行为用户的用户名快照
  workspace_id INTEGER, -- 所属工作区 ID；未知时为 NULL
  workspace_name TEXT, -- 工作区名称快照；未知时为 NULL
  code_submission_id TEXT, -- 原 CodeHub MR 提交记录标识
  repository_url TEXT, -- 代码仓库地址；未知时为 NULL
  commit_sha TEXT, -- 来源保存的提交 SHA；仅追溯，不按 SHA 跨 MR 去重
  submitted_code_lines INTEGER, -- status=merged 的 MR 的 additions；未知为 NULL
  PRIMARY KEY (tenant_id, id) -- 同租户内唯一，不混用不同租户的数据
);
```

### 实际数据展示

当前共 0 条。当前已发布结果没有对应记录，不代表业务源中一定不存在此类行为。

| `id` | `tenant_id` | `stat_date` | `occurred_at` | `user_id` | `user_name` | `workspace_id` | `workspace_name` | `code_submission_id` | `repository_url` | `commit_sha` | `submitted_code_lines` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

单位调整只针对 AI 明细及其暂存表：字段由 `ai_active_duration_ms` 改为 `ai_active_duration_seconds`，值除以 1000。原宽表仍保留毫秒；看板已读取拆分表，由查询层转换为原接口的毫秒字段，显示口径不变。日期和时间戳格式不变。

## 统计与更新约定

- AI 会话次数：筛选 `has_ai_interaction=1` 后按 `ai_session_id` 去重，不是直接数 AI 表行数。DAU／MAU 同样只统计有交互的用户，跨日期整体去重。
- AI 时长：`SUM(ai_active_duration_seconds)`，不把 NULL 当作已确认的 0；如果只有部分请求具备可靠时长，这里仍是已知时长合计，需结合原批次覆盖状态解读。
- Skill 发布、调用分别在对应表中计数；被调用次数归属发布者时按 `publisher_user_id` 分组，调用人数按 `user_id` 去重。
- SQL 与提交行数分别求和，不相加，不推断一一对应关系。
- 所有查询必须限定授权的 `tenant_id`，日期筛选使用 `stat_date`。名称不是分组唯一键。
- 五表从同批原宽表候选生成，准备完成后与旧表、宽表在同一个事务中发布。看板 AI／Skill／SQL／提交及整体概览已从五表取数；Hook／Agent 仍查旧表，宽表继续保留对接和投影用途。
- AI 明细 ID 因粒度合并而重新生成，其他四表 ID 保持不变。AI 当天只有交互且尚无可靠时长时，时长为 NULL；有可靠的零时长时保留 0。

完整更新流程见 [拆分实现说明](ai-dashboard-split-detail.md)，纯建表语句见 [SQLite DDL](ai-dashboard-split-detail.sql)。
