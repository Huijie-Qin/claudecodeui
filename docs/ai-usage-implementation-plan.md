# CCUI 租户级 AI 使用、Skill 共创及 Hook / Agent 模板报表实施方案

2026-09-17 存储方案更新：本文中的版本分区、历史批次保留和旧批次导出为历史设计，已由 [先暂存计算、再事务更新正式明细](ai-usage-staged-refresh.md) 替代。正式明细不再有 `partition_id`；任务日志仍保留，旧结果被替换后需刷新查询／重试导出。

初版日期：2026-09-08；最近修订：2026-09-11。状态：首版采集、夜间统计、权限/API和报表页面已在当前工作树实现，尚未部署或启用生产统计。本文保留需求与设计依据；实际实现范围、未完成项、配置和验证说明见 [开发与运行说明](./ai-usage-development.md)。检查范围为代码、隔离样本与测试，不包含部署环境数据库或真实调用历史。

修订记录：2026-09-08 增加租户管理员 `tenant_admin` 和“记录性 Hook”页签，此前“不增加额外角色”的约束被替代；2026-09-10 增加“Agent 模板使用”页签，展示模板应用记录及模板来源工作区的活跃情况，其余已确认口径不变。

2026-09-11 补充“会话记录”后置行为的具体业务字段统计，按不同 Hook 独立展示；按当前项目实际能力，将该称呼映射到“记录数据”后置行为 `write_record`，不新增同名动作，也不默认归档整段聊天正文。

调度修订：按最新要求改为非实时、每日闲时批处理，ENV指定执行时间，默认建议每天02:00（Asia/Shanghai）。本修订替代前面的分钟级扫描和实时统计建议；白天保留必要业务记录，报表仅展示已完成的夜间统计批次。

时长修订：用户已明确按每轮“用户发起请求 → AI完成本轮响应”累计，10:00–10:02与10:30–10:33合计5分钟，不计两轮之间的28分钟。废弃此前相邻消息全间隔累计的建议；不设上限指不截断单轮真实耗时，不代表计入轮间空闲。

## 1. 工程结论

复用 CCUI 的 React/TypeScript/Tailwind 前端、Express 后端、better-sqlite3 数据库和现有租户权限。采用“白天业务留痕 → ENV指定的闲时窗口增量统计 → 完整批次发布 → 页面读取已发布结果”，不要求实时更新。夜间任务将Claude JSONL和其他provider已留存消息转换为轻量统计事实，并统一生成AI、Hook及Agent模板报表结果。

租户管理员复用 `tenant_users.role`，不增加全局管理员标记，也不放开 `/api/admin`。记录性Hook的源数据仍为已有 `hook_data_records`，不经过JSONL采集、不双写一套业务事实；夜间生成必要的白名单报表投影，页面不直接混入白天新写入的源记录。

Agent模板源数据复用已有 `workspace_agent_template_snapshots`，通过工作区确定租户；夜间关联会话统计并发布只读报表投影。首期不新增模板事件队列、完整操作流水或重复业务快照，不把“选择模板建工作区”误当成每轮Agent调用。

首期无需新增MQ、Redis、独立微服务或对象存储。现有服务启动轻量调度器，仅在允许窗口唤起统计Worker，通过Node worker_threads隔离JSONL解析与聚合。数据库写入仍须短事务、串行化和重试；闲时运行降低与白天业务争用，但不消除CPU/IO成本。是否进一步拆分独立统计SQLite库由压测决定，不作为本次定时统计的前置条件。

不继续采用“仅按业务表 updated_at 扫描”的设计：当前 Claude 的主要历史在文件中，文件写入与数据库不能用一个本地事务保证原子性。文件检查点与幂等补扫是必需机制；同库事务标记只适用于确实落库的消息及本地业务记录。

## 2. 已核实的项目能力

| 能力 | 代码位置 | 对本需求的影响 |
| --- | --- | --- |
| 前后端一体项目 | `package.json` | React 18、TypeScript、Vite、Tailwind；Express、better-sqlite3、worker_threads 可复用 |
| 管理端统计入口 | `src/components/admin/AdminPanel.tsx` → `AnalyticsDashboardTab.tsx` | 当前已有平台用户、会话概览；新增 AI 使用子视图，不改变原指标含义 |
| 当前统计接口 | `server/routes/admin.js`、`server/services/admin-analytics.js` | `/analytics/summary`、`/analytics/users` 是管理范围统计，不适合直接开放给普通用户 |
| 平台 admin 标识 | `server/routes/admin.js` 的 `requireSystemAdmin` | 继续使用 `is_system_admin`，管理接口的门禁保持不变 |
| 租户成员角色 | `tenant_users.role`、`multitenancy-db.js` 的 memberships | 已有自由文本角色字段；新增 `tenant_admin`，与现有 `permission=view/edit` 独立 |
| 租户校验 | `server/middleware/tenant-context.js` | 接受当前租户参数，并校验有效成员关系；普通用户跨租户访问会被拒绝 |
| 租户状态与请求封装 | `src/contexts/TenantContext.tsx`、`src/utils/api.js` | 使用 `currentTenant`、`withTenantParam`、`authenticatedFetch` |
| 会话归属 | `session_index`、`agent_session_runtime` | 已有租户、工作区、用户、provider、会话及运行目录映射 |
| Claude 历史策略 | `server/services/session-message-history.js` 的 `persistNormalizedMessages` | Claude 只落库特定合成消息，普通消息以 runtime JSONL 为准 |
| 其他 provider 消息 | `agent_session_messages` | 可以读取已保存的标准消息；不能据此承诺 provider 外部所有历史均完整 |
| Skill 历史统计 | `scripts/tenant-skill-usage.mjs`、`docs/tenant-skill-usage.md` | 已处理原生 Skill、斜杠提交、子代理、归属、历史副本去重、覆盖不足提示 |
| Skill 发布链路 | `server/services/skill-market.js` | 调用远端市场 save/publish，再保存本地绑定；远端操作与本地数据库存在一致性窗口 |
| Skill 身份绑定 | `workspace_skill_market_imports` | 有 remote_id、skill_id、create_user_id、binding_type，但主要是当前状态，没有完整发布历史 |
| 后台任务先例 | `runtime-sweeper.js`、`top-skill-jobs.js`、`hook-script-executor.js` | 可参考启动/停止及 worker 使用方式；Top Skill 的内存 Map 不适合作为持久导出存储 |
| 现有定时调度 | `server/services/cron-schedule.js`、`scheduled-session-tasks.js` | 可参考轻量计时器及启动/停止结构；现有cron按进程本地时区计算，任务服务启动立即tick，且领取不是跨进程原子抢占、没有持久租约。独立时区、严格闲时与防重入需新增，不借此启动Agent会话 |
| Hook 业务记录 | `server/database/hook-config-schema.js`、`server/services/hook-runtime.js` | 已有 `hook_data_records` 及租户、用户、工作区、会话维度；`write_record` 和脚本 `ccui.records.write` 均能写入 |
| Hook 数据展示 | `src/components/admin/HookConfigsTab.tsx`、`hook-config/catalog.ts` | 有业务记录弹窗和 `shouldShowBusinessData`；现有 admin 查询只按 hookId，不能直接开放给租户管理员 |
| 后置行为记录字段 | `HookConfigEditor.tsx` 的记录字段编辑、`hook-runtime.js` 的 `write_record` 分支 | 已支持自定义 recordType、条件及字段绑定，结果写入data_json；记录行已有hook_id，但没有独立的后置行为ID和来源分类 |
| Agent 模板应用 | `server/routes/projects.js` 的 `applyAgentTemplateToWorkspace` | 当前模板仅用于新工作区；普通新建、克隆新建都经过共同应用函数 |
| Agent 模板快照 | `multitenancy-schema.js` 的 `workspace_agent_template_snapshots`、`agent-templates.js` 的 `saveWorkspaceSnapshot` | 每工作区一条，保存模板ID/名称、应用人、应用时间、模板当时更新时间及已安装能力；没有独立模板版本号，也不是每次对话记录 |

现有用户和租户表未提供本需求所需的部门层级；首期筛选使用时间、用户、工作区和 provider，不使用原型中虚构的部门数据。

现有 Skill 统计脚本的 8 项测试已通过：租户隔离、JSONL/数据库副本去重、别名及子代理、时间边界、覆盖不足、只读导出等。该结果仅说明这部分逻辑可复用，不表示新面板已经实现。

## 3. 业务范围与口径

页面保留四个原有业务指标，另设“记录性 Hook”和“Agent 模板使用”页签；不增加贡献指数或 Skill 种类数。用户类别为平台 admin、租户管理员、普通用户；租户管理员是成员关系上的角色，同一用户在不同租户可以有不同角色。

### 3.1 会话次数

建议定义：指定租户、用户、日期区间中，发生过人工用户交互的去重主会话数。主会话以 `(tenant_id, workspace_id, user_id, provider, provider_session_id)` 组成逻辑键，runtime_id 仅作为源定位辅助；同一会话重连不新增一次。

