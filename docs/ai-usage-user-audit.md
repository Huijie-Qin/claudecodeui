# 租户逐用户／单用户 AI 用量核算

`node scripts/audit-ai-usage-user.mjs` 从原始记录重新计算 AI 活跃时长、代码生成量（SQL 物理行数），不读取看板汇总值，不回写数据库或触发统计任务。省略 `--user-id` 时输出指定租户的每个用户；指定 `--user-id` 时保持原单用户详细结果。无需传用户名。

在已部署同版本代码并安装服务依赖的项目目录中运行。入口 `scripts/audit-ai-usage-user.mjs` 依赖共享的 `server/services/ai-usage-sql.js`、`ai-usage-transcript-duration.js`、`ai-usage-transcript-markers.js` 及它们的依赖；不要只替换入口文件或继续使用旧 `.txt` 副本。`--db` 使用服务实际的 `DATABASE_PATH` 绝对路径；租户和用户参数均为数据库数字 ID。脚本不自动加载 `.env` 或 PM2 环境变量。下面的数据库路径和 ID 需替换为实际值：

```bash
node scripts/audit-ai-usage-user.mjs \
  --db /absolute/path/auth.db \
  --tenant-id 1 \
  --from 2026-10-01 \
  --to 2026-10-13
```

默认按用户分段输出，每项带明确的中文标签，避免终端制表符错位；包含用户 ID、用户名、AI 时长（秒／小时）、SQL 行数、来源说明、已读主历史文件数、完成轮次数、数据库消息数及跳过／错误。开头汇总时长和 SQL 各有多少用户不可用。顺序逐用户核算，不并发开启多个用户的扫描。

用户集合为该租户现存 `tenant_users` 关系（包括 active、disabled、pending）与 `session_index`、`agent_session_runtime`、`agent_session_messages`、`ai_usage_turn_facts` 中历史归属用户的并集，按 ID 排序去重。无记录成员也列出；已离开租户但有保留历史的用户仍列出。不扫描全库 `users`，也不把其他租户的成员或历史记录计入。只复制数据库而未保留历史文件时，时长仍会显示不可用。

租户汇总 JSON：

```bash
node scripts/audit-ai-usage-user.mjs \
  --db /absolute/path/auth.db --tenant-id 1 \
  --from 2026-10-01 --to 2026-10-13 --time-zone Asia/Shanghai \
  --json > tenant-ai-usage.json
```

新租户模式的 JSON 为 `auditVersion: 4`、`mode: "tenant"`，包含 `users[]`、`userCount`、`successfulUsers`、`failedUsers`。每个用户含 `userId`、`userName`、`metrics.aiActiveDurationSeconds`、`metrics.aiActiveDurationHours`、`metrics.generatedSqlLines`、`coverage`、`scanned`、`skipped` 和 `error`。成功行 `error=null`；用户核算失败时保留其 ID，指标全部为 null，`error` 提供原因，其余用户继续。顶层 `status=partial_failure` 表示至少一个用户失败；此时 CLI 仍输出完整结果，退出码为 **2**，不会把失败当成 0。全局参数、租户或数据库错误退出码为 **1**。

需要某一个用户的逐日结果、具体文件和异常位置时，加回 `--user-id 7`。此模式的 `auditUserUsage()` 导出和 `auditVersion: 3` 输出保持不变；新增程序接口为 `auditTenantUsage()`。日期范围在两种模式下都必填。租户模式共享开始时读取的工作区归属与屏蔽元数据，逐用户用短只读事务读取消息，关闭连接后扫描文件；整个租户不是一个事务快照。

单独交付的打包版 `.mjs` 已内联共享计算模块，不需要同步服务器的 `server/services` 文件；请把它放在服务项目根目录或 `scripts/` 下，复用现有 `better-sqlite3`，使用服务相同的 Node.js。仓库中的源码入口仍需要上述同版本模块。

两端日期都包含；默认时区为当前进程的 `AI_USAGE_TIMEZONE`，未设置则为 `Asia/Shanghai`，可用 `--time-zone` 显式指定。核对看板时应使用相同时区和已发布的统计日期范围。

