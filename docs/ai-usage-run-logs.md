# 夜间 AI 统计执行日志

服务升级并启动后，数据库迁移自动创建 `ai_usage_run_logs` 表和 `ai_usage_run_log_status` 视图，无需手工建表。每个实际调度窗口、每个活跃租户一行；工作进程取得全局租约后，在开始统计前先登记完整租户队列。因此未轮到的租户也可查询。租户记录不包含对话或 SQL 正文。

`run_date` 是窗口开始时间在 `time_zone` 下的日期。例如北京时间 10 月 16 日 02:00 开始的任务查 `2026-10-16`；它不是被统计数据的日期。`target_through` 是本窗口希望覆盖到的数据截止日期。同一日期如果调整过运行时间，可能有多个 `scheduled_for`，汇总时按窗口分开，不能直接跨窗口累计租户数。

## 查完成量和剩余量

在服务实际使用的 SQLite 数据库执行，替换日期即可；默认上海时区时，可将日期字面量换成 `date('now','+8 hours')` 查看今天凌晨的窗口。

```sql
SELECT run_date, scheduled_for, time_zone,
       COUNT(*) AS total_tenants,
       SUM(effective_status = 'published') AS completed,
       SUM(effective_status NOT IN ('published','skipped')) AS remaining,
       SUM(effective_status = 'pending' AND attempt_count = 0) AS not_started,
       SUM(effective_status = 'running') AS running,
       SUM(effective_status = 'paused') AS paused,
       SUM(effective_status = 'failed') AS failed,
       SUM(effective_status = 'interrupted') AS interrupted,
       SUM(effective_status = 'skipped') AS skipped
FROM ai_usage_run_log_status
WHERE run_date = '2026-10-16'
GROUP BY run_date, scheduled_for, time_zone
ORDER BY scheduled_for;
```

`completed` 只计当前窗口已发布；`remaining` 包括未开始、续跑旧批次后仍有积压、处理中、暂停、失败和异常中断。`skipped` 是同一窗口重试时已停用的租户，不算待处理。`not_started` 是尚未成功领取、仍在等待的租户，不包含领取阶段已经报错的行。

## 查统计了哪些租户、停在哪里

```sql
SELECT tenant_id, queue_position, effective_status AS status,
       CASE incremental_enabled WHEN 0 THEN 'full'
         WHEN 1 THEN 'incremental' ELSE 'unknown' END AS mode,
       attempt_count, stage, reason, error,
       batch_id, target_through, published_batches,
       datetime(started_at, '+8 hours') AS started_beijing,
       datetime(updated_at, '+8 hours') AS updated_beijing,
       datetime(finished_at, '+8 hours') AS finished_beijing,
       last_published_batch_id,
       datetime(last_published_at, '+8 hours') AS last_published_beijing
FROM ai_usage_run_log_status
WHERE run_date = '2026-10-16'
ORDER BY scheduled_for, queue_position, tenant_id;
```

只看尚未完成，在 `WHERE` 后追加 `AND effective_status NOT IN ('published','skipped')`。只看实际领取执行过的租户，追加 `AND attempt_count > 0`。以上展示时间固定北京时间，存储时间戳为 UTC；使用其他业务时区时自行调整显示。

| 状态／原因 | 含义 |
| --- | --- |
| `published` | 本窗口对应批次已成功发布，正式结果已切换 |
| `pending / waiting_for_slot` | 已入队，等待执行 |
| `pending / window_ended` | 窗口结束前没有轮到 |
| `pending / backlog_remaining` | 这晚发布了之前暂停的旧批次，但还未完成本窗口目标 |
| `pending / tenant_lease_held` | 本租户已有有效执行租约，本轮未领取 |
| `running` | 正在执行；`stage` 是最近保存的阶段 |
| `paused` | 到达窗口结束或收到停止请求；看 `reason` 和 `stage` |
| `failed` | 执行或领取报错；看 `error`，`stage=claim` 为领取阶段失败 |
| `interrupted` | 原工作进程、批次租约失效或窗口已结束，不能继续当作正在运行 |
| `published / already_published` | 部署或重试时确认本窗口原已有成功批次，没有因此重跑 |
| `skipped / tenant_inactive` | 同一窗口重试时发现该租户已经停用 |

`attempt_count` 仅记录本功能观测到的成功领取次数；补录已发布结果时为 0，不伪造开始时间。`incremental_enabled` 在未领取时是配置计划值，领取后是批次实际模式；旧成功批次缺少模式快照时为 NULL/unknown，不根据当前配置猜测。`published_batches` 包含本窗口中成功续跑的旧批次，以及明确确认的当前窗口已发布批次；它是批次数，不是已完成租户数。

旧批次续跑保留原 `batch_id` 和批次 `scheduled_for`，但日志的 `scheduled_for/run_date` 始终使用实际运行窗口。仅续完旧批次时 `finished_at` 为空，`last_published_at` 记录那次发布；之后本窗口批次完成才记 `published`。同窗口重试更新同一行并增加领取次数，不重复计租户；旧窗口记录不会被次晚的成功改写成“那晚已完成”。这张表是窗口内的最终状态与尝试计数，不是每次重试逐条追加的事件表。

优先查视图的 `effective_status`，它根据当前租约和窗口即时判断异常中断；直接查表的 `status` 在进程崩溃后可能暂留 `running`，下次工作进程启动会持久化修正。批次发布与成功日志在同一数据库事务中提交；正式结果回滚时不会留下假的成功日志。日志写入异常会输出 `[AI usage] run_log_failed` 或使相应批次失败，旧正式结果仍保留。

本功能从部署后的调度窗口开始记录；不会补造以前每晚的尝试历史。**某日期查询无行表示没有该窗口的执行记录，不能解释为全部完成或 0 个剩余。** 调度未启用、进程未运行、初始化失败、查询了错误数据库或日期时，要结合 PM2 的 `[AI usage]` 日志检查。已有当前窗口成功批次会在窗口内补录确认，但白天不触发历史扫描或补造日志。

## 租户逐用户复核

[核算脚本说明](ai-usage-user-audit.md) 中的 `--user-id` 已可省略。提供租户 ID、数据库路径和日期范围，即逐用户输出 SQL 行数、AI 时长及覆盖/错误；独立打包版无需同步服务器的共享计算源码。它读取原始来源，不写入执行日志，也不覆盖看板结果。