子代理的内部对话不计为用户的新会话。空会话不计。回复失败不反向删除用户已经发起的交互。自动任务来源单独保存，首期建议默认只计人工交互；该来源默认值属于方案建议。

按日趋势统计当天发生交互的会话；整个周期重新去重。因此一个会话连续两天交互时，两天的日值各为 1，周期值为 1，禁止直接把日会话数相加作为周期总数。

### 3.2 AI 活跃时长

已确认口径为 `request_response_interval_v1`：每轮从用户发起请求到AI完成本轮响应的耗时，按轮累计；上一轮响应结束到下一轮请求开始之间的时间不计入。不设空闲阈值、不截断单轮时长，也不使用会话首尾跨度。

例如同一会话，10:00发起请求、10:02完成响应；10:30再次发起请求、10:33完成响应。时长为 `(10:02-10:00)+(10:33-10:30)=5分钟`，10:02–10:30的28分钟不计。隔夜后再发起新请求也不会补算中间的等待。

工程实现以服务端接收并登记用户请求的started_at作为可核验起点，以同一逻辑轮次完成最终响应的response_completed_at作为终点；不是第一段流式输出时间、任意一条助手中间消息时间、下一次提问时间或进程退出时间。它是整轮响应耗时，不宣称等于模型纯推理时长。需通过可信turn/request标识关联并去重，不能仅按消息相邻关系配对。首次请求尚无终点时标记pending；历史缺少边界/关联依据时标partial，不将未知耗时伪装成0。

同轮多段流式回复、工具调用和子代理执行不另外累计；其处于请求到最终响应之间的耗时自然包含在该轮区间内。独立的记录性Hook后置行为不延长已经完成的AI响应区间，其记录仍按Hook报表口径展示。失败、取消、等待人工确认以及并发轮次的具体计入策略另行确认，底层保存状态与时间依据，不将这些边界策略视为用户已确认。

跨日的单轮区间按配置的业务时区（默认Asia/Shanghai）日期边界拆分，不截断真实长度；跨统计周期只取与查询范围相交的部分。例如23:59发起、次日00:02完成，该轮共3分钟，前一天1分钟、后一天2分钟。

公式：`period_duration = Σ overlap([request_started_at, response_completed_at), [from, to))`，只对符合统计范围且边界可核验的轮次计算。保留轮次身份、开始/完成时间、状态和来源证据，供夜间增量重算；不能只保存会话首尾或逐日总量。旧方案未实现，不存在已上线数据自动迁移；历史轮次无法可靠重建时明确覆盖范围。

### 3.3 发布 Skill 数量

建议为周期内首次成功发布的不同远端 Skill 数，按 `(tenant_id, market_source, remote_skill_id)` 去重；同一 Skill 更新版本、导入到多个工作区不重复增加。

使用本地首次发布流水或远端明确提供的首次发布时间。`imported_at` 不是首次发布时间，当前绑定条数也不是发布次数；未知历史不能用这些字段填补。下架不清除已发生的发布事实。删除后重新创建若远端生成新 ID，按新的 Skill 处理。

### 3.4 Skill 被调用次数

本方案沿用最初的共创目标：统计“本租户中，用户所发布 Skill 被调用的次数”，展示名称必须有“被调用”。若最终要统计调用人的使用次数，只切换查询归属到 caller_user_id，不能混用两种含义。

现有脚本的 `skill_tool_calls` 和 `skill_slash_invocations` 是两类观察，不能相加。首期可核验主口径以明确 Skill 工具调用为准，计调用发生而非执行成功。原生斜杠形式只有在能够证明实际展开/执行并有稳定关联时，才进入统一逻辑调用；未关联提交保留诊断记录，面板给出覆盖不足说明，不伪装成完整调用总数。

工具调用唯一键包含主会话、子代理标识、tool_use_id，不能仅用 Agent 运行根 ID 去重。相同 tool_use_id 的重复流式帧只算一次；同一轮合法多次调用不同 tool_use_id 分别计数。SDK 内部未提供重试关系时，不依据 Skill 名或时间近似强行合并。

来源为本租户的调用、发布者也能关联本租户时才计入对应发布者；不读取或汇总其他租户的调用数据。无法归属的历史保留 unresolved 状态，不能归给调用人或工作区 owner。

### 3.5 记录性 Hook

本项展示“Hook 已记录的业务数据”，不是将全部 Hook 调试日志或执行日志搬进报表，也不将 Hook 记录数混入 Skill 调用次数。

当前没有独立的 `recordOnly` 类型字段。首期识别范围为：在当前租户存在业务记录的 Hook，以及已对该租户生效、发布配置中含 `write_record` 的 Hook。后者即使在所选周期没有记录也显示 0。纯脚本通过 `ccui.records.write` 记录数据的 Hook，在第一次产生本租户记录后会被识别；若要求这类 Hook 在首次运行前也显示，需要另加显式记录能力声明，不通过匹配脚本文本猜测。

| 层级 | 展示内容 |
| --- | --- |
| Hook 汇总列表 | Hook ID/名称、记录类型、周期记录条数、产生记录的去重用户数/会话数、最近记录时间、当前启用/历史记录状态 |
| 记录明细 | 记录时间、用户、工作区、会话标识、Hook及版本、后置行为、记录类型、经字段白名单投影的业务数据 |
| 各 Hook 业务指标 | 按 Hook、后置行为、记录类型及字段定义版本配置名称、单位和可聚合项；不能仅按record_type混合统计或对任意JSON数字自动求和 |

首个适配类型采用项目现有 SQL 行数记录 Hook（`server/services/hook-examples.js` 的 `sql_response_metrics`）：展示 SQL 块数、SQL 行数、非空 SQL 行数、语句数、语句类型和字符数。类型内可汇总经校验的行数/语句数，并明确这是“生成记录量”，不是已采纳代码量或节省工时。已有写入逻辑会脱敏并截断过大 JSON；被截断、缺字段或非数值记录仍计记录条数，但相应业务指标标为缺失/部分覆盖，不补0，也不解析截断 preview 猜值。

记录条数以 `hook_data_records.id` 去重，时间筛选使用记录的 `created_at`。一次执行可能产生 0、1 或多条记录；“记录条数”不是“Hook 执行次数”，也不是业务产出的天然去重次数。当前没有通用业务幂等键，不凭内容相同合并不同记录；如需计算去重业务产出，须由对应类型提供稳定业务键。

记录详情采用按 Hook/后置行为区分的适配器和字段白名单；未配置的字段仍保留在源记录，报表显示安全元数据并提示“业务字段待配置”，不向租户角色原样返回任意 `data_json`。报表不返回 Hook 脚本、密钥、环境变量、原始提示词或执行输入输出。会话标识可展示，但跳转会话仍走原工作区/会话权限，报表角色不等于可以打开所有聊天。

租户管理员可查本租户全员记录；普通用户仅查本租户本人记录，不获取全员汇总。停用或解绑不隐藏仍然保留的本租户历史记录。现有外键会在删除 Hook 或执行记录时级联删除业务记录：本期不擅自改变删除语义，报表明确展示“当前保留记录”；若要求删除后仍保留历史，需另行确定保留期限及软删除/快照方案，不能承诺可恢复已删除的数据。

#### 3.5.1 会话记录后置行为：按不同 Hook 统计具体信息

本次新增的是对记录性 Hook 的细化，不另建第四个一级页签。当前UI实际名称为“记录数据”，其 `write_record.config.fields` 可以从事件、环境、脚本输出或前序行为结果提取值并形成结构化记录。本方案统计这些已写入的具体业务字段，而不是仅显示Hook执行次数，也不把会话全文重新交给模型推算。

分组主键使用 `(tenant_id, hook_id)`。Hook名称仅用于显示：两个同名Hook、两个使用相同record_type的Hook仍独立；同一Hook改名不变成新Hook。同一Hook有多个记录后置行为时，再按 `post_action_id + record_type` 拆分；不同版本字段含义或单位变化时分别展示，只有明确兼容的定义才可合并业务指标。

| 展示层 | 内容 |
| --- | --- |
| 不同会话记录Hook列表 | Hook名称/ID、记录条数、记录涉及用户数/会话数、最近记录时间、可用业务指标概览 |
| 单个Hook统计 | 按后置行为和记录类型查看本Hook的业务字段汇总、按日趋势、按用户分布；不会混入其他Hook |
| 单条记录详情 | recordId、executionId、记录时间、用户、工作区、sessionId、Hook及版本、后置行为ID、记录类型、允许展示的具体字段值 |

业务字段按下列方式配置，不强制所有Hook拥有同一组指标：

- 数值：明确指定求和、平均、最小、最大或只展示，标注单位；不自动聚合ID、状态码或所有数字。
- 布尔/枚举：可展示分类数量或占比，占比的有效样本数一并返回；缺失值单独说明。
- 文本/数组/对象：默认仅在授权明细中展示适配后的值；如需统计数组类别，明确“每条记录出现一次”还是“数组元素次数”。
- 累计快照值不能直接逐条求和。例如同一会话先记累计100行、后记累计150行，不能解释为产出250行；首期未明确业务键、去重规则和时间窗口前，仅展示，不启用总量汇总。

