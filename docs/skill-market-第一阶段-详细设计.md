# 技能市场第一阶段 · 详细设计

更新：2026-09-15。性质：结合当前仓库的待实现设计；下文新增模块、接口、表及策略均为建议契约，不是已接入能力。

范围以[功能说明](skill-market-第一阶段-功能说明.md)为准。原型入口：[phase1.html](prototypes/skill-market/phase1.html)。不改变远端 data-agent 协议，不新增模板、贡献、角色管理和发布工作流。

## 1. 当前代码事实与差距

| 已查看的代码 | 可复用基础 | 本期需要补充 |
| --- | --- | --- |
| `src/components/chat/view/ChatInterface.tsx` | 会话状态、消息流、重连恢复、输入与发送编排 | 按会话保存创建意图、创建任务事件映射、生成目标绑定 |
| `src/components/chat/view/subcomponents/ChatComposer.tsx` | PromptInput、输入框、底部能力按钮、发送/取消 | 技能创建 toggle、aria-pressed、描述 placeholder、112px 最小输入高度；不展示 name 字段 |
| `src/components/chat/view/subcomponents/MessageComponent.tsx` | 既有消息及内容呈现 | 完整 Skill 调用下的保存用例入口；复用渲染器展示测评输出 |
| `src/components/skills-market/SkillsWorkspacePanel.tsx` | 我的技能、文件树、读取/编辑、工作区刷新 | 本地测评页、片段入口、快捷插入；不在本期扩充模板/贡献页 |
| `server/routes/workspace-skills.js`、`server/services/workspace-skills.js` | 工作区技能文件接口、根清单诊断、`.claude/skills` 路径 | evals 特殊校验、文件提交一致性、任务触发与访问校验 |
| `server/services/workspace-access.js` | 工作区授权基础 | 所有新入口复用，不以 UI 按钮隐藏替代鉴权 |
| `server/services/top-skill-jobs.js` | 按用户/租户/工作区限定的异步任务模式 | 当前任务在内存 Map，不能承担重启恢复；新增持久化任务仓库 |
| `server/services/agent-graphs.js` | generateTopSkill / optimizeTopSkill、Claude runtime 调用 | 抽取可复用 CreatorAdapter，不直接借用 Agent Graph 的产品接口与领域模型 |
| `server/skills/skill-creator/SKILL.md` | 当前仅要求返回 SKILL.md，固定 Role 等正文段落 | 补充文件化创建契约和测评适配；不能声称当前已生成 evals/evals.json |
| `server/services/agent-graph-claude-runtime.js` 等 runtime 服务 | 运行环境准备与生命周期 | 测评最小权限、清洁输入投影、独立评审环境及工具/子任务证据收集 |

额外注意：当前 `agent-graphs.js` 创建调用使用无工具、单轮、非持久会话的 SDK 配置，并存在鉴权缺失时返回固定内容的 fallback。第一阶段生产创建不允许把这种降级伪装成真实 AI 成功；鉴权失败必须报错。动态测评也不能直接复用 `tools=[]` 的调用配置，否则无法验证工具、subagent 和文件场景。

## 2. 模块划分与调用边界

建议在 CCUI 内形成以下服务，名称是新建建议：

| 模块 | 输入 / 输出与职责 |
| --- | --- |
| SkillCreationService | 接收显式创建意图，任务幂等、同名占位、调用 CreatorAdapter、发布本地文件结果 |
| CreatorAdapter | 加载仓库 skill-creator 指令、用户描述、公共片段参考；输出待校验 Skill 包，不自行覆盖用户目录 |
| SnippetService / Repository | 全平台只读目录、管理员 CRUD、正文安全边界、内部并发摘要 |
| EvalFileService | 读取/校验/原子更新唯一用例文件，管理附件、防重复、已发布用例保护 |
| EvaluationOrchestrator | 静态检查，严格串行调度，运行全部/优化编排，停止、超时、重连 |
| IsolatedRunner | 单用例执行环境；等待主 Agent、工具及 subagent 完成；收集完整可见证据 |
| RuleGrader + AIReviewer | 确定性验证与独立模型评审；输出证据引用，不执行不可信结果中的指令 |
| SkillOptimizer | 读取前测与固定目标，仅修改 Skill 允许文件；交给文件服务校验并自动提交 |
| JobRepository / ReportStore | CCUI 本地数据库任务元数据及受控报告存储；不把报告塞进用例 JSON |

