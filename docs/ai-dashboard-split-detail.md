# AI 看板追加五张拆分明细表

更新：2026-09-17，结构版本 4（AI 时长单位为秒）。看板查询已切换为五张主题表；旧表、宽表、会话对接表和既有统计口径保留，写入链路不变。此前三张追加主题表已调整为五张，AI 交互和时长合并到同一日记录中。

## 1. 五张正式表

带逐字段注释与真实样本：[五表结构文档](ai-dashboard-five-tables-ddl.md)。可执行的 SQLite 建表语句：[纯 DDL](ai-dashboard-split-detail.sql)。

| 表名 | 一行的粒度 | 主要统计方式 |
| --- | --- | --- |
| ai_dashboard_ai_detail | 同一租户、用户、工作区、会话、统计日期 | 当日交互标记＋已知完成时长之和 |
| ai_dashboard_skill_publication_detail | 一个确认首次发布的 Skill | COUNT(*)；累计发布限定截止日 |
| ai_dashboard_skill_invocation_detail | 一次去重后的有效 Skill 调用 | COUNT(*)；调用人数按 user_id 去重 |
| ai_dashboard_sql_generation_detail | 一条 SQL 生成记录 | SUM(generated_sql_lines) |
| ai_dashboard_code_submission_detail | 一条已合并的 CodeHub MR 记录 | SUM(submitted_code_lines) |

SQL 生成和代码提交不是一一对应关系，不强行拼接、不相加、不计算占比。提交行数沿用 ai_mr_submissions 中 status=merged 的 additions；不按 commit_sha 擅自去重不同 MR。

### AI 合并规则

- 分组键为 tenant_id、user_id、workspace_id、ai_session_id、stat_date。名称只作为标签，同名不同 ID 不合并。
- has_ai_interaction 的含义改为“当日有交互”：只要组内存在交互就为 1；当天只有时长续算则为 0。它不是数据有效性标记。
- ai_active_duration_seconds 累加同组所有已完成且具有可靠数值的时长。没有已知时长时保留 NULL，已确认零时长保存 0；部分请求时长未知时，数值仍仅代表已知时长合计，需结合原批次覆盖状态解读。
- 不从会话首末消息推算时长，不包含两轮之间的等待，不改变原有跨日分摊方式。例如 23:59 至次日 00:01 的请求，每天各记 1 分钟，但无新交互的第二天不能因此成为活跃日。
- occurred_at 为组内当天最早交互时间；如果当天没有交互，则保存时长来源中的最早原请求开始时间，因此可能早于 stat_date。日期筛选必须使用 stat_date。
- AI 的 id 由上述分组键稳定生成。因多行合并，它不再等于单条宽表 ID。后续补齐时长仍更新同一组 ID，不新增同粒度记录。名称沿用按宽表 ID 顺序读取到的首个非空名称，不重新查业务表。
- 原输入仍必须只包含一种事实。交互／时长双填、发布／调用双填或来源无法识别时拒绝处理；只在目标 AI 表内按确定分组归并。异常或溢出的时长拒绝发布，不静默截断。

### 其他字段约定

- 四张非 AI 表沿用原宽表稳定 id。联合主键均为 (tenant_id,id)，不含 dataset、event_type、partition_id、逐行 batch_id 或 refreshed_at。
- Skill 发布表只保留 publisher_user_id/name 表示发布者，不再重复行为用户及固定为 1 的发布标记。调用表的 user_id/name 是调用者，publisher_user_id/name 是发布者，不再保留固定为 1 的调用标记。
- 原宽表的字段均保持不变，包括原有行为标记和 refreshed_at；本次只改变追加拆分结果。
- SQLite 日期／时间仍用 TEXT：上海日期 YYYY-MM-DD，时间 YYYY-MM-DD HH:mm:ss；AI 时长为 REAL（秒，保留原毫秒精度），行数为 INTEGER。NULL 是未知或不适用，不是数字 0。

## 2. 来源、暂存与原子发布

1. 原有流程先生成旧候选 ai_usage_report_staging。
2. 从旧候选生成同批宽表候选 ai_dashboard_integration_staging。
3. 只从宽表候选生成五张对应的 *_staging；AI 按日分组合并，其余四类原样投影，不独立采集源业务表。
4. 全部候选准备好后，同一 SQLite IMMEDIATE 事务替换该租户的旧表、宽表、五张追加表，并更新批次状态和清理候选。

总共七张正式表同批发布，任一步失败整体回滚。每个源分页的写入、AI 累加和源 ID 游标一起提交；中途暂停或失败后从持久化游标恢复，已累加的时长不会因恢复而重复相加。准备就绪的候选再次进入构建步骤不会再次写入。

旧版候选 version=1/2/3 不可当作新版五表已就绪。恢复时清理并重建五表候选，保留原宽表候选，不重新扫描业务源。

普通更正仍在下一次原子发布时同步，例如 MR additions 从 50 改成 40。原有安全删除／遮蔽同步覆盖 SQL、MR、Skill 发布对应的正式表和候选，发布删除不误删同 Skill 的调用记录。