项目已有的SQL行数记录Hook作为首个实例：各记录展示SQL块数、行数、非空行数、语句数、语句类型及字符数；在明确其为每次输出记录的增量后，可按该Hook汇总行数/语句数。另一个Hook即使也使用sql_response_metrics，也在自己的列表行和详情中统计。其他Hook按实际配置字段适配，不预设其一定记录SQL。

记录条数按实际recordId计算，空对象记录仍计1，但没有业务字段指标；条件不满足而未写入则计0。去重会话使用可信的租户/工作区/用户/会话范围，缺少会话标识的记录仍计条数但不编造会话数。同一个会话被两个Hook记录时，各Hook分别计1个会话；租户汇总重新去重，不能将各Hook会话数直接相加。成功写入记录后其他动作失败，不撤销已写入记录，也不将整个Hook失败状态当作记录写入失败。

#### 3.5.2 字段定义与权限

在现有“记录数据”字段映射之外，拟增加可选 `reportFields`：字段key、展示名称、值类型、单位、允许的聚合方式及是否展示。由现有平台admin配置，纳入Hook发布版本；租户管理员只查看报表，不因此获得Hook配置权限。配置中的key必须引用已声明的记录字段，后端仅接受有限的聚合枚举和白名单字段，不执行客户端传入的SQL/表达式。

旧Hook可先由服务端 `hook-report-fields.js` 提供按Hook/版本/后置行为识别的显式适配；通用record_type适配仅在确认相同字段语义时复用，数据分组仍保留hook_id。未适配记录显示字段待配置，数值缺失、非法、被脱敏或被截断均不补0；统计响应携带有效记录数、缺失记录数和完整性提示。修改配置只影响新发布版本，不能用当前草稿解释旧版本字段。

### 3.6 Agent 模板使用记录

本项记录“谁在什么时间，将哪个 Agent 模板应用到哪个工作区”，并关联该模板来源工作区后续的会话活动。当前项目是新建工作区时应用模板，不是每发一条消息就重新调用一次模板，因此分开以下口径：

| 指标 | 口径 |
| --- | --- |
| 模板应用次数 | 周期内完成模板应用阶段并保存快照的工作区数，按 `workspace_id` 去重；一次应用计1，重连、继续聊天、刷新页面不新增 |
| 模板应用人数 | 上述应用记录的 `created_by_user_id` 去重数，不是模板作者数，也不拿工作区当前 owner 替代应用人 |
| 模板来源工作区活跃会话数 | 周期内该类工作区发生人工交互的去重主会话数，复用3.1；不要求模板也在本周期应用 |
| 模板来源工作区活跃用户数 | 上述会话的真实使用者去重数，不把其他成员的使用归给工作区创建人 |

“模板来源工作区活跃”只说明工作区的创建来源，不能证明每次运行仍完整使用原模板。用户可能修改 CLAUDE.md、Skill、Hook 等配置，不同 provider 也不一定加载同一套能力；首期不称其为“模板执行成功次数”，不估算模板带来的收益。

页面分为模板汇总与两类明细：

- 模板汇总：模板ID/名称、应用次数、应用人数、来源工作区活跃会话数/用户数、最近应用时间、最近交互时间。
- 应用记录：应用时间、应用人、工作区、模板应用时名称、模板当时更新时间、工作区当前状态。未聊天的工作区仍有应用记录，但活跃会话数为0。
- 关联会话：实际使用者、工作区、provider、会话标识、周期内首次/最近交互时间。点击进入会话仍校验原会话权限，不通过报表权限开放聊天正文。

时间筛选分别作用于应用记录的 `snapshot.created_at` 和会话的真实交互时间。例如8月应用模板、9月发起3个会话，9月的应用次数为0、来源工作区活跃会话数为3；不能先筛出9月应用的工作区再统计9月活跃。

当前没有 Agent 模板独立版本号。展示 `template_updated_at` 为“模板当时更新时间”，不伪造 v1/v2；以应用时保存的名称和快照为历史依据，不用模板当前名称/内容覆盖过去。快照证明模板应用阶段完成，不等于整个创建工作区请求成功；部分能力安装告警也可能留有快照。首期不做成功率、失败次数或“全部能力安装成功”承诺，不从缺失告警推断完全成功。

租户管理员可看本租户的应用和会话记录。普通用户的应用记录按本人 `created_by_user_id` 过滤，关联会话按本人会话 `user_id` 过滤，两者不能共用“工作区创建人”条件。全局可用或跨租户模板不意味着可以查看其他租户的使用记录。模板内配置了某 Skill/Hook 不代表其实际被调用，三类记录各自保留口径，不额外累加到原四指标。

## 4. 采集与索引流程

### 4.0 每日闲时调度与批次发布（本版主模式）

以下ENV为计划新增配置，本次仅写入方案；尚未修改 `.env.example` 或服务配置代码，当前设置这些变量不会自动生效：

```dotenv
AI_USAGE_ENABLED=true
AI_USAGE_RUN_AT=02:00
AI_USAGE_TIMEZONE=Asia/Shanghai
# 可选：默认建议窗口截至06:00，防止任务拖入工作时间
AI_USAGE_WINDOW_END=06:00
# 首期同一部署单个统计任务执行，租户分批处理
AI_USAGE_MAX_CONCURRENCY=1
```

`RUN_AT`与`WINDOW_END`使用24小时HH:mm，`TIMEZONE`使用明确的IANA时区；不依赖服务器/容器默认时区，不修改全进程TZ影响现有任务。支持跨午夜窗口时须按窗口起点的当地日期确定本次运行标识；夏令时地区同一当地日期最多一个计划任务，不存在的当地时刻顺延至当日有效时刻。首期直接支持每天固定时间，不要求用户填写cron表达式；复杂周/月计划后续再扩展。

配置在启动时校验，非法时间、时区、并发值必须报错且停用统计调度，不能偷偷回退到频繁执行；配置修改后重启服务生效。`ENABLED=false`停止新统计任务，保留历史可读报表。系统按固定“闲时窗口”执行，并不自动推断机器是否空闲。

常驻调度器可每30–60秒只检查时间与任务元数据，窗口外不枚举消息目录、不读取消息正文。日级计划唯一键、原子领取、持久租约及续租需专门实现，不能复用现有进程内activeRuns作为跨进程保障。

**白天做什么：**保持正常消息/JSONL、Hook业务记录、模板快照写入；新增Skill发布流水、绑定有效期和必要源变更标记仍在业务发生时保存，不能等到凌晨再猜身份。请求开始与最终响应完成的轮次身份/时间若无法从已有持久历史可靠恢复，需在业务入口/结束路径补存最小生命周期事实，不记录逐token统计，不扫描消息。白天不执行统计扫描、字段聚合或历史回填；轻量调度检查、权限校验及已发布报表查询可以运行。

**凌晨统计范围：**默认T+1，计划日D的02:00统计目标截止为D日00:00（不含），主要处理前一天和此前尚未处理的变化。例如9月12日02:00任务的目标截至9月11日结束；当天9月12日数据在下一次批次生成。任务同时固定 `sourceReadAt`（源读取依据）与 `targetThrough`（报表目标截止），不能用任务完成时间冒充统计截止时间。

任务流程：

1. 到达窗口后领取持久化任务，记录scheduledFor、targetThrough、租约及进度；以计划运行标识防重复，按可恢复的小批量处理租户。第一次上线的历史回填同样受窗口限制，不在服务白天启动时自动全扫。
2. 从上次持久化检查点读新增文件内容、发生变化的数据库消息及业务记录。不是每天重新解析全部历史，也不是只按消息时间筛“昨天”：新增的旧时间记录、停机遗漏和被修改记录均需处理。
3. 增量生成受影响租户/日期/指标分区，未变化分区继续复用。AI、Hook、模板的汇总及可见明细引用同一租户报表批次和冻结的字段定义，不能一个页签读新数据、另一个读旧数据。
4. 本租户本批次全部阶段完成并通过对账后，用短事务切换active_batch_id。部分阶段失败、超过窗口或中途重启时，不发布半成品，页面继续读上一完整批次；source coverage有缺口可发布明确标partial的完整处理结果，但不能标完整覆盖。
5. 到达WINDOW_END后不领取新工作，在安全检查点暂停，下一闲时窗口继续。运行中的单块解析/事务也需有有界资源预算，不能靠等待一个无限大任务结束实现“暂停”。任务运行过程中续租并使用领取令牌校验最终发布，过期Worker不可覆盖新Worker结果。

采集检查点与报表截止分别管理：02:00读取的源可能已包含当天消息，超过targetThrough的事实可以暂存，当天部分不进入本次报表；其中若有跨日轮次的完成依据，可用于闭合该轮并仅计入截止前的交集。下一计划日期推进后，即使源没有再变化，也必须构建新进入可见范围的日期分区，不能因已推进文件偏移而永久漏计这些消息。源版本依据按文件代次/已读取偏移、数据库会话generation等分别保存；单个sourceReadAt只是说明性时间，不承诺跨文件和数据库的全局事务快照。