调用顺序：会话 UI → 创建服务 → 片段参考 + CreatorAdapter → 文件服务 → Workspace；测评 UI → 编排器 → 静态检查 → Runner → Grader → 报告。自动优化在完整前测后加入 Optimizer 和文件提交，再复用同一条全量串行链路。

UI 沿用现有会话消息组件，不创建第二套聊天系统。生成子任务的事件归属当前会话；测评任务是后台任务，不创建可见聊天、不导航会话页面。

## 3. 会话创建状态与请求契约

### 3.1 输入状态

建议在 composer hook 中按 `workspaceId + sessionId` 保存：

```ts
type SkillCreationDraft = {
  intent: 'chat' | 'create-skill';
  description: string;
  phase: 'editing' | 'submitting' | 'running' | 'failed';
  requestId?: string;
  jobId?: string;
};
```

`intent === 'create-skill'` 即高亮依据，不用 `hasInput` 控制高亮。不因为清空描述、blur、消息追加、重绘而退出。再点 toggle 退出但保留草稿；服务端接受期间禁用 toggle 和重复提交；成功退出；失败回到 editing 并恢复提交内容。

Enter 发送、Shift+Enter 换行，服从现有 Ctrl+Enter 设置；IME composition 未结束时 Enter 不能发送。用户输入始终是内容，结构化 intent 不作为一段“隐藏暗纹词”混入普通聊天文本。刷新恢复只保存非敏感草稿或明确提示未保存；默认不把附件和敏感业务内容写入浏览器永久存储。

### 3.2 创建请求

建议接口 `POST /api/workspaces/:workspaceId/skill-creation-jobs`：

```json
{
  "sessionId": "current-session-id",
  "requestId": "client-generated-id",
  "intent": "create-skill",
  "description": "根据活动记录生成周报，不编造数据。",
  "inputFileIds": []
}
```

用户与租户从鉴权上下文获得，不接受前端传入角色。提交时仅检查会话归属、工作区可写、描述和输入资料。请求不包含 name，也不弹出标识确认。CreatorAdapter 要求 skill-creator 根据描述产生 name，后端校验其仅含小写字母/数字/连字符且最长 64；非法名称可有限修复，仍非法则失败，不把路径字符串直接用于目录。重名时在写入锁内分配唯一后缀（如 weekly-report-2），并同步目录名、frontmatter name、evals.skill_name 及已知自引用；对无法安全更新的引用，使用最终名称重新生成并校验。用户描述中提到的名称只作生成参考，不构成覆盖授权。任务结果返回最终名称，供后续 /skill-name 调用。

`202 {jobId, status}` 表示接受，不是创建完成。幂等键为主体 + 工作区 + requestId；同一 key 不同请求体返回冲突。断网重试先查询任务，不能重复创建。

### 3.3 生成、落盘与失败边界

1. 先按请求幂等键建立任务，冻结描述及片段正文摘要；名称生成前不依赖前端 name 占位。生成并校验名称后，在文件服务写入锁内分配唯一目录并建立逻辑占位。
2. 在隔离临时目录调用 skill-creator。不得直接把整个用户工作区以可写权限交给创建子任务。
3. 当前 creator 只输出 Markdown 的情况下，由适配层包装为 SKILL.md 并初始化空的 `evals/evals.json`；若以后输出更多文件，沿用相同包校验。不要强行要求每次创建必须自动生成用例。
4. 片段选择由 AI 给出 IDs + 原因，后端按冻结目录查出正文；拒绝不存在的 ID。注入只保留普通 Markdown；不得让引用字符串成为运行依赖。避免破坏当前 creator 所要求的段落结构，可将要求整合到相应正文段落。
5. 校验清单、name 一致、允许文件类型、路径逃逸、符号链接、文件总量/大小、敏感信息及格式。生成内容中的命令不自动执行。
6. 同卷暂存目录准备完毕后，在目标占位与工作区文件锁下再次检查目标不存在，再原子提交；提交元数据使用 outbox/恢复标记处理“文件成功、任务未更新”的故障窗口。
7. 成功后发出工作区文件变化、Skill 列表、斜杠命令刷新事件；引用已有 `dispatchProjectFilesChanged`、`dispatchSlashCommandsChangedForPath` 对应流程。当前会话只显示完成提示和文件路径，无额外保存确认。
8. 错误/取消释放未提交的临时产物；同名冲突不覆盖。已经提交成功但回包丢失，应返回原成功结果，不能回滚真实已保存文件。

会话继续调整复用相同文件提交约束，绑定已创建 Skill 的路径与内容摘要。多 Skill 上下文不明确时先澄清。创建与修改只作用于当前授权工作区，不自动发布到市场。