AI 合并后，五表行数之和可以小于宽表行数，这是粒度变化，不是丢记录。应核对分组身份、活跃集合、时长和四类事实，而不是要求总行数相同。

## 3. 看板和对接查询

| 内容 | 看板当前使用的来源 |
| --- | --- |
| AI 使用、会话趋势、DAU／MAU、概览中的会话与活跃人数 | ai_dashboard_ai_detail |
| Skill 累计／期间发布、概览中的累计发布数 | ai_dashboard_skill_publication_detail |
| Skill 调用次数及调用人数 | ai_dashboard_skill_invocation_detail（与发布表组合） |
| SQL 生成行数 | ai_dashboard_sql_generation_detail |
| CodeHub 提交行数及提交记录 | ai_dashboard_code_submission_detail |
| Hook 执行、记录性 Hook、Agent 模板 | ai_usage_report_rows |

接口地址、页面结构、筛选、排序、分页和导出格式保持不变。查询层只把五表映射成原接口 DTO，不读取宽表／原明细补齐这些指标；Hook／Agent 仍只查旧表。前端导出通过相同接口逐页取全部匹配结果，不限当前页。宽表继续保留对接与中间投影职责；ai_session_summary 仍供会话对接，不参与看板计算。不新增公开接口，不开放整个业务数据库。

查询在同一只读事务内验证五表状态与当前发布批次一致。状态缺失、批次不一致或结构版本不为 4 时返回 409 / splitNotReady；不回退其他表、不在读请求里迁移或补写。已就绪但没有记录的租户是有效空结果。AI 同一日记录同时含交互与时长时，两者分别计入；秒转换为整数毫秒只用于兼容原接口，存储仍为秒。仅时长续算的记录不增加会话或活跃人数。

对接查询必须限定授权的 tenant_id，并按 stat_date 筛选日期：

- 会话次数：AI 表中 has_ai_interaction=1 的 ai_session_id 去重数量；不能直接数 AI 表行数。
- DAU：指定一天有交互的 user_id 去重；MAU：截止日及前 29 天整体对交互用户去重，不能相加每日人数。
- 时长：按所选范围 SUM(ai_active_duration_seconds)。跨日续算虽无新交互，仍应进入时长合计。
- Skill 累计发布：发布表 stat_date 不晚于截止日的行数；期间新增再限定开始日。调用贡献按 publisher_user_id 分组，谁实际调用则按 user_id 分组。
- 每用户生成 SQL 行数：在 SQL 生成表限定租户和日期后，GROUP BY user_id 并 SUM(generated_sql_lines)。工作区条件另加 workspace_id。
- 跨表统计先分别聚合到同一粒度再关联，不直接 JOIN 原始行后求和，避免一对多放大。
- SUM 忽略 NULL，全部未知保持 NULL。无记录是否可表示 0 仍取决于原批次覆盖状态。

## 4. 整组状态与运行边界

内部 ai_dashboard_split_state 每个租户一行，只有 tenant_id、batch_id、schema_version。这是整组五表的发布状态，不是每行版本分区，也不保留历史结果。

一次多表读取应在同一只读事务中确认：schema_version=4，batch_id 与 ai_usage_tenant_state.active_batch_id 一致，批次状态为 published，覆盖信息满足要求。统计结果发布时间读取同批 ai_usage_batches.completed_at，业务截止时间读取 target_through；这些内部元数据仍保持原来带时区格式，对外展示时再转上海时间。

现有预览服务与实际项目 SQLite 分离，不需要停止预览。**本次未重启实际后端或修改定时任务开关；后续自动生成五表结果需要实际后端加载新版代码。** 旧版程序不应继续执行已移除混合表的三表写入流程；部署时需在 Worker 空闲边界加载新版代码，并验证一个新批次。若批次不一致，应拒绝把追加表当作最新结果读取。

新版模拟预览使用 http://127.0.0.1:4416/，通过五表接口展示并导出，仍明确标注为模拟数据。原 4401／4415 进程未停止；其内存库缺少新版五表，核心统计会提示需要迁移，不能用它们验证本次取数。生产实例仍需正常部署／加载本次后端代码。

## 5. 迁移与实际结果

实际项目库：/Users/da-group/.cloudcli/ccui/data/auth.db。2026-09-17 已在私有副本演练，再备份实际库，完成三表到五表的原子迁移。

| 数据 | 迁移后行数 |
| --- | ---: |
| 旧统计明细（未改变） | 276 |
| 原宽表（未改变） | 36 |
| AI 合并明细 | 24 |
| Skill 发布 | 0 |
| Skill 调用 | 0 |
| SQL 生成 | 9 |
| 代码提交 | 0 |

原 AI 表 27 行（24 条交互、3 条时长）合为 24 行；已知 AI 时长合计仍为 547.032 秒（原 547032 毫秒），SQL 行数仍为 41。来自既有发布结果，含历史验证业务，不是本次向实际库新增模拟数据。Skill／MR 没有已发布记录，文档不编造样本。