**漏跑/重启：**窗口内启动可补领待处理任务；窗口外启动只登记待补，不立即重计算。比如03:00重启可继续，10:00重启则等待下一次02:00。补跑根据检查点追平全部遗漏，而不是只补最新一天；重启不会清空进度或重复累加。多个服务实例必须共享任务协调状态和可访问的数据源；若各自使用独立本地库，不能声称数据库锁能防跨实例重复，需要指定唯一调度实例或外部协调。

**晚到与跨日时长：**只有同一轮请求本身跨日，或该轮开始/完成记录晚到、被修正时，才可能需要修正已发布的历史时长。次日发起另一轮请求，不会补算上轮回复结束后的空闲。例如23:59发起、次日00:02完成，夜间将该轮3分钟拆为前一天1分钟、后一天2分钟；若某轮在02:00采集时仍未完成，先标待完成，取得可信终点后在后续闲时批次补算其实际覆盖日期。每次只重算真实受影响的全部日期，不固定最近1天或7天；超过窗口分批续算。源历史已被清理则标覆盖缺失，不用下一条消息或采集时间代替丢失的完成时间。

**页面表现：**显示“数据截至”“上次成功生成时间”“下次计划执行时间”，失败或积压额外显示统计延迟。默认日期范围结束于已发布批次的targetThrough；今天显示“尚未生成”，首次无成功批次显示“尚无统计数据”，均不显示为0。刷新只重新获取已发布结果，不触发重算。当前角色/租户状态仍实时校验，不能因数据T+1而将撤权延迟到次日。

### 4.1 Claude 原生 JSONL

1. 用 `session_index` 与 `agent_session_runtime` 取得可信的租户/用户/工作区/会话范围，定位 `runtime_home_path/.claude/projects`。不根据任意目录名推断租户，不将共享 runtime home 下所有文件归给当前用户。
2. 将现有脚本的纯解析与归属逻辑抽成共享模块，命令行脚本继续调用该模块，保留其当前输出契约。
3. 保存文件源身份、文件代次、字节检查点、最后完整行位置、大小与修改时间。只处理完整 JSONL 行，文件末尾半行留到下次，不推进到半行之后。
4. 新增长度时从检查点读取；截断、替换或已消费前缀变化时重新索引对应源。修改时间相同也不能作为文件永不变化的证明，定期做文件清单和指纹对账。
5. 消息 UUID 与工具调用 ID 做事实去重；文件已处理偏移与该批事实在同一 SQLite 事务提交。进程在提交前崩溃则重读，唯一键避免重复。
6. 读取 `display-commands.jsonl` 仅用于恢复用户命令，不能额外增加调用；读取 `subagents` 仅补充真实 Skill 调用，不增加个人会话/时长。
7. 同一 Claude 会话优先采用可读的原生历史。旧数据库副本不能无条件叠加；合并边界与覆盖情况需明确，复用现有历史加载和脚本规则。

所有统计扫描和源清单对账仅在4.0的夜间窗口执行，删除原60秒扫描/15分钟对账设置。每次任务发现源变化后按文件检查点读取；不为了分钟级新鲜度在白天监听并触发扫描。大文件流式处理，不调用会组装完整聊天展示对象的历史API。

### 4.2 其他 provider 的数据库消息

从 `agent_session_messages` 抽取已保存的标准消息，优先使用 `provider_timestamp` 表示业务时间；回填使用的 `created_at` 必须标为低可信来源时间。

在 `multitenancy-db.js` 的 `upsertSessionMessagesTransaction` 中，同事务标记该会话需要重算；在 provider session 绑定操作中同时移动/标记暂存会话范围。不要只依赖自增 ID 读取，因为现有消息会原位更新。

以源状态表的 `generation` 和 `processed_generation` 表示待处理情况。处理期间新增消息会提升generation；Worker只确认自己读取的旧generation，避免覆盖新变更。源快照与版本必须一致读取，结果过时则保留待下一闲时任务处理；不会因此触发白天实时重算。夜间固定的源版本和目标日期决定本次可见范围，后续变化进入下一批次。

首次接入、定期全量校验和人工回填均按已索引会话分批执行，覆盖未经过新标记逻辑的旧记录。没有明确 Skill 语义的 provider 不从 Bash/Read 文本推断调用；返回 coverage=unsupported 或 partial。

### 4.2.1 单轮响应时间依据（本次口径修正）

逐provider核验既有持久记录是否同时具备逻辑turn/request身份、用户请求开始时间及最终响应完成时间，不能因为存在消息时间戳就承诺可以准确计算。具备证据的源在夜间恢复轮次；缺少证据的新增请求，在业务入口生成/保存稳定轮次键，在最终响应结束路径补全同一键的完成时间与状态，采用幂等写入并标记变更，不需要MQ或实时聚合。

轮次来源适配需覆盖流式最终完成、失败/取消和服务中断；不能把socket断开、任意工具返回或Hook任务结束直接等同最终响应完成。中断后无法核验终点的记录保持未完成/未知，重启不按当前时间补结束。历史只有用户/助手文本、没有可靠轮次/结束语义时不强行按顺序配对；该指标独立标partial，不妨碍会话数、Hook和模板等证据充分的指标发布。

### 4.3 新增量的 Skill 身份关联

现有脚本主要输出 Skill 名称及调用人，不能直接当作发布者贡献统计服务。新增以下关联：

- 在导入、发布、别名修改、解绑等操作中记录本地名到远端 Skill ID 的绑定有效期。
- 市场 API 使用账号字符串，当前 `resolveAccountId` 来源是 `req.user.username`；本地 `users.id` 是数字，两者不能直接比较。保存 `publisher_account_id` 与经租户成员关系确认的 `publisher_user_id` 映射。
- 默认在夜间解析JSONL时，通过业务操作时已保存的绑定有效期关联调用。只有无法通过持久历史还原的运行期别名/动态绑定，才在工具调用入口补存最小身份元数据；这是事实留痕，不执行实时聚合，也不受UI可见性过滤影响。
- 不启用实时统计通知或实时索引消费者。夜间任务按同一逻辑调用键合并原生历史、必要的身份元数据及旧数据库副本。
- 历史绑定缺少有效期证据时，不把今天的绑定强加给过去记录；保留未归属调用。新发布后才开始捕获的范围可明确完整。

### 4.4 Skill 发布流水

改造共同服务层 `uploadAndPublishLocalSkill` 和 `publishMarketSkill`，覆盖 `/submit`、`/publish`、`/upload-publish` 等路由，避免仅改一个按钮入口。

远端市场与 SQLite 不能用本地事务一次提交。用发布流水承载 `prepared → saved → confirmed`，另有 `reconcile_required/failed`：

1. 调用远端前创建 operation_id、操作者及租户信息；前端重复提交复用幂等请求键。
2. 远端 save 返回 ID 后，先保存这个远端 ID 再执行 publish。
3. publish 明确成功后记录确认时间、Skill ID、发布者，更新本地绑定；计数只使用已确认且首次发布身份明确的记录。
4. 远端成功但本地提交失败/超时时，保留待对账状态，通过市场查询核验。远端查询不足以判断时标为待人工核验；不能盲目再次 save，也不能宣称具备跨系统 exactly-once。
5. 对“早已存在、首次在本地观测到”的远端 Skill，首次发布时间保持未知，不按本次观测时间当作新发布。

当前远端接口的首次发布时间、状态查询完整性、幂等支持没有通过真实环境验证，属于联调依赖。

### 4.5 Hook 记录查询与归属

Hook记录已经在运行时落库，不新增前端埋点、Hook事件队列或第二套业务采集。夜间任务复用已有数据库和字段映射读取源记录，生成分区化的白名单明细与业务汇总投影；前端查询已发布批次而非直接读当前源表。源读取强制以下规则：

1. 先限定 `records.tenant_id = req.tenant.id`，个人范围再限定 `records.user_id = req.user.id`；之后才能分组、计数、分页或关联 Hook 名称。不能先取全局记录再由前端过滤。
2. 同一个 Hook 可以绑定多个租户或全体用户，配置的可用范围不代表其所有记录都属于当前租户；现有全库 `hasDataRecords` 也不能直接作为租户报表判定依据。
3. 有历史记录的 Hook 按记录所属租户纳入；无记录项的可见范围复用实际的租户/用户/工作区绑定及发布版本规则，不能只看当前可编辑草稿。个人范围只返回本人可用项或本人历史项。
4. 历史记录 `tenant_id` 为空时不归入任意租户。只有能从可信执行/工作区关系唯一确定归属时，才进行可审计回填；无法确定的保留未归属状态，不能用用户今天的成员关系推断历史。
5. 夜间源读取直接从 `hook_data_records` 分页，页面列表从已发布明细投影分页；不要求执行记录和当前 Hook 的 `hook_id` 一致。现有历史迁移可能把业务记录迁到拆分后的 Hook，而保留原执行关联，INNER JOIN 严格匹配会漏记录。
6. 使用 `(created_at, id)` 稳定排序和服务端分页；避免仅返回最近 N 条再在浏览器计算总数。查询时间与 SQLite 历史时间字符串统一规范化后比较，确保 `[from,to)` 边界正确。