脚本每次从头读取；夜间默认通过内容校验后复用已计算记录，设置 `AI_USAGE_INCREMENTAL_ENABLED=false` 时每个新批次从原始来源全量重建。全量重算期间保留已发布结果，成功后按租户覆盖，不叠加旧统计。夜间 `transcript_content_v16` 修复旧记录改写后增量缓存不失效的问题，并在升级后的首个可领取批次重建历史。已有 v3 打包脚本不受该缓存缺陷影响，但只支持单用户；要省略 `--user-id` 输出整个租户，请使用本次 v4 打包版。线上验收应先确认 `active_batch_id` 指向已发布的 v16 批次，见 [历史重建与验收](ai-usage-development.md#2026-10-15-历史文件改写与-v16-重建)；同日已发布批次不会因部署立即重开。


单用户模式添加 `--json` 导出完整结果，包括两项合计、逐日结果、文件扫描、SQL 与历史时长追溯样本，以及最多 100 条异常定位信息：

```bash
node scripts/audit-ai-usage-user.mjs \
  --db /absolute/path/auth.db --tenant-id 1 --user-id 7 \
  --from 2026-10-01 --to 2026-10-13 --time-zone Asia/Shanghai \
  --json > user-ai-usage.json
```

## 计算与异常处理

- **AI 活跃时长**：与夜间统计复用同一历史解析器，读取绑定到目标租户和用户的 Claude 主会话 JSONL。每轮从真实用户消息开始，到该轮最后一条主助手消息结束；只有助手 `end_turn`、成功 `result`、`system.turn_duration` 或相邻 `completed-replies.jsonl` 中的成功回复标识才确认完成。完成标记的写入时间不作为响应结束时间。跨日按时区切分，按所选日期汇总；不同主会话并行分别累加，子代理不另加一份时长。工具返回、内部消息和 fork 继承内容不作为新用户轮次。失败、取消、未完成及时间异常轮次不计，正常轮次继续累计。
- `ai_usage_turn_facts` 只用于实时捕获诊断，不参与时长。即使表内有 600 秒的完成请求、对应历史轮次只有 60 秒，也只计 60 秒；该表缺失不妨碍从历史文件恢复时长。没有可读主会话时，不用实时请求表或数据库消息首尾跨度补算。
- **代码生成量**：复用服务 SQL 解析器，纳入 AI 正文、思考／推理及工具调用输入参数中的 SQL，兼容没有 role 的 thinking/tool_use 记录。同一回复跨内容块完全相同的 SQL 去重，用户输入、工具返回、系统状态及流式重复片段排除。读取绑定到目标用户与租户的 Claude 原生 JSONL；同一会话存在可读主文件时优先使用原生文件，否则使用 `agent_session_messages.normalized_json`。其他提供方使用消息表。所有工作区、提供方合并为该用户两项指标，不混入其他租户或用户。
- SQL 按回复的业务日期统计。重复读取、消息修订、fork 继承、子代理分支、非 SQL 内容、来源优先级及被屏蔽记录沿用现有规则。仅解析换行结束的完整 JSONL 行；单行超过 2 MiB、损坏消息、不可读文件会记录诊断后继续。损坏或超长的完整 JSONL 行使其当前时长轮次失效，不拼接缺失边界；其他已完成轮次保留。未换行的文件尾部留待后续运行，外会话行单独跳过，两者都不撤回此前已完成的合法轮次。文件替换或缩短时丢弃该文件本次贡献。
- 已知工作区归属错误或 `SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT` 的会话跳过，正常会话继续。不存在租户直接报错；单用户模式不存在用户直接报错，租户模式中历史归属 ID 缺少用户元数据时保留该行并标记失败。不要求用户当前仍是租户成员，便于核算保留的历史。
- 数据库以只读连接读取所需记录，结束读取事务并关闭连接后才扫描文件。租户枚举时的权限、数据库锁、缺业务基础表等全局错误会退出并返回非零状态；枚举完成后的单用户失败按上述规则保留错误并继续，不伪装成统计值 0。不会创建不存在的数据库。

## 结果说明

以下详细诊断字段适用于 `--user-id` 单用户模式；租户模式通过 `users[]` 提供每人的指标和覆盖汇总。

`metrics.aiActiveDurationMs` 和 `aiActiveDurationSeconds` 分别为毫秒、秒；`metrics.generatedSqlLines` 为 SQL 行数。`daily` 仅列出有有效贡献的日期；没有记录的日期不额外补行。

`coverage=partial` 表示只能核算当前保留且可读取的来源，不保证历史完整。JSON 中的 `coverage.durationReason=readable_main_history_only` 是时长来源说明，不是 SQL 指标，也不是错误；SQL 数值始终读取 `metrics.generatedSqlLines`。时长 **0** 表示已读到主会话，但所选日期没有有效完成时长；时长 **null / 不可用** 表示没有可读且归属明确的主会话，`coverage.durationReason=no_readable_main_history`。可读主会话的原因值为 `readable_main_history_only`。实时请求表是否有记录不决定时长覆盖。SQL 既无消息表也无可读原生文件时为 null。

`skipped` 按原因计数，`database_copy_native_preferred` 属于 SQL 来源规则性排除；`history_duration_anomaly` 的具体原因见 `issues.anomalyReason`，结合 `malformed_*`、`unreadable_*`、归属冲突排查。无明确完成证据的轮次在 `durationDiagnostics.incomplete` 中计数，不伪装成已完成。

`native_preferred` 按整个会话选择来源，并不代表已在文件中找到某条数据库消息的对应 SQL。主文件可读但为空、格式未被识别或无有效 SQL 时，同样不会退回该会话的数据库副本。SQL 的识别和计数独立于时长，不要求该轮具有完成证据。

`scanned` 是扫描全历史来源的数量，不是所选日期内数量：`durationFiles` 为可读主会话文件数，`historyTurns` / `completedHistoryTurns` 为这些文件识别到的轮次／完成轮次，`nativeFiles` 还包含 SQL 子代理文件。`turnRecords` / `capturedCompletedTurns` 仅反映实时请求表的诊断数量。重复来源也计入扫描量，最终贡献会去重。为了处理跨日和后续修订，先解析完整来源，再按日期筛选。

`auditVersion: 3` 的 `sources` 按原生文件列出绝对路径、读取字节／物理行、JSON 记录、AI 回复、含 SQL 回复及最终计入行数。`sqlMessages` 包括后续被修订或日期过滤掉的版本，`countedSqlLines` 才是该文件对最终 SQL 的贡献。时长字段为 `durationStatus`（`read`、`unreadable`、`subagent_excluded`）、`completionMarkersStatus`、`historyTurns`、`completedHistoryTurns`、`durationAnomalies` 和最终贡献 `countedDurationMs`。

`sqlRecords` 列出消息 ID、文件行号（或数据库消息 ID）、业务日期、SQL 行数与最终状态：`counted` 已计入、`out_of_range` 范围外、`no_sql` 未识别到 SQL、`inherited` 继承记录、`superseded` 后续修订覆盖、`duplicate_source` 重复来源、`native_preferred` 被原生文件替代的数据库消息、`suppressed` 被屏蔽、`non_generated_kind` 工具返回／系统状态／流式重复片段、`missing_identity_or_time` 缺标识或时间、`source_unreadable` 来源读取失败。`no_sql` 也可能表示文本格式不被现有解析器识别，需要按文件行号核对，不能据此保证回复完全不含 SQL。原生优先的数据库副本不解析正文，其日期和行数可能为 null。

`durationRecords` 按轮次及日期片段列出文件路径、会话键、轮次键、`requestStartedAt`、`responseCompletedAt`、`completionEvidence`、该日 `durationMs`、最终贡献 `countedDurationMs` 和状态。`counted` 已计入、`out_of_range` 日期范围外、`duplicate_source` 重复文件来源，`incomplete` / `failed` / `cancelled` 等不贡献时长。成功的零时长轮次可显示 `counted` 且贡献为 0。同一跨日轮次会有多个日期片段，起止证据保持完整区间。

同一轮次存在多个历史文件副本时，先按完整轮次选择唯一来源：原生来源优先级相同时取 `source_key` 字典序最小的文件，再处理该来源的全部日期片段。失败、未完成版本也参加来源选择，会压住次优文件中的旧完成版本；缩短后的轮次不会混入旧副本的次日切片。选择来源后才筛选日期，优先副本删除后可恢复仍可读取的次优副本。其他文件的该轮片段标为 `duplicate_source`。

`sources`、`sqlRecords`、`durationRecords` 各最多 1000 条，超出通过相应 `*Truncated` 标明；`sqlDiagnostics` 与 `durationDiagnostics` 是全量最终状态计数，采样上限不影响指标累计。不输出 SQL 或消息正文。

请在能读取数据库记录的 `runtime_home_path` 原路径的服务主机或容器中执行。仅复制数据库到别处可能找不到历史文件，此时时长不可用；SQL 可按原规则退回数据库消息副本，并通过不可读目录等诊断提示。脚本不扫描未绑定的个人历史目录，也不输出 SQL、对话正文或凭据。

历史文件必须同时保留可信用户边界、主助手时间及完成证据，单独存在会话首尾时间戳不足以计算时长。相邻完成标记在下一次运行时会重新读取，因此主文件不变而后续补入成功标记，也可以恢复该轮时长；缺失边界或证据的轮次不会按整段会话跨度估算。若服务仍在写入，数据库与各文件不构成同一事务快照；原生文件只读取打开时的固定长度，后续追加留到下一次核算。当前来源也可能包含上次看板发布后新增或修正的数据。

验证命令：

```bash
node --test scripts/audit-ai-usage-user.test.mjs
```