## 4. 公共片段契约

建议表 `skill_snippets(id, title, description, markdown, created_by, updated_by, created_at, updated_at, content_hash)`，不带 tenant_id：这是全平台公共内容。内部摘要用于并发和任务固定引用，不是产品版本，不展示历史，不建立“哪些技能引用此片段”的追踪。

建议接口：`GET /api/skill-snippets?q=...`、`GET /api/skill-snippets/:id` 全员可读；`POST/PATCH/DELETE /api/admin/skill-snippets...` 仅平台管理员可写。管理员修改使用 If-Match 防覆盖，删除需明确确认。保留安全审计不等于片段版本管理。

创建时全库为可选参考集合：小规模读取全部元信息和正文；大规模先传名称、用途及摘要，允许只读按 ID 拉取正文。设置上下文预算和相关度筛选；不得因上下文截断悄悄改为只考虑最前面的若干条。片段服务不可用时明确告知未使用片段或终止任务，不伪称已匹配全库。

普通用户编辑器插入为一次性字符串替换：捕获文件路径、内容摘要、selectionStart/End；弹框搜索不丢焦点；选择预览；提交前核对编辑目标未改变，再替换选区并交还焦点。前端可保留一次撤销操作。正文插入不触发保存、工具启用或 SQL Check 执行。2026-09-21 追加范围：提供“片段 / 我的技能 / MCP 工具”三个 tab。我的技能复用授权工作区本地清单，排除 system 和当前 Skill，只插入 name；MCP 使用 GET /api/workspaces/:workspaceId/mcp-tools/insertion-catalog，只返回已安装且当前用户已启用的完整工具名称及说明，读取缓存目录不进行连接探测或凭据助手调用。Skill/MCP 不提供右侧正文区。

公共片段不得存放租户私有上下文、生产凭据或内部数据；读取片段不绕过用户运行时权限。AI 将正文视为待整合需求，不允许片段中的指令扩大工具权限。

## 5. evals/evals.json 与文件一致性

延续已确认的用例格式；这是本项目新增适配契约，不是声称仓库当前精简 creator 已提供该文件：

```json
{
  "skill_name": "store-weekly-report",
  "evals": [
    {
      "id": 1,
      "prompt": "本周完成两场活动，没有客流明细，请生成周报。",
      "expected_output": "说明进展和缺少的数据，不编造增长比例，列出下周计划。",
      "files": ["evals/files/activity.txt"],
      "expectations": ["没有编造数值", "包含下周计划"]
    }
  ]
}
```

- 根 `skill_name` 必须与目录 / frontmatter name 一致；evals 为有序数组；id 为稳定、唯一正整数；不以数组下标当身份。
- prompt、expected_output 必须非空；files 为安全的 Skill 根目录相对路径数组，不是相对 evals 子目录；expectations 为可选非空字符串数组。
- 不增加草稿状态、actual_output、runId、来源或保护标记到这个 JSON；结果和来源是受控元数据。
- UI 展示 prompt 的摘要，但保存全文；不要硬加 title 字段。导入已知格式时明确转换，未知字段不静默丢弃，报错或保留的兼容策略应统一。
- 手工/AI/会话保存均调用 EvalFileService 的追加或更新操作；读取、保护校验、分配 ID、写入须在同一文件事务内，附带预期摘要，避免覆盖并发修改。
- 文件树 JSON 编辑、重命名、删除目录等现有入口同样接入校验。报告仍只绑定原有快照，编辑不会改写历史运行证据。
- 已发布保护存于受控表 `skill_eval_protection(workspace_id, skill_path, case_id, source, registered_at)`，不能由用户改 JSON 解除。对来源可信的市场导入用例登记；不在本期创造新的发布入口。重新导入、路径重命名须迁移登记；外部文件系统绕过导致删除时，下次加载报告校验发现后提示修复而非认定已解除。

会话保存接口建议 `POST .../skills/:name/eval-cases/from-invocation {invocationId, expectedContentHash}`。后端从会话执行记录读 prompt、引用资料、最终输出，不相信客户端任意提交的“真实输出”。绑定多个 Skill 的调用需定位目标，不把整场会话自动归给最后一个 Skill。保存同一调用使用唯一键防重复；文件与附件先暂存再一起提交。

AI 添加接口建议 `POST .../skills/:name/eval-case-jobs`；目标为追加，不重写整份文件。校验失败可做一次格式修复；失败不新增。自动生成预期可能与 Skill 共享偏差，报告注明用例来源，允许用户后续编辑，但不新增确认步骤。