Hook汇总和详情使用同一已发布batchId下的报表投影。源记录在夜间按短事务/分批读取并保存版本依据，不把一个时间上界当作完整可重现快照；任务期间变化进入下一批次或按明确源版本重新处理。投影只保存批准字段与必要维度，不复制完整脚本/正文。源记录删除后的普通报表修正在下一夜间批次完成，业务访问撤销/敏感数据删除的禁止访问要求仍立即执行；不把批次快照变成永久保留被删除数据的借口。

针对本次“后置行为”统计，补充最小来源追踪：

- `hook_data_records` 已有hook_id，足够区分不同Hook；为准确识别同一Hook内部哪个后置行为写入，拟新增可空的 `post_action_id`、`hook_version`，以及 `record_source=post_action|script|system|unknown`，历史默认unknown。
- 修改 `hook-runtime.js` 的write_record分支，在一次业务记录INSERT中一并写入真实action.id、运行的Hook版本和post_action来源；脚本 `ccui.records.write` 标script，内置循环尝试等系统写入标system。来源元数据由服务端调用路径提供，不从用户data_json中的同名字段采信，不另发一条采集事件。
- “会话记录后置行为”视图默认统计已确认post_action来源；其他脚本/系统业务记录继续保留在原记录性Hook范围，不能因同record_type混入后置行为指标。历史来源未确认的记录单独显示数量和明细，不静默删除，也不冒充已确认来源。
- 旧记录可利用同租户/同工作区/同用户的执行关联，检查actions_json中明确返回的recordId来恢复actionId；确认对应输出recorded=true、对应发布配置中的action.type为write_record，同时核对执行所属Hook及可用发布版本。数据被截断、版本缺失或旧拆分迁移造成Hook不一致时，保持未知，不用当前配置或记录内容近似匹配。读取执行内容仅用于服务端核验，不能向报表返回完整actions_json。
- Hook版本已有 `hook_executions.hook_version` 和不可变 `hook_published_versions` 可复用；记录增加版本字段是固定新数据的写入依据，不是新建版本体系。历史无法核验版本时仍按hook_id统计记录条数，业务指标按已确认的字段定义决定是否可用。

字段汇总、按日趋势和按用户分布在夜间基于完整数据构建；白天对已发布的日汇总做有界筛选与合并，不能遍历源data_json或拿当前页的N条明细当总体。无法从既有汇总准确合并的去重/业务指标须预留专用统计依据，不能简单相加。记录分页仍按 `(created_at,id)` 稳定排序；请求参数可选择已授权的Hook/action/type/版本，不得覆盖服务端注入的tenant和self范围。

### 4.6 Agent 模板应用与会话关联

1. 应用记录以现有 `workspace_agent_template_snapshots` 为主表，JOIN `workspaces` 后强制 `workspaces.tenant_id = req.tenant.id`；快照本身没有 tenant_id。禁止根据模板的 `tenant_ids_json`、global_visible 或用户当前成员关系推断一次应用所属租户。
2. 按 `snapshot.created_at` 统计应用时间，按 `snapshot.created_by_user_id` 确定应用人，使用 `workspace_id` 作当前“一个工作区只能应用一次模板”的记录键。不用 workspace.updated_at 或 template_updated_at 充当应用时间。
3. 会话侧复用消息事实/日统计，经 `(tenant_id, workspace_id)` 关联快照；同样强制当前租户，并按会话真实用户过滤。仅关联应用后的业务交互，异常的应用前消息不归因模板。`session_index` 只提供会话归属，不能用行数或 updated_at 替代真实交互；统计索引尚未完成时显示待索引/部分覆盖，而不是0。
4. 分别聚合应用和会话后按模板ID合并，避免一条应用JOIN多条会话/消息导致应用次数膨胀。汇总行包含周期内有应用或有活跃的模板；名称从授权范围内的应用快照取得，不因模板已下架/删除而丢掉仍保留的使用记录。
5. 应用路径涉及文件写入与数据库，不能宣称一个 SQLite 事务覆盖整个操作。`saveWorkspaceSnapshot` 已在主要应用步骤之后写入，夜间统计复用该事实即可；不新加前端“点了应用按钮”的成功事件。未保存快照的失败尝试不计应用，历史失败/告警不完整则不补全。
6. 当前删除模板不级联删除应用快照；工作区常规删除为软删除，报表可保留应用记录并显示已删除状态，不开放原工作区。硬删除工作区或应用用户仍可能通过外键清掉快照，首期承诺“当前保留记录”；没有快照的历史不从目录名、CLAUDE.md 或已安装能力反推模板。

已有快照足以在夜间生成首期记录列表投影，无需扩展模板业务写入链路。白天页面只读取已发布投影，不直接加入刚生成的应用快照。若后续要求失败尝试审计、逐次运行的实际模板版本、重复应用/切换模板或删除后永久留存，再引入带operation_id的应用流水和运行时模板关联，不能提前把当前单条工作区快照说成完整事件历史。

## 5. 新增数据库结构

在现有数据库迁移入口引入 `server/database/ai-usage-schema.js`；数据访问使用可注入 database 的 `ai-usage-db.js`，便于临时库测试。工作线程使用服务传入的已解析数据库路径，直接打开连接，不导入会执行初始化/迁移的业务单例模块。主服务完成迁移后再启动 Worker。

| 表 | 关键内容与唯一性 | 用途 |
| --- | --- | --- |
| `ai_usage_batches` | batch_id、tenant_id、scheduled_for、target_through、source_read_at、状态、阶段进度、租约/领取令牌、发布/失败时间；计划标识唯一 | 持久夜间批次、防重入、断点续跑和发布状态 |
| `ai_usage_report_partitions` | tenant/dataset/date/partition_version及已发布批次引用；数据分区只读 | 发布清单复用未变化分区，原子切换active_batch_id，不每天复制全量历史 |
| `ai_usage_sources` | tenant/workspace/user/provider/source_key；JSONL检查点或数据库会话generation；coverage/error | 断点、待重算任务、覆盖监测 |
| `ai_usage_message_facts` | 完整会话范围、message_key、业务时间、角色、来源、策略版本；按范围+message_key唯一 | 保存无正文的交互依据，支持重算 |
| `ai_usage_turn_facts` | 完整租户/用户/会话范围、turn_key、request_key、started_at、response_completed_at、terminal_at、terminal_status、时间来源/可信度、口径版本、generation；范围+turn_key唯一 | 最小轮次事实；最终响应完成与失败/取消终态分别留痕，不提前决定后者是否计时；已有源夜间恢复，缺失时业务开始/结束路径幂等补存，不按逐token更新 |
| `ai_usage_session_days` | tenant/user/workspace/provider/session_key/stat_date；has_user_message、duration_ms | 日期关联与时长汇总；周期会话需重新去重 |
| `ai_skill_binding_history` | tenant/workspace/local_name/remote_skill_id、作者映射、valid_from/valid_to、证据 | 保存重命名、导入、解绑前后的真实归属 |
| `ai_skill_publications` | operation_id、request_key、remote_skill_id、publisher、首次发布时间及确认状态 | 发布操作恢复和首次发布统计 |
| `ai_skill_invocations` | 完整会话范围、subagent_id、tool_use_id、remote_skill_id、caller/publisher、occurred_at、归属状态 | Skill 调用事实与去重 |
| `ai_usage_export_jobs` | job_id、tenant_id、created_by、scope、filters、格式/字段版本、状态、租约、快照时间、产物路径 | 持久化异步导出 |

上述消息事实、发布流水和索引状态是内部处理依据，不直接暴露正在修改的工作结果。供页面读取的会话统计、Skill、Hook及模板结果按分区版本发布，Hook/模板白名单明细也必须可绑定batchId；物理表以各类型的查询索引为准，不将所有数据塞入一份大JSON。只重建变化分区，通过批次清单复用其他分区，避免夜间全量复制。旧分区在没有页面/导出引用且符合留存策略后清理；权限和法定/业务删除约束独立处理。

租户角色不新增表，使用现有 `tenant_users.role`。记录性 Hook 不新增业务记录表；按4.5补充后置行为来源/版本字段，并根据租户报表的查询计划补充以租户开头的索引：

```text
hook_data_records(tenant_id, created_at DESC, id DESC)
hook_data_records(tenant_id, hook_id, created_at DESC, id DESC)
hook_data_records(tenant_id, user_id, created_at DESC, id DESC)
```

现有索引以 hook_id 开头，不能替代全租户时间筛选所需的前缀。索引在 `hook-config-schema.js` 的幂等迁移中添加；按真实查询 EXPLAIN/压测确定是否还需工作区或记录类型索引，不一次性建立所有组合。

Agent 模板复用已有快照表和 `workspaces(tenant_id, owner_user_id)` 索引；应用查询按工作区关联，活跃查询复用统计表。以实际 EXPLAIN 为依据，在 `multitenancy-schema.js` 的幂等迁移中按需增加 `workspace_agent_template_snapshots(created_by_user_id, created_at, workspace_id)` 与 `(template_id, created_at, workspace_id)`；首期不新建 `ai_template_usage_events`，不重复保存模板正文、资源内容或密钥。

必要索引：

