# 会话汇总表

表名：`ai_session_summary`。位于项目现有 SQLite 数据库 `auth.db`，独立于 AI 看板的五张内部明细表；本表不参与看板指标计算。看板现使用五张主题表＋旧明细分工取数，见 [看板取数说明](ai-dashboard-split-detail.md#3-看板和对接查询)。

一个完整会话一行，不按自然日拆分。内部按 **租户 + 工作区 + 用户 + 模型提供方 + 原始 session_id** 区分会话，防止不同范围的同名会话被合并。

## 唯一取数来源与一致性约束

**会话汇总表只从最初的明细表 `ai_usage_report_rows` 生成。**

生成顺序：原始业务记录／日志 → `ai_usage_report_rows` → `ai_session_summary`。

夜间生成时读取的是原明细表的**同一批暂存结果** `ai_usage_report_staging`，不是上一批正式数据。原明细和会话汇总准备完成后，在同一个事务中发布，避免批次错位。手工重新投影则只读已经发布的 `ai_usage_report_rows`。

会话汇总阶段不再读取 `ai_usage_fact_rows`、原始日志、消息表、用户表或五张拆分表；不在原表数据缺失时悄悄回退原始来源。用户名也使用原表内本批保存的名称。

### 原明细表补充的信息

原表 DDL 不变，仍通过原有 `dataset` 和 `value_json` 保存不同类型记录：

- 新增 `dataset='session_usage'`：每个完整会话一条，保存截至本批截止点的 `totalTokens`、日志确认的 `responseCompletedAt`、`userName`、会话身份、删除状态和截止点 `through`。这是原表里的一类记录，**不是新建另一张来源表**。
- 原有 `turns.value_json` 补充 `durationByCompletion`：按原始响应完成时间保存对应的本日切片毫秒数，保留已完成请求的结束边界。原有 `durationMs`、次数等指标不变。
- `session_usage` 是每会话唯一的生命周期快照，不是“当日 Token”；它的 `stat_date` 沿用首次交互所在日，不应据此计算每天 Token 消耗，也不能把不同历史快照相加。正式表只保留当前快照。

| 会话汇总字段 | 在 ai_usage_report_rows 中的依据 |
| --- | --- |
| id、session_id、provider、user_id、tenant_id、workspace_id | 原表行身份与完整 `session_key`；使用租户／工作区／用户／提供方／原始会话 ID，确定性生成 id。 |
| user_name | `session_usage.value_json.userName`。用户表读取发生在原明细生成阶段，汇总阶段不重新关联。 |
| total_tokens | `session_usage.value_json.totalTokens`，直接使用已去重、包含缓存且不重复计数的结果。 |
| skill_list | 同一会话的 `skill_invocations.value_json.skillName`，按实际调用会话归集，去重、排序。 |
| start_time | `interactions.value_json.firstInteractionAt` 的最早值；旧交互记录无此值时使用该原表行的 `occurred_at`。 |
| end_time | `turns.durationByCompletion` 中有效的完成时间与 `session_usage.responseCompletedAt`，取本批截止点前的最近时间。 |
| ai_active_duration_seconds | 累加 `turns.durationByCompletion` 中本批截止点前已完成请求的切片毫秒数，再除以 1000。同一请求跨日切片相加，轮间空闲不计入。 |

`durationByCompletion` 示例：`{"2026-09-10T02:01:00.123Z":60123}`。JSON 内时间保留内部原始 UTC 精度，输出会话表时统一转上海时间。跨日请求如果在截止点之后才完成，本批会话时长不提前计入；下一批完成后才把各日切片一起累计。

一致性规则：

- 原明细生成阶段继续复用统一采集、去重和有效调用规则；Token 和响应结束信息先写入原表候选，再生成会话汇总。
- 原始会话归属检查放在原明细生成／发布边界；会话汇总只校验原表中的身份和字段是否自洽。Skill 按实际调用者核对，不把发布者误作会话用户。
- 原表更正、完整刷新后，会话汇总替换旧结果；不会累加旧汇总值。仅修改原始日志或业务表，尚未进入新一批原明细时，不会直接改变会话汇总。
- 遇到缺少会话用量记录、旧格式时长记录或截止点不一致时，拒绝发布，不从原始日志临时补算，也不将缺失伪装为零。
- 原表和会话汇总在同一事务中更新，失败一起回滚。已有表结构、租户 ID、工作区 ID 保留。

这里的一致性是**同批原明细、同一截止点、同一口径的一致性**，不是实时同步，也不代表缺失的历史逐轮记录已经补齐。

2026-09-17 已在真实库完成补充：保留原 276 条明细及其已有指标，7 条 turns 记录补充完成时间信息，新增 21 条 session_usage 记录，原表共 297 行。由原表重新生成的 21 条会话汇总与此前结果逐字段一致；六张宽表／拆分表以及原批次状态均未改变。

## 表结构（SQLite DDL）

```sql
CREATE TABLE IF NOT EXISTS ai_session_summary (
  id TEXT NOT NULL,                -- 行唯一标识：完整会话身份的稳定 SHA-256，刷新后不变
  tenant_id INTEGER NOT NULL,      -- 租户 ID，用于租户隔离
  workspace_id INTEGER NOT NULL,   -- 工作区 ID，用于区分所属工作区
  user_id INTEGER NOT NULL,        -- 会话所属用户 ID，用户名修改不改变归属
  provider TEXT NOT NULL,          -- 模型提供方，例如 claude、codex
  session_id TEXT NOT NULL,        -- 原始会话 ID，不是看板中计算出的哈希会话 ID
  user_name TEXT,                  -- 用户名，取原明细本批快照；上游来源为 users.username，未知为空
  total_tokens INTEGER,           -- 累计 Token 消耗，包含缓存且不重复计算；无法可靠计算时为 NULL
  skill_list TEXT NOT NULL,       -- 已识别的有效 Skill 调用名称，去重、排序后的 JSON 字符串数组
  start_time TEXT NOT NULL,        -- 首次有效用户交互时间，Asia/Shanghai，YYYY-MM-DD HH:mm:ss
  end_time TEXT,                   -- 最近一次已确认响应结束时间，同格式；尚无可确认结束时间时为 NULL
  ai_active_duration_seconds REAL, -- 实际使用时长（秒）：有效已完成轮次逐轮累加，排除轮间空闲，保留毫秒精度
  PRIMARY KEY (tenant_id, id)       -- 防止同一会话重复落表
);
```

对接方主要读取 `session_id、user_name、total_tokens、skill_list、start_time、end_time、ai_active_duration_seconds`。其余字段用于稳定定位及范围隔离；查询时必须限定授权的 `tenant_id`。

SQLite 没有独立的原生 DATETIME 存储类型，因此继续采用此前约定的 TEXT 时间存储，内容统一为上海时区、MySQL 常见时间格式。Token 是整数；实际使用时长是以秒为单位的数值，例如 `453.607` 秒。

`start_time`、`end_time` 只表示整个会话的时间范围，**不能用两者相减计算实际使用时长**。

## “缺少可靠的逐轮记录”是什么意思

不是没有聊天记录，而是没有完整记录每一轮请求对应的开始时间和响应完成时间。计算一轮时长，需要能通过同一个请求标识，把这两个时间准确配对。

以下仅为说明用的例子：

| 轮次 | 请求开始 | 响应完成 | 能否计算 |
| --- | --- | --- | --- |
| 第一轮 | 10:00:00 | 10:01:00 | 可以，60 秒 |
| 第二轮 | 10:20:00 | 未记录 | 不可以，不能猜测 |

当前历史数据中，有些会话没有逐轮采集记录；有些请求仍标记为未完成或失败，没有对应的响应完成时间。即使日志能够提供整个会话的首尾时间，也不能拿来补算，否则会把空闲时间包含进去。这属于逐轮采集数据不完整，不表示用户没有实际使用。

在下方 2026-09-17 的数据快照中：

- **18 条时长为 `NULL`**：没有可用于计算的已完成轮次，不代表使用时长为零。
- **3 条时长有数值**：是已确认完成轮次的累计时长；未采集到的历史轮次仍可能缺失，不能保证是完整总时长。

要获得完整时长，需要确保每轮请求开始、响应完成都被准确采集并关联。已经缺失的历史边界不能仅凭会话首尾时间可靠还原。

## 统计口径

| 字段 | 口径 |
| --- | --- |
| start_time | 已索引、未超过本次刷新截止时间的有效用户交互中，取最早时间。不用会话文件创建时间或消息导入时间。 |
| end_time | 取最新已确认响应结束时间。使用请求完成事实及 Claude 主会话明确的 `end_turn` / `stop_sequence`；工具调用中间消息、子 Agent 结束时间不作为主会话结束。不是“会话已关闭”的标记。 |
| ai_active_duration_seconds | 上游按原始请求边界去重、切日，并在原明细 turns 中保存完成时间与切片时长。会话汇总只累加截止点前已完成请求的切片毫秒数并除以 1000，不再次读取原始请求或用会话跨度计算。 |
| total_tokens | 整个会话已采集到的模型请求累计消耗，包含已归属该会话的子 Agent 日志。Claude：输入 + 输出 + 缓存读取 + 缓存写入；缓存细分项不再叠加。Codex：使用最新累计 Token 快照，缓存读取已包含在输入中，不额外相加；不能把多次累计快照相加。 |
| Token 去重 | Claude 按模型响应 `message.id` 去重，不按日志行 UUID。流式片段使用最新完整用量；原始日志优先，不能再叠加数据库中的副本或 SDK 整轮汇总。 |
| skill_list | 沿用项目现有 `skill_invocations` 的有效调用口径，按调用所属会话归集，再按 Skill 名称去重。同一 Skill 调用多次仍只出现一次；不会把正文提到的 Skill 当成调用，也不按发布者归属这个列表。 |
| 空值 | Token 无可用用量或已知来源读取不完整时为 `NULL`；只有来源明确报告零才写 `0`。没有任何可确认已完成轮次时，时长为 `NULL`；有有效完成轮次时累加这些轮次，尚未完成、失败或缺少起止边界的轮次不计入，不能将结果当成缺失历史的完整总时长。`[]` 表示当前已索引范围内未识别到符合口径的 Skill 调用，并非证明未采集历史从未调用过 Skill。 |

`skill_list` 格式示例：`["sql-helper","review"]`（仅用于说明格式，不是下方的实际样本）。

时长例子：10:00～10:01、10:20～10:22 两轮，会话跨度为 22 分钟，实际使用时长为 `180` 秒。这里衡量请求到响应的经过时间，包含该轮内部模型、工具等待时间，不是 CPU 执行时间。

### 刷新和数据来源

- 会话汇总唯一指标来源为 `ai_usage_report_rows`；夜间使用该表同批暂存结果。上表列出了每个输出字段的对应关系。
- 原明细补充 Token 时，才读取已由可信索引器关联到对应会话的原始日志；只读取已索引完整字节范围，不扫描无关个人历史。无原始日志时，只识别消息中具有可靠响应身份／累计语义的用量。
- 当前真实数据验证为 Claude。Codex 累计格式有单元测试覆盖，但原索引器未自动发现 Codex 原始历史文件；未接通的用量保持 `NULL`。
- 原明细、宽表、五张拆分表、会话汇总的候选全部准备完成后，在原有发布事务内一起替换。内部暂存表不供对接方查询。
- 范围仍是会话全生命周期截至本批截止点，不是近 30 天；会话后续继续使用，下一批更新同一行。
- 上游会话用量补充阶段仍顺序扫描已绑定日志，尚无 Token 字节级增量缓存；下游会话汇总只遍历原表，不再次扫描日志。
- 本次计算版本已升级，旧的未完成任务将重建候选，不能复用尚未补齐字段的旧候选直接发布。

## 实际数据库样本

2026-09-17 从本机项目 `auth.db` 刷新并查询。截止时间为 **2026-09-17 00:00:00（上海，左闭右开截止边界）**，即包含此前已采集历史。共 21 行，全部属于租户 1；租户 2 暂无会话行。数据来自现有数据库和已索引日志，包含此前开发、验证会话，不应视为纯生产业务数据。

下面展示主要对接字段；三行的 `tenant_id=1、workspace_id=1、user_id=1、provider=claude`。当前 21 行均未识别到符合现有统计口径的 Skill 调用，因此列表如实为空。

| session_id | user_name | total_tokens | skill_list | start_time | end_time | ai_active_duration_seconds |
| --- | --- | ---: | --- | --- | --- | ---: |
| 4a38601e-7fbe-4a10-a04d-c0f1e0ac430b | root | 80005 | [] | 2026-09-16 17:21:29 | 2026-09-16 17:23:37 | NULL |
| ce4db39e-275d-4414-bf4f-f569a4b9d909 | root | 726078 | [] | 2026-09-12 10:09:42 | 2026-09-16 16:28:34 | 453.607 |
| ce24236c-a0e4-44b1-9644-46e712c23e7a | root | 85747 | [] | 2026-09-12 09:56:10 | 2026-09-12 09:57:08 | 58.114 |

第二行跨多天，仍然只有一行，已确认完成轮次累计为 `453.607` 秒，不含中间数日空闲。当前 21 个会话中，3 个可计算已完成轮次时长（合计 `547.032` 秒），其余 18 个缺少可用的逐轮完成记录，时长为 `NULL`，不是 `0`。第一行虽能从日志看到响应结束时间，但请求事实仍为未完成，未用整个会话跨度补算。表中另有 1 个会话未能确认响应结束时间，`end_time` 为 `NULL`。

查询示例（绑定参数须使用调用方实际授权的租户）：

```sql
SELECT session_id, user_name, total_tokens, skill_list, start_time, end_time,
       ai_active_duration_seconds
FROM ai_session_summary
WHERE tenant_id = ?
ORDER BY start_time DESC;
```

## 运维与验证

重新生成会话投影（只读原明细表；默认只读试算，`--apply` 备份后写会话表）：

```sh
node scripts/refresh-ai-session-summary.mjs /absolute/path/auth.db
node scripts/refresh-ai-session-summary.mjs /absolute/path/auth.db --apply
```

旧库补充原明细来源信息（仅升级时使用）：

```sh
node scripts/migrate-ai-session-report-source.mjs /absolute/path/auth.db
node scripts/migrate-ai-session-report-source.mjs /absolute/path/auth.db --apply
```

升级工具先在私有内存副本中走正常生成流程，确认原有业务明细和指标没有变化，才允许补充原表并同步会话汇总。发现业务数据已变化，要求走正常闲时批次，不强行修改旧统计快照。写入前备份，检查 Worker 空闲和数据库版本，事务内更新；不修改六张其他看板表或批次状态，不启动／停止服务。

本机本次已完成原表补充、会话重新投影及逐字段核对，SQLite 完整性检查通过。4401、4415 预览未停止；现有后端未重启，后续自动刷新仍需常规部署加载本次代码，未改变定时任务开关。

验证包含缓存去重、流式响应、跨天与空闲时长、缺失值、同名会话隔离、仅查询原表、原始数据更改不绕过原表、原表／候选隔离、超过 500 行分页、旧格式拒绝回退，以及原表与会话发布失败一起回滚。

当前 Node／better-sqlite3 的原生语句清理问题仍存在，独立 Worker 不能据服务层测试宣称已通过端到端验证。本机验证使用仅验证进程的语句保留预加载，未把规避逻辑加入业务实现。