## 6. 静态检查与独立动态判定

### 6.1 静态检查规则分层

| 层 | 首期规则 | 实现 / 处理 |
| --- | --- | --- |
| 文件结构 | 根 SKILL.md 存在、合法 YAML、name/description、目录名一致 | 复用现有诊断并补足规则；错误阻断 |
| 用例定义 | JSON/schema/id、预期非空、附件存在 | 确定性校验；错误阻断 |
| 文件边界 | 绝对路径、`..`、符号链接越界、文件大小与数量、隐藏凭据 | 真实路径和允许列表；错误阻断 |
| 可复现依赖 | 工具可用性、测试环境、必需输入是否满足 | 无法满足为环境阻断，不假装业务失败 |
| 风险扫描 | 常见凭据模式、危险写入声明、网络目标 | 确定性命中及策略处理；启发式提示可误报，不声称覆盖所有安全风险 |
| 表达质量 | 歧义、重复、缺少边界说明 | 可选 AI 建议，明确标记，不作为确定性规则事实 |

静态检查不通过不产生动态“通过”结论。每项结果保存 ruleId、严重程度、文件/位置、解释及建议。AI 不负责替代 JSON 解析、路径校验等确定性检查。

### 6.2 Runner 输入与隔离

一次后台 job 可复用一个受控 worker，但每个用例必须使用新的运行上下文与清洁临时目录。不是为每条用例创建普通用户聊天，也不是每次都必须冷启动全新 Claude 容器。是否复用容器取决于能否清除文件、进程、环境及缓存；无法证明隔离时采用新沙箱。

执行投影仅包含 Skill 运行文件、当前用例 prompt、授权测试输入及白名单工具。**不包含 evals/evals.json、expected_output、expectations、评分规则、前测报告或答案资料**。不能把整个技能目录或真实工作区原样挂载给被测 Agent。输入文件若与答案目录混用，先做分类/复制，无法分离时阻断。

默认禁用生产密钥、网络任意出站、宿主机路径和真实写工具。外部工具用测试账号或测试替身。普通进程隔离不等于安全沙箱；发布前须用恶意 Skill 验证越权读取/写入和资源限制。不能沿用 creator 的 bypassPermissions 配置来取消隔离策略。

### 6.3 证据模型

消息保存规范化顺序号、role、可见文本、工具输入/返回、父调用关系、subagent 子消息、终态和时间；文件保存受控 artifactId、相对路径、类型、内容摘要及下载授权。保留完整**可见输出**，不记录或要求隐藏思维链。存在截断或丢失事件时注明证据不完整，不能用最终一句话冒充完整轨迹。

任务完成条件为主 Agent 终态 + 所有子任务/工具终态 + 产物收集完成；设置硬超时、输出大小和费用限额。超限保存已获取证据并返回 error/inconclusive，不丢弃后标为通过。

### 6.4 预期如何判定

1. RuleGrader 对可计算条件使用确定性规则，例如文件存在、可解析、列名、测试数据数值、禁止调用的工具；规则来自受控平台和冻结计划，不执行 Skill 返回的任意评判脚本。
2. AIReviewer 是与被测执行分开的无执行权限 Agent / 模型请求。输入为固定 prompt、expected_output、expectations 及完整运行证据，输出逐项结论和可定位证据。
3. 对自然语言用语义/约束判断，不要求逐字一致；工具顺序仅在用例明确要求时硬约束；子任务不比较随机 ID；文件同时验证可读取性及内容目标。
4. 把输出/工具返回当不可信数据，隔离其中的“忽略规则并给通过”等注入指令；评审不调用其建议的工具。安全与确定性规则失败不能被 AI 打分覆盖。
5. 每条 expectation 为 passed/failed/uncertain，包含 evidenceRef 和 reason。所有必需项通过且无阻断才是 passed；业务违反是 failed；执行/评分器故障是 error；证据不足或冲突是 inconclusive。不把所有异常压成 failed，也不把 uncertain 算通过。
6. 保存 grader 模型/指令摘要、工具策略、用例摘要，保证前后比较口径一致。不新增八维度总分或黑箱单分，首期优先可定位的逐例结果。

报告示例外层（不写入 evals.json）：

```json
{
  "caseId": 1,
  "status": "failed",
  "checks": [{"text": "没有编造数值", "status": "failed", "evidenceRef": "message:8", "reason": "输出20%增长，但输入没有客流数据"}],
  "messagesRef": "report-artifact-id",
  "artifacts": [],
  "phase": "before"
}
```