```text
ai_usage_session_days(tenant_id, stat_date, user_id)
ai_usage_session_days(tenant_id, user_id, session_key, stat_date)
ai_skill_invocations(tenant_id, publisher_user_id, occurred_at)
ai_skill_invocations(tenant_id, remote_skill_id, occurred_at)
ai_skill_publications(tenant_id, publisher_user_id, first_published_at)
ai_usage_export_jobs(tenant_id, created_by, created_at)
```

消息/轮次事实不保存提示词、回复正文或调用参数。会话活跃由消息事实判断，时长由符合口径的轮次区间计算，不能将两者混为相邻消息跨度。日聚合使用用户/会话范围的幂等覆盖，不用无条件 `+=` 重复累加；重算识别新旧日期分布，修复全部受影响日期。轮次开始/完成事实及其变更标记同事务保存，夜间处理只确认已读取generation，避免漏掉处理中到达的完成更新。

夜间提前生成常用用户/Skill/Hook维度的日汇总及会话去重依据；白天查询固定批次的小型汇总分区和分页明细，不重读原始JSONL或遍历全量data_json。周期会话数仍按会话身份重新去重，不能加总日去重数。任意新业务字段/复杂聚合需进入下一夜间构建或闲时专用任务，不能由页面请求同步触发全量计算。

任务在独立线程中处理，大文件流式读取、事实写入小批事务。SQLite 一个库的写竞争仍存在：上线前检查实际 journal_mode 与锁等待，用负载测试确定是否启用 WAL/配置 busy_timeout，不能在方案中声称项目已启用 WAL。

## 6. 接口与权限

新增统一路由 `server/routes/ai-usage.js`，挂载：

```js
app.use('/api/ai-usage', authenticateToken, tenantContext, aiUsageRoutes);
```

| 接口 | 行为 |
| --- | --- |
| `GET /api/ai-usage/capabilities` | 当前租户允许的 self/tenant 范围、Hook / Agent模板报表可见性与导出能力；前端据此显示入口 |
| `GET /api/ai-usage/status` | 当前租户已发布batchId、dataThrough、lastSucceededAt、nextRunAt、任务状态/延迟；权限实时校验 |
| `GET /api/ai-usage/overview` | 四个核心指标及覆盖状态 |
| `GET /api/ai-usage/trend` | 按日趋势，支持所选单一指标 |
| `GET /api/ai-usage/users` | 平台 admin / 当前租户管理员查看全员汇总；普通用户拒绝访问 |
| `GET /api/ai-usage/users/:userId` | 平台 admin / 当前租户管理员查看本租户指定用户；普通用户只可查本人 |
| `GET /api/ai-usage/skills` | 已发布Skill及其调用，归属与页面scope一致 |
| `GET /api/ai-usage/hooks` | 当前授权范围按Hook独立汇总；支持时间、用户、工作区、记录类型和recordSource筛选 |
| `GET /api/ai-usage/hooks/:hookId/statistics` | 当前Hook各后置行为/类型/字段定义版本的业务指标、按日趋势和用户分布，附安全字段定义及覆盖情况 |
| `GET /api/ai-usage/hooks/:hookId/records` | 同一授权范围内业务记录分页；支持postActionId、recordType、hookVersion、recordSource；返回白名单DTO |
| `GET /api/ai-usage/agent-templates` | 授权范围内的模板汇总；应用与会话分别按所选周期统计 |
| `GET /api/ai-usage/agent-templates/:templateId/records` | 模板应用记录分页；self按应用人、tenant按工作区所属租户过滤 |
| `GET /api/ai-usage/agent-templates/:templateId/sessions` | 模板来源工作区的活跃会话分页；self按实际会话使用者过滤，只返回报表元数据 |
| `POST /api/ai-usage/exports` | 校验后返回202与job_id |
| `GET /api/ai-usage/exports` | 当前租户、当前请求者的任务列表 |
| `GET /api/ai-usage/exports/:jobId` | 当前请求者任务状态 |
| `GET /api/ai-usage/exports/:jobId/download` | 再校验租户、创建者、当前权限、完成和有效状态后下载 |

使用项目现有 camelCase 请求风格：`tenantId`、`from`、`to`、`scope=self|tenant`、`workspaceId`、`provider`、`search`、`page`、`pageSize`、`sortBy`、`sortDirection`。时间为带时区ISO，区间统一 `[from,to)`。

页面首期按配置的业务时区使用完整日期边界，默认Asia/Shanghai，最大可选结束时间为已发布批次的dataThrough。请求超出覆盖范围须明确返回尚未统计的区间或校验错误，不能静默补0。首期不开放会引发白天重算的任意小时/分钟统计。calculationVersion标识口径，indexedThrough为来源已核验范围，不是HTTP响应生成时间，也不能与目标截止dataThrough混为一谈。

tenantId 可以来自现有前端租户切换，必须经过 tenantContext 校验；这与之前“前端不能传tenantId”的通用建议不同。身份userId取登录态；普通用户请求tenant范围应403，而不是信任前端隐藏按钮。报表路由另外确认租户状态为active：当前 tenantContext 主要检查成员状态，不能把它描述成已完整校验租户状态。

### 6.1 租户管理员权限模型

| 用户类别 | 身份依据 | AI / Hook / Agent 模板报表范围 | 平台管理功能 |
| --- | --- | --- | --- |
| 平台 admin | `users.is_system_admin` | 显式选择的租户；每次查询仍限定 tenantId | 保留现有权限 |
| 租户管理员 | 当前有效 `tenant_users.role = 'tenant_admin'` | 该租户全员，可切换本人视角 | 不开放 |
| 普通用户 | 当前有效成员关系，非上述管理员 | 该租户本人 | 不开放 |

新增统一 `ai-usage-access.js`，从当前有效成员关系计算 `canReadTenantUsage`，不信任请求体中的 role/userId，也不以 JWT 内的旧角色作为唯一凭据。系统管理员仍必须由 `is_system_admin` 判断；成员表的内部 `system_admin` 字符串不能单独授予平台权限。接口的全部查询、分页总数、筛选候选项、详情和导出复用同一范围对象，避免列表有租户条件而详情漏掉。

`tenant_admin` 只新增报表能力，不改变现有 `permission=view/edit`、工作区 ACL、Hook 配置/启停权限、成员管理或平台设置权限。报表需要的用户/工作区名称通过只读、租户限定的筛选接口/响应提供，不放开现有管理接口。

Agent 模板记录同样返回白名单 DTO；不返回 `agent_markdown`、`guide_text`、各能力快照JSON、资源文件内容或配置凭据。查看报表不授予模板编辑、发布、下架或查看其当前完整配置的权限。

### 6.2 角色设置与兼容

由现有平台 admin 在租户成员界面设置“普通成员 / 租户管理员”。复用 `PUT /api/admin/tenants/:tenantId/users/:userId`，例如对已有成员提交 `{ "role": "tenant_admin" }`；撤销提交 `{ "role": "member" }`。不开放租户管理员自行提权、任命其他管理员或管理其他成员。

需要同步修复两处兼容逻辑：`adminPanelUtils.ts` 的 `buildTenantMembershipPayload` 当前写死 `role: 'member'`，`admin.js` 的 `upsertTenantUserAccess` 当前对缺失 role 默认 member。改为新建成员才使用默认值，更新时缺省字段保持原值，前端只发送用户明确修改的角色；普通的 view/edit 调整、状态调整及批量操作不能意外撤销/授予管理员。单项/批量外部请求只允许赋予 member、tenant_admin；内部系统 admin 自动成员逻辑独立保留。

角色按 `(tenant_id,user_id)` 保存。A 租户管理员进入 B 租户时，以 B 的成员关系重新授权。切换租户或接收到403时刷新 capabilities 并清空旧数据；角色撤销后的下一次请求必须拒绝 tenant 范围访问，导出执行与下载也重查当前数据库权限。

用户列表从当前租户成员出发 LEFT JOIN 统计，以显示0使用用户；已退出用户的历史事实保留，是否展示历史成员可作为单独查询约定。共享工作区owner不等于会话使用者，必须按真实会话/调用归属。

响应携带：

```text
tenantId, scope, from, to, timeZone, batchId,
generatedAt, dataThrough, lastSucceededAt, nextRunAt,
sourceReadAt, indexedThrough, calculationVersion,
coverage: complete | partial | unavailable | unsupported
```

coverage按指标/provider返回。来源缺失时显示“部分记录”或“未接入”，不能将未知等同于0。不得把按用户相关的partial信息转换为全租户敏感明细给普通用户。

进入报表先获取status，再携带同一batchId读取各页签/详情；批次在短暂刷新期间更新也不会造成不同接口混用。页面请求不创建统计任务，没有默认“立即重算”入口；管理员如需人工补跑，首期使用受控运维入口且默认仍遵守闲时窗口。

## 7. 前端落点

