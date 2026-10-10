# AI 看板三张主题明细表结构（含字段注释）

> 历史版本（结构版本 2）：已由 [五张表结构与真实样本](ai-dashboard-five-tables-ddl.md) 替代。下方保留迁移前的结构和当时样本，不代表当前数据库结构。

数据库：SQLite。时间统一按 `Asia/Shanghai`（上海时区）保存。

`stat_date` 使用 `YYYY-MM-DD` 格式，对应统计起止日期筛选；`occurred_at` 使用 `YYYY-MM-DD HH:mm:ss` 格式。SQLite 使用 TEXT 存储上述日期和时间，数值指标使用 INTEGER。

数据展示读取时间：2026-09-17 17:23:16（上海时区）。样本直接读取项目 SQLite 的三张正式明细表，不是临时编造的数据；其中包含 `hook-verification` 工作区的历史验证记录，并非全部属于生产业务。

下方数据表格按“字段横向为列、每条记录占一行”展示，保留全部字段，长标识不截断。`NULL` 表示数据库中的空值，不是字符串，也不是数字 0。

## 1. AI 使用明细表

表名：`ai_dashboard_ai_detail`。交互记录与时长记录分别写行，不合并为同一条业务记录。

```sql
CREATE TABLE ai_dashboard_ai_detail (
  id TEXT NOT NULL,                  -- 明细标识，沿用原宽表的稳定 ID
  tenant_id INTEGER NOT NULL,        -- 所属租户 ID
  stat_date TEXT NOT NULL,           -- 统计归属日期，格式 YYYY-MM-DD；时长记录按切片日归属
  occurred_at TEXT,                  -- 交互发生时间或请求开始时间，格式 YYYY-MM-DD HH:mm:ss
  user_id INTEGER,                   -- 使用 AI 的用户 ID
  user_name TEXT,                    -- 用户名快照
  workspace_id INTEGER,             -- 所属工作区 ID
  workspace_name TEXT,               -- 工作区名称快照
  ai_session_id TEXT,                -- 会话标识，用于统计去重会话数
  has_ai_interaction INTEGER,        -- 有效交互标记：交互记录为 1，时长记录为 NULL
  ai_active_duration_ms INTEGER,     -- 当日 AI 活跃时长切片，单位毫秒；交互记录为 NULL
  PRIMARY KEY (tenant_id, id)        -- 联合主键，保证同租户内明细不重复
);
```

### 实际数据展示

当前表共 27 条记录。以下选取最近的 2 条交互记录及最近的 1 条时长记录，展示两类行为的字段填写方式；不是整表连续的前三条。

| `id` | `tenant_id` | `stat_date` | `occurred_at` | `user_id` | `user_name` | `workspace_id` | `workspace_name` | `ai_session_id` | `has_ai_interaction` | `ai_active_duration_ms` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| d4b0fac5f0c41e4aee892455df886e3889dd51cb3c577a0a0ebfed76bc95383b | 1 | 2026-09-16 | 2026-09-16 17:21:29 | 1 | root | 1 | hook-verification | bbd57089cc3022480e51f56eed8c6e3989dc32b20171b0226d291bf145293b6d | 1 | NULL |
| 40d04bfa53b241b34a9eb54175e479bab0e285ceefd9685a255186faf244e53d | 1 | 2026-09-16 | 2026-09-16 16:54:08 | 1 | root | 1 | hook-verification | 8a6ae4db694c0dd2aa68d2c49a23615a2d25284d4023c0bdd242e4dce7ce89f2 | 1 | NULL |
| df9b4c953544772662395298289abdc9b9b3488309bbe24e7776b0cb8c093833 | 1 | 2026-09-12 | 2026-09-12 10:09:42 | 1 | root | 1 | hook-verification | a45bb0d08e7c423966960c89f5f0a0ae069d592d3b49e8adbbcc04bedb484df5 | NULL | 453607 |

记录 3 的时长单位是毫秒，不代表 453607 秒；其交互标记为空，不能作为新的交互记录增加活跃人数。

## 2. Skill 发布和调用明细表

表名：`ai_dashboard_skill_detail`。首次发布和有效调用分别写行，调用者与发布者分开记录。