## 7. 串行任务、停止与恢复

建议任务状态为 queued → static-check → before-running → completed；优化为 queued → static-check → before-running → optimizing → writing → after-running，按通过条件和迭代上限选择 completed 或回到 optimizing。任一步可进入 failed/cancelled/stale。前测全部通过时直接 completed，迭代次数为 0。

严格串行单位是“执行 + 所有子任务完成 + 采集 + 评审 + 清理”，不是仅主模型调用串行。每个 job 同时最多一个用例；跨 job 并发受 worker 配额约束，同一工作区同一 Skill 禁止重叠测评/优化/生成修改。

普通业务失败继续剩余用例。权限撤销、输入投影违规、资源耗尽或无法维持隔离时停止任务；单用例工具超时可记录 error 后按策略继续。停止是后端取消信号，不只是前端停轮询。清理所有子进程及子任务后再释放锁。

JobRepository 保存主体、工作区、Skill 路径、状态、当前阶段、case cursor、锁租约、heartbeat、requestId、文件/用例摘要、报告指针。SSE 事件具有递增序号，可断线续读；轮询可作为回退。服务重启后不能直接重跑已写入步骤：有已提交标记则恢复后测，无证据的执行标记中断，幂等重试由策略决定。

## 8. 自动优化的写入一致性

1. 冻结全部用例与输入，记录 baseContentHash；前测不可跳过。页面提示期间编辑不影响执行，Runner/Optimizer 仅读取任务副本；每轮回写比较最近成功写入的工作区指纹。
2. Optimizer 可以读取预期和前测，是诊断角色；Runner 不可读答案。优化输入包括确定性失败、评审证据及原文件，不只给一个分数。
3. 输出可修改 SKILL.md 和运行所需的非测试资源；禁止更改 name、evals/evals.json、测试输入、保护登记、评分策略和权限配置。新增文件仍走允许列表。
4. 先在临时目录生成并校验；锁内再次比对 baseContentHash。仅哈希相同才提交；外部编辑时仅阻止回写，不停止任务副本中的测评与优化；保留候选与新编辑，显示差异，不盲目覆盖。
5. 使用文件事务/写入日志提交并记录 writtenAt、afterContentHash、changedFiles。多文件提交不靠多次裸 writeFile 假装原子；失败可恢复到已知完整状态。
6. 修改提交后立即可见，启动全量后测；不显示“采用”。没有修改仍跑后测。后测失败保留文件，清楚标记结果退化或异常。
7. 停止发生在提交之前丢弃临时修改；提交后只停止后测并保留已写文件。查看对比基于本 job 前后快照，不提供 Skill 版本导航。
8. 同一批训练用例改善不代表泛化提升；首期报告明确“不保证未见场景”。人工/AI 后续可追加边界场景，但不能在任务中途偷偷改预期。留出集、长期定时无人值守优化不在本期；本期迭代仅在用户明确设置的次数与预算内执行。

### 8.1 最大迭代次数与终止条件

- 优化请求增加 `maxIterations`，默认 3，允许 1–10 的整数；空值、字符串、非整数及越界请求明确返回 400，不悄悄截断。前端数字输入及后端使用同一规则。普通运行全部不使用这个字段。
- 设置在任务启动前填写，“开始优化”是启动授权，不是对后续修改逐次确认；每次修改仍按既定规则直接落盘。
- 一次迭代 = 一次优化尝试 + 完整后测，最初前测不计数。每次进入 optimizing 前先检查 `iteration < maxIterations` 并原子增加计数；无改动也消耗一次。失败重试及恢复沿用同一 iteration，不得重置上限或创建隐形额外迭代。
- 初始前测全部 passed 时结束且不写文件。每次后测所有必需用例和规则通过时以 `stopReason=all_passed` 提前结束；未通过且仍有额度则继续。到达上限以 `stopReason=max_iterations` 结束，任务执行完成不等于质量通过。
- 下一次优化的证据为上一次完整后测和当前文件；全部用例、输入、判定策略不变，不能跨轮修改预期刷分，也不必对完全相同快照再跑一遍前测。
- error/inconclusive、权限撤销、用户停止、总时长/费用超限均终止循环，单列原因；不能当成普通 failed 持续优化。保留已提交改动和已完成证据，不自动回滚或发布。
- 任务保存 `maxIterations, iteration, stopReason, rounds[]`；每轮记录固定预期引用、输入文件摘要、优化前后文件摘要、完整逐例输出、写入状态和耗时。重启恢复须在同一轮日志上继续，防止重复写入。
- 页面显示“已执行 X / N 次迭代”和终止原因；用例详情默认对比初始前测与最新一轮后测，明确标注轮次。文件对比展示本任务初始文件与最终候选文件（明确是否回写工作区），不称版本历史。运行中不能修改上限。