- 新增 `src/components/ai-usage/AiUsagePage.tsx` 和可复用 `AiUsagePanel.tsx`。
- `src/App.tsx` 增加 `/ai-usage`，普通用户默认当前租户本人；平台 admin / 当前租户管理员可选择当前租户全员范围。保留 `/admin` 的平台管理员门禁，租户管理员从独立报表入口进入。
- `SidebarFooter.tsx` 及相关props/controller增加“AI使用统计”入口，沿用现有租户切换和返回方式。
- `AdminPanel.tsx` 的统计区域保留原平台概览，新增“AI使用”子视图，复用同一Panel，避免两套数字口径。
- 复用 `src/shared/view/ui` 的Button、Input、Dialog、Card以及现有主题。趋势可复用现有统计页的SVG模式，无需为这几张图强制新增大图表库。
- `src/utils/api.js` 新增 `api.aiUsage`，复用authenticatedFetch。admin单独选择租户时显式传该租户，不能被localStorage中的租户覆盖。
- 新增中英i18n文案，核心术语统一为“会话次数 / AI活跃时长 / 发布Skill数量 / Skill被调用次数”。
- `AdminPanel.tsx` 的租户成员编辑区增加租户角色选项，成员列表显示角色；角色与原 view/edit 权限分开展示。

组件建议：`UsageFilters`、`UsageMetricCards`、`UsageTrend`、`UserUsageTable`、`UserUsageDrawer`、`PublishedSkillList`、`HookReportTab`、`HookSummaryTable`、`HookRecordsDrawer`、`AgentTemplateUsageTab`、`AgentTemplateUsageTable`、`AgentTemplateRecordsDrawer`、`ExportJobDialog`、`ExportJobList`。

同一报表页设置“AI 使用与共创 / 记录性 Hook / Agent 模板使用”三个页签。Hook 页签保留时间、用户、工作区筛选，增加 Hook、记录类型筛选；原四指标页继续保留 provider 筛选。Hook 记录表没有 provider 字段，Hook 页签不显示该筛选，不能保留一个实际不生效的控件。

Hook 页签上方展示记录条数、产生记录用户数/会话数，下面为按hook_id独立的Hook汇总表。增加“会话记录后置行为”来源筛选，进入单个Hook后展示后置行为/类型/版本选择、该Hook业务指标、按日趋势、按用户统计和记录明细。未知来源/字段单独提示，不将两个同名Hook或同类型Hook混在一起。借用现有业务记录弹窗的视觉样式，但单独实现报表只读组件，不直接挂载带有发布、删除、绑定等操作的整个 `HookConfigsTab`。页面明确标注“业务记录，非执行次数”，历史数据标注保留范围。

Agent 模板页签展示3.6中的四项分区指标及模板汇总表，点击打开“应用记录 / 关联会话”明细。筛选支持日期、模板、用户、工作区；“用户”在应用区指应用人、会话区指实际使用者，标签明确说明。provider仅在关联会话区显示并生效，不影响应用次数。应用数据可以先上线，关联会话区等待共享统计索引就绪；此时显示待索引，不填演示数字。

时间、用户、工作区、provider改变时，概览、图表、表格和导出参数同步。切换租户取消旧请求并清除旧缓存，拒绝迟到响应覆盖新租户；缓存键包含tenant/user/scope/filter。不存在的部门筛选不保留。

缓存键另外包含batchId与calculationVersion。页面显著显示“非实时，数据截至××，每日02:00开始统计”（时间从配置/接口取得，不写死文案）；02:00是开始时间，不承诺此时已生成。今日数据、首次未统计、任务失败或延期分别展示明确状态。刷新只重新获取已发布批次，不触发扫描。夜间生成期间仍使用旧完整批次。

当前会话中的原型仅供布局参考，存在日期筛选未联动、两种视角示例数字不一致等问题；正式实现统一数据来源后重做联动验收。

## 8. 异步导出

全部采用数据库任务 + 后台Worker，创建不直接下载，状态为 `queued/running/succeeded/failed/expired`。任务记录租约，服务重启时恢复超过租约的running任务；不能复用Top Skill任务的纯内存Map作为存储。

首期产物使用服务受控数据目录，如由数据库目录解析的 `analytics-exports/<tenantId>/<jobId>/`，不放public或用户工作区中；下载路由根据job_id取内部路径，不接受客户端任意文件路径。无需先搭对象存储。

导出绑定用户提交时正在查看的已发布batchId、dataThrough和字段定义版本；使用该批次的不可变分区流式生成文件，不扫描原始消息，不重新计算当日数据。导出任务持有分区引用，避免文件生成前其依赖被清理。生成期间不持有长写事务，临时文件原子更名完成后才标succeeded。

本版为非实时统一批次，batchId必须对应真实可保留的结果，不能仅保存一个没有数据版本依据的字符串。普通导出可白天异步生成，因为只读现成报表结果，并不触发统计；大导出低优先级限并发，必要时排队到闲时。统计调度时间不自动等同所有下载必须等到凌晨。

导出字段、CSV/Excel等格式尚未决定。任务层只预留 `export_schema_version` 与serializer，不将某种格式当成已确认需求。任务列表轮询即可，后续可用现有WebSocket通知；刷新页面仍能找到任务。实际启用提交入口需要配置明确的导出字段集。

角色扩展后导出遵守相同可见范围：平台 admin / 当前租户管理员可提交当前租户报表任务，普通用户只可提交本人范围；仍默认仅创建者可查看和下载自己的任务。增加 `reportType=ai_usage|hook_records|agent_template_usage` 区分报表，Hook 汇总还是明细、模板汇总/应用记录/关联会话及具体字段仍待讨论，不能默认导出全部 JSON。任务创建、执行、下载均验证当前角色，降级后不能继续生成或下载原租户级任务。已下载到本地的文件无法远程收回。

Hook导出任务保存hookId、postActionId、recordType、hookVersion、recordSource及统计字段定义版本；多Hook导出也必须保留来源维度，不能把不同Hook的同名字段无标识地拼成一列或相加。字段配置与数据均按所选已发布批次固定，具体文件组织仍待议。

## 9. 文件级实施清单

以下“新增”均为计划文件，本次只更新本方案文档，不改功能代码。

| 文件/模块 | 改动 |
| --- | --- |
| 新增 `server/database/ai-usage-schema.js` | 统计表、批次/租约、分区版本及发布指针、唯一约束、索引 |
| 新增 `server/database/ai-usage-db.js` | 可注入连接的数据访问层 |
| 新增 `server/services/ai-usage-config.js`、`.env.example` | ENV默认值/校验、每日时间/独立时区/窗口结束/并发配置；此处仅计划，未实际编辑.env |
| 新增 `server/services/ai-usage-scheduler.js` | 计算窗口和下次运行时刻、持久任务领取/租约、漏跑补偿；禁止窗口外启动统计 |
| 新增 `server/services/ai-usage-batches.js` | 阶段编排、受影响分区构建、校验与原子发布，失败保留旧批次 |
| `server/database/db.js` | 迁移入口，向任务传递真实数据库路径 |
| `server/database/multitenancy-db.js` | 落库消息同事务标记变更、会话绑定迁移；成员角色更新的缺省保留与兼容 |
| `server/routes/admin.js`、`src/components/admin/adminPanelUtils.ts` | 平台 admin 指定租户角色，单项/批量更新校验，避免修改其他权限时重置角色 |
| 新增 `server/services/ai-usage-access.js` | 当前租户报表能力与统一查询范围，导出执行/下载复核 |
| `server/database/hook-config-schema.js` | Hook记录来源/后置行为/版本字段和租户前缀索引，历史默认unknown的幂等迁移 |
| `server/services/hook-runtime.js` | 原业务记录INSERT内补真实来源、actionId和Hook版本；区分后置行为、脚本和系统写入 |
| `server/services/hook-configs.js`、Hook字段编辑及类型文件 | 可选reportFields校验/保存/发布，维护记录映射与统计定义；现有Hook保持兼容 |
| 新增 `server/services/ai-usage-hook-query.js` | 按Hook独立汇总、后置行为来源筛选、动态业务字段聚合/趋势/用户分布、记录分页和历史归属核验 |
| 新增 `server/services/hook-report-fields.js` | 按Hook/动作/版本识别的字段白名单、名称/单位/聚合项及旧类型显式适配 |
| 新增 `server/services/ai-usage-template-query.js` | 模板应用汇总/分页、会话关联、双重用户归属、历史名称与删除状态 |
| `server/database/multitenancy-schema.js` | 根据查询计划补充模板应用快照索引；不新增模板事件表 |
| 新增 `server/services/ai-usage-parser.js` | 从现有脚本抽出无副作用的消息/工具识别 |
| 新增 `server/services/ai-usage-turns.js`、各provider请求生命周期接入点 | 核验/保存稳定轮次身份与开始/最终响应完成时间，区分状态和覆盖；已有持久源优先，缺失部分补最小事实，不逐token计算 |
| 新增 `server/services/ai-usage-indexer.js` | JSONL检查点、DB变更源、历史索引与覆盖检测 |
| 新增 `server/services/ai-usage-worker.js` | 仅窗口内统计、检查点安全暂停/续跑；导出读取已发布批次并低优先级限并发 |
| 新增 `server/services/ai-usage-query.js` | 指标、列表、趋势共同口径 |
| 新增 `server/services/ai-usage-exports.js` | 持久任务、serializer、恢复和产物生命周期 |
| 新增 `server/routes/ai-usage.js` | 权限、参数、范围、导出下载 |
| `server/index.js` | 路由注册；迁移后启动轻量调度器，不启动全量扫描；shutdown保存进度并停止 |
| `server/claude-sdk.js` | 仅补已有持久历史不足的调用身份及轮次开始/最终响应完成依据，不做实时统计，不依赖UI可见性；准确结束边界接入时核验 |
| `server/services/skill-market.js` | 发布流水，导入/发布/解绑绑定历史 |
| `scripts/tenant-skill-usage.mjs` | 保持原CLI契约，改用共享解析器；当前未提交变更须保留 |
| 新增 `scripts/backfill-ai-usage.mjs` | 指定租户、区间、dry-run、断点回填 |
| `src/App.tsx`、侧边栏、`AdminPanel.tsx` | 页面入口及复用面板、租户角色选择；不扩大 AdminPage 门禁 |
| 新增 `src/components/ai-usage/*` | 统计与导出组件、hooks、类型 |
| `src/types/app.ts`、`src/contexts/TenantContext.tsx` | 租户角色类型与切换刷新；服务端 capabilities 为实际能力依据 |
| `src/utils/api.js`、i18n文件 | 请求封装、报表角色、记录性 Hook、模板应用/来源工作区活跃文案 |
| 新增报表权限、Hook / 模板查询与角色更新测试 | 多租户隔离、降级、应用人/会话使用者区分、计数、分页、敏感字段过滤与历史兼容 |