已移除被替代的 ai_dashboard_skill_detail、ai_dashboard_code_detail 及两张对应暂存表。迁移前私有备份为：/var/folders/6h/dh06wgxj4vsd406jrxywrhr40000gn/T/ccui-split-backup-JsH89f/before.sqlite。备份包含整个项目数据库，不应对外分发；整库恢复会影响备份后的其他业务改动，需单独评估，不能直接覆盖运行中的数据库。

## 6. 本次看板取数切换验证

- 真实项目库只读对账：两个已发布租户的概览、汇总、趋势、AI 分组、Skill、代码产出和提交明细与原宽表查询逐项一致。租户 1 为 21 个会话、547.032 秒已知时长、41 行 SQL；提交行数因来源不可用仍为 NULL，不展示为 0。未写入业务库，quick_check 为 ok。旧明细因后续会话投影补充现为 297 行，前节 276 行是此前拆表迁移时的数量。
- 204 项服务测试、9 项 HTTP／权限测试、60 项前端逻辑测试通过；前后端 TypeScript 检查和改动文件 ESLint 通过。服务测试使用既有测试进程专用 SQLite 兼容预加载；未运行已知存在本机原生模块问题的独立 Worker 进程测试，不据此声称 Worker 部署验收完成。
- 专项测试拦截核心查询，禁止读取旧表、宽表、原始事实及会话汇总；分别改动五表能改变对应结果，改动旧表／宽表不会影响核心指标。覆盖日／周／月、用户／工作区、Skill 发布者归属、跨日时长、MAU 窗口边界、NULL、空租户与未就绪错误。
- 浏览器验证使用隔离模拟库，不拦截或替换接口响应：AI／Skill／代码分别导出全部 43／30／40 行；用户筛选、重置、空结果、提交详情及 Hook／Agent 页面通过。检查桌面与窄屏渲染，无浏览器运行错误；页面仍标识为模拟数据。

脚本 scripts/migrate-ai-dashboard-split.mjs 默认只读；明确附加 --apply 才执行备份、校验和迁移。对 v1 六表和 v2 三表均先校验旧行的所有字段能否对应保留的宽表／候选，再重建目标并移除不再使用的表。共享表名的 AI 数据也在覆盖前校验。遇到有效 Worker 租约、额外字段或无法对应的数据时拒绝迁移，避免丢弃人工改动。重复执行不重复写已同步结果。

源宽表按 500 行分页回填，夜间按配置页大小处理；按主键查询与写入，遍历处理量 O(W)，另有主键索引查找和写入成本，通常总量级 O(W log W)。AI 合并结果数不超过 AI 源行数。暂存与正式结果各需一份，另有 WAL／事务日志空间。离线迁移核对脚本会在内存中保存当前租户的预期结果，内存量级 O(W)；夜间写入仍按分页执行。

### 时长单位升级（版本 3 → 4）

AI 正式表及暂存表的 ai_active_duration_ms INTEGER 改为 ai_active_duration_seconds REAL，数值除以 1000，不截断整秒。原来 453607 毫秒保存为 453.607 秒，NULL 和零分别保留，24 条正式 AI 记录的 ID 均不变。原宽表仍使用毫秒；本次不修改其数据或日期时间格式。

聚合时按原毫秒精度累加再转换为秒，避免逐次浮点相加造成漂移。外部展示 SQL 的 SUM 结果可按 ROUND(SUM(ai_active_duration_seconds),3) 输出；REAL 本身是浮点存储。

迁移先核对原每日汇总与同批宽表，暂停候选仅按已持久化的源游标核对，避免把部分累加误当完整值；发现额外索引／触发器时拒绝自动替换。表类型转换、重建和状态更新在同一事务中完成，失败全部回滚。已先在副本演练、再备份并迁移实际库；单位升级前备份为 /var/folders/6h/dh06wgxj4vsd406jrxywrhr40000gn/T/ccui-split-backup-kbdVJk/before.sqlite，恢复需单独评估备份后的其他业务改动。

## 6. 验证

- 服务回归 178 项、HTTP／租户权限回归 9 项通过；服务端类型检查和相关文件 ESLint 通过。
- 覆盖五表映射、AI 同日多轮及跨日合并、NULL／0、补齐时长后 ID 稳定、溢出拒绝、调用者与发布者、空租户及租户隔离、v1/v2 迁移、分页回填、迁移失败回滚、旧候选恢复、重复进入已就绪候选、发布失败七表回滚、安全遮蔽、MR merged 过滤、更正与删除。
- 新增验证包括秒字段 REAL 类型、三位小数精度、NULL／0、不改变每日分组 ID、单位迁移失败回滚和旧毫秒候选恢复。实际迁移核对旧表、宽表、批次、租户状态及原候选的前后指纹，均未改变；数据库 integrity_check=ok。
- 本机 Node 24 / better-sqlite3 独立 Worker 原生清理钩子问题仍是已有环境限制，进程内回归不代表独立 Worker 已部署验证。测试只在测试进程使用语句保留预加载，生产代码未引入此规避逻辑。