```sql
CREATE TABLE ai_dashboard_skill_detail (
  id TEXT NOT NULL,                  -- 明细标识，沿用原宽表的稳定 ID
  tenant_id INTEGER NOT NULL,        -- 所属租户 ID
  stat_date TEXT NOT NULL,           -- 统计归属日期，格式 YYYY-MM-DD
  occurred_at TEXT,                  -- 首次发布时间或调用时间，格式 YYYY-MM-DD HH:mm:ss
  user_id INTEGER,                   -- 行为用户 ID：发布记录是发布者，调用记录是调用者
  user_name TEXT,                    -- 行为用户的用户名快照
  workspace_id INTEGER,             -- 行为所属工作区 ID；来源未提供时为 NULL
  workspace_name TEXT,               -- 工作区名称快照；未知时为 NULL
  skill_id TEXT,                     -- Skill 标识
  skill_name TEXT,                   -- Skill 名称快照
  publisher_user_id INTEGER,         -- Skill 发布者的用户 ID，不是调用者 ID
  publisher_user_name TEXT,          -- Skill 发布者的用户名快照
  skill_publish_count INTEGER,      -- 首次发布记录为 1，调用记录为 NULL；重复发布不新增
  skill_call_count INTEGER,          -- 一次有效调用记录为 1，发布记录为 NULL
  PRIMARY KEY (tenant_id, id)        -- 联合主键，保证同租户内明细不重复
);
```

### 实际数据展示

当前已发布结果中 Skill 明细为 0 条，不能提供真实记录样本。以下仅展示字段列头，没有数据行，未填入虚构的 Skill 发布或调用记录。

| `id` | `tenant_id` | `stat_date` | `occurred_at` | `user_id` | `user_name` | `workspace_id` | `workspace_name` | `skill_id` | `skill_name` | `publisher_user_id` | `publisher_user_name` | `skill_publish_count` | `skill_call_count` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

这不代表项目一定没有 Skill 行为，只表示当前已发布的统计结果中没有相应明细。

## 3. 代码产出明细表

表名：`ai_dashboard_code_detail`。SQL 生成记录和 CodeHub 提交记录分别写行，不强行建立一一对应关系。

```sql
CREATE TABLE ai_dashboard_code_detail (
  id TEXT NOT NULL,                  -- 明细标识，沿用原宽表的稳定 ID
  tenant_id INTEGER NOT NULL,        -- 所属租户 ID
  stat_date TEXT NOT NULL,           -- 统计归属日期，格式 YYYY-MM-DD
  occurred_at TEXT,                  -- SQL 记录时间或 MR 合并时间，格式 YYYY-MM-DD HH:mm:ss
  user_id INTEGER,                   -- SQL 生成记录或 MR 提交记录所属的用户 ID
  user_name TEXT,                    -- 用户名快照
  workspace_id INTEGER,             -- 所属工作区 ID
  workspace_name TEXT,               -- 工作区名称快照
  sql_record_id TEXT,                -- 来源 SQL 记录标识；MR 提交记录为 NULL
  generated_sql_lines INTEGER,       -- SQL 记录中的 sqlLineCount；未知或非 SQL 记录为 NULL
  code_submission_id TEXT,           -- 来源 MR 提交记录标识；SQL 记录为 NULL
  repository_url TEXT,               -- MR 所属代码仓库地址；不适用或未知时为 NULL
  commit_sha TEXT,                   -- 来源保存的提交 SHA，仅用于追溯，不用于跨 MR 去重
  submitted_code_lines INTEGER,      -- 已合并 MR 的 additions；未知或非提交记录为 NULL
  PRIMARY KEY (tenant_id, id)        -- 联合主键，保证同租户内明细不重复
);
```

代码提交只纳入 `ai_mr_submissions.status='merged'` 的记录，提交代码行数取 `additions`。

### 实际数据展示

当前表共 9 条记录，均为 SQL 记录；CodeHub 提交明细为 0 条。以下为按统计日期、发生时间倒序读取的最近 3 条记录。

| `id` | `tenant_id` | `stat_date` | `occurred_at` | `user_id` | `user_name` | `workspace_id` | `workspace_name` | `sql_record_id` | `generated_sql_lines` | `code_submission_id` | `repository_url` | `commit_sha` | `submitted_code_lines` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1f8d1ce9c94102e2544c19f2c7e679b6ed53320d78784b42e7bc7f0503788b2d | 1 | 2026-09-03 | 2026-09-03 20:32:34 | 1 | root | 1 | hook-verification | 96c56b86-c801-4dd1-afd6-688c8f19a0fe | 31 | NULL | NULL | NULL | NULL |
| b2373c8dcc3a6273f07d332e11ae98f82a1909a2b001d1219818c76a705293dc | 1 | 2026-08-27 | 2026-08-27 19:18:00 | 1 | root | 1 | hook-verification | aa65d35d-2311-4892-ab4b-13f5a995393d | 1 | NULL | NULL | NULL | NULL |
| 6685e668891eb797d7510de64183ccfe3b367e4095955c93b20c9c008cce7f21 | 1 | 2026-08-18 | 2026-08-18 16:24:10 | 1 | root | 1 | hook-verification | a606417b-a43a-43b1-a28e-70ed3bbf078a | 1 | NULL | NULL | NULL | NULL |

上述提交相关字段为空，是因为这些行属于 SQL 生成记录，而不是表示提交了 0 行代码。

`NULL` 表示不适用或未知，不能直接当作 `0`。三张表均保留一条业务事实一行的粒度；原有宽表与看板取数方式不变。