## 10. 交付顺序与验收

1. 高保真评审：沿用当前项目样式，先补全租户管理员视角、四指标、记录性 Hook 和 Agent 模板汇总/明细；测试数据明确标注且筛选联动一致。按此前要求，页面评审后再决定正式功能实施。
2. 权限底座：tenant_admin 设置、统一报表授权、旧成员编辑兼容，先测跨租户与降级。
3. 调度与批次底座：ENV校验、时区/窗口、任务租约、增量检查点、失败保留旧结果和原子发布；先用临时fixture验收，不在白天触发真实历史扫描。
4. Hook / 模板与AI数据底座：复用源记录/快照，构建共享解析器、分区投影、夜间索引器与覆盖报告；分模块联调后统一批次发布。
5. 发布与归属：发布流水、绑定历史、作者映射；联调远端接口的成功/超时/重试场景。
6. AI 查询和页面：四指标、趋势、用户详情、模板来源工作区活跃与关联会话、筛选联动接入真实接口。
7. 异步导出：持久任务、受保护产物、重启恢复；字段确定后接serializer。
8. 上线回填：运行目标部署机器上的只读预检，确认auth.db与runtime目录均可读，再按租户分批回填；未验证的历史显示覆盖范围。

关键验收用例：

- 同一Claude Skill记录在实时流、JSONL、旧DB副本中存在时只计一次。
- 同一请求的斜杠提交和Skill工具记录不能简单加成两次；不能按同名误合并两次真实调用。
- 子代理Skill归属正确，不增加个人会话数和时长。
- 10:00请求/10:02完成、10:30请求/10:33完成，时长为5分钟而非33分钟；隔夜发起新请求不补算两轮之间的空闲。
- 单轮23:59请求/次日00:02完成，时长为3分钟，按日期分为1分钟与2分钟；不对单轮设置时长上限。
- 同一轮多段流式回复/工具调用只计一个请求到最终响应区间；仅有请求、缺少可信终点或轮次关联时标pending/partial，不补0、不用下一条提问封口。
- 轮次完成更新在夜间处理期间到达时不会被旧generation确认覆盖；重复结束通知幂等，历史修正同步清除旧日期贡献。
- 同会话并发请求仍按各自稳定轮次键匹配，重试/重连不重复生成同一逻辑轮次；是否合并重叠时长待口径确认。跨截止时间的已完成轮次取区间交集，不能按完成日期过滤掉整轮。
- 自动任务和Hook内部消息的来源分类可解释。
- 当前Skill被重命名、重新绑定，不能改写已确认的历史作者归属。
- 新发布成功一次、更新版本多次、导入多个工作区，仅累计一个首次发布Skill。
- JSONL末尾半行、文件替换、断点前后崩溃、晚到旧消息均不静默漏计或重复。
- 多provider来源不足时显示partial/unsupported，而不是虚假的完整零值。
- 平台 admin 指定租户；A租户管理员在B租户为普通成员时不能读取B全员报表，不能访问平台管理接口。
- 同租户普通用户跨用户查概览、Hook明细、分页总数、筛选候选项或下载他人导出均按权限拒绝。
- 成员view/edit或批量状态调整不改变既有角色；角色单独更新不改变工作区权限；disabled/pending成员、停用租户不能读取报表。
- 一个Hook同时绑定A/B租户、全员默认启用时，汇总和详情都只统计当前租户记录；tenant_id为空不能泄漏到任意租户。
- 一次Hook执行产生两条业务记录时，记录条数为2；执行失败但已落库的记录仍可查，不冒充成功执行统计。
- 记录已迁移到拆分Hook、配置已解绑、用户已退出但记录仍保留时，不因关联方式错误漏记录。
- 未知record_type只返回安全元数据；明细/导出都不能包含未允许字段、脚本或密钥。
- SQL指标记录被截断、缺字段或类型错误时，业务指标显示部分覆盖，不把缺失当0；不影响有效记录条数。
- 两个同名Hook或两个相同record_type的Hook在列表、业务统计、明细和导出中独立；同Hook改名不增加一个统计对象。
- 同Hook内两个write_record行为分别产生同类型记录时，按actionId分开；脚本或系统写入不混入已确认后置行为统计。
- 相同字段在不同Hook/版本中单位或含义不同，不自动求和；同会话两条累计快照100/150不能作为250的业务产出。
- 同一会话被两个Hook记录时，各Hook会话数为1，租户去重会话数仍为1；统计结果不依赖当前分页大小。
- write_record条件不满足不新增业务记录；空对象写入计1条但不生成业务指标；旧记录action/来源不可恢复时明确unknown。
- reportFields不接受任意SQL/表达式，不暴露未批准字段；历史版本字段定义不会被当前草稿覆盖。
- 一个模板应用到一个工作区并发起5个会话：应用次数为1、活跃会话数为5；不能把二者相加或把每条消息算一次应用。
- 应用发生于上月、会话发生于本月：本月应用次数为0，活跃会话仍可统计；模板应用之前的异常消息不归因。
- A创建模板工作区，B在授权共享工作区聊天：应用归A、会话活跃归B；个人接口和导出不能串用归属条件。
- 全局模板被两个租户使用时，汇总、应用明细和会话明细全部租户隔离；可见模板目录不能替代记录授权。
- 模板重命名/删除不改写仍保留快照的历史名称；工作区软删除仍展示历史记录；缺失快照显示不可追溯，不反推填充。
- 模板部分能力安装失败仍保存快照时，只证明已应用，不标成全部安装成功；创建请求在快照保存后报错不反向抹掉已发生应用。
- 模板配置内有Skill/Hook但未调用时，不增加对应调用/业务记录数；应用表JOIN多条消息不会重复计数。
- 切换租户后旧响应不能覆盖当前页面；已撤销权限的任务不能继续下载。
- 导出过程中源数据变化不会混成多个快照，任务重启恢复后结果不重复。
- 索引任务运行时测量聊天流响应延迟、SQLite锁等待及导出队列，调度参数由测量确定。
- ENV设02:00与Asia/Shanghai而容器默认UTC时，仍在北京时间02:00执行；重启、时钟回拨或多个tick不重复领取同一计划任务。
- 白天刷新、筛选、查看Hook新记录或提交导出不触发源扫描；三个页签引用同一已发布batchId，今日数据不伪装成0。
- 窗口内03:00重启恢复检查点，窗口外10:00重启不立即重算；漏跑多天在下一窗口追平全部变化。
- 超过窗口安全暂停并保留进度，下一窗口继续；任务中途失败或租约过期不能发布半成品/覆盖新的领取者结果。
- 夜间仍只解析新增完整行和变更源，不每天复制/解析全部历史；晚到轮次边界和跨多日单轮时长修复全部实际受影响日期，不把轮间空闲补入历史。
- 02:00源中已有当天消息时，本批次不展示；下个计划日期即使文件无新增，也能正确纳入此前暂存的当天事实。
- 夜间发布新批次时已提交导出仍读原批次；敏感删除/权限撤销不会因统计快照而延迟禁止访问。

已确认时长主口径：逐轮请求到最终响应完成累计，不计轮间空闲、不设单轮时长上限。仍需业务最终确定：失败/取消/等待人工确认及并发轮次的计入策略、调用人还是发布者归属（本版推荐发布者）、自动任务是否进入个人指标、导出字段/格式。Hook 的具体业务展示字段按记录类型适配；首期只承诺展示当前保留记录，若需要删除后历史留存或纯脚本零记录项展示，另行确认相应扩展。历史轮次边界、首次发布时间与作者映射能否补全属于代码和市场接口核验事项，不能用估算填充。