## 9. 建议接口与持久化

| 接口（建议） | 功能及关键约束 |
| --- | --- |
| `POST /api/workspaces/:id/skill-creation-jobs` | 显式创建意图；202 异步；幂等、同名锁 |
| `GET /api/workspaces/:id/skill-jobs/:jobId` | 授权查询状态与报告索引 |
| `GET .../skill-jobs/:jobId/events` | SSE 可续读；不得跨租户订阅 |
| `POST .../skill-jobs/:jobId/cancel` | 幂等停止、解释已落盘边界 |
| `GET/POST/PATCH/DELETE .../skills/:name/eval-cases` | 统一文件服务；读写摘要、schema 与保护 |
| `POST .../skills/:name/eval-cases/from-invocation` | 服务端取证、附件校验、保存幂等 |
| `POST .../skills/:name/eval-case-jobs` | AI 生成后直接追加，无确认 |
| `POST .../skills/:name/evaluations` | `{mode: run-all / optimize, expectedContentHash, requestId, maxIterations?: 3}`；仅 optimize 使用次数设置 |
| `GET .../skill-jobs/:jobId/cases/:caseId` | 冻结预期及前后证据；不拼接当前用例替换旧预期 |
| `GET .../skill-jobs/:jobId/diff` | 本次允许文件的修改前后，不是版本历史 |

建议将 snippets、jobs、protection、invocation-save 幂等记录等存于 CCUI 现有数据库，通过迁移创建新表。完整消息、产物和临时前后文件放在 CCUI 受控任务存储，不放入源 Skill 或市场分发包；所有读写重新检查工作区权限。

用例文件长期保留。建议默认报告与优化对比保留 30 天，临时执行环境任务结束即清理；保留期为首期可配置建议，不是已有能力。删除报告需同步删除关联临时产物，UI 显示已过期而不是错误“未运行”。不存生产凭据；日志脱敏；附件下载防路径逃逸、跨租户访问和 HTML 脚本执行。

## 10. 实施顺序与验收

1. **文件和公共库基础**：SnippetService、EvalFileService、schema/原子提交/保护、workspace 鉴权测试。
2. **会话创建最小闭环**：composer intent、纯描述提交、CreatorAdapter 自动命名与唯一性校验、幂等创建、消息反馈与工作区刷新。不破坏既有 creator 能力和 Agent Graph 原有调用。
3. **调用转用例**：executionId 绑定、证据与附件提取、一次点击直接保存、防重复和敏感数据阻断。
4. **测评链路**：持久 job、隔离 Runner、静态规则、独立 Grader、串行调度和详情复用消息组件。
5. **优化链路**：全量前测、受限修改、直接提交、全量后测及双列对比；故障注入测试。
6. **安全和浏览器验收**：普通用户不能写公共库；跨工作区越权、答案泄漏、工具注入、路径逃逸、重复提交、锁过期、重启后已提交任务恢复均必须测试。

实施完成条件不仅是页面有按钮：必须有至少一个真实文本场景、一个工具场景、一个 subagent 场景和一个文件产物场景，通过隔离执行与完整证据采集。原型里的预设输出和模拟哈希比较不能替代生产验收。

## 11. 原型覆盖与不覆盖

第一阶段原型仅包含会话、我的技能、片段管理。支持创建模式高亮、纯描述提交、自动命名及同名后缀处理、自动保存演示、继续调整/调用、保存为用例、手工/AI 添加、已发布示例用例删除保护、文件编辑及片段插入、后台串行演示、全量优化前后输出及文件对比。原型自动命名为按描述关键词匹配的模拟逻辑，不代表真实 AI 命名。

原型不调用真实 AI、不写真实工作区、不存浏览器永久数据、不连接远端市场；片段自动匹配使用关键词模拟，AI 用例与输出为明确标注的固定示例。未接入：真实 sandbox、流式恢复、生产鉴权、真实评审器、附件上传、报告持久化和完整静态安全扫描。窄屏以运营视角查看/操作为主，演示身份选择在桌面侧栏。新功能和异常处理的实现验收依照本文，不把原型能力当作生产已实现清单。
