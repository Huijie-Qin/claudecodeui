# 技能市场 V2.0 需求设计说明书

| 项目 | 内容 |
|---|---|
| 文档版本 | V2.0（需求设计稿） |
| 日期 | 2026-08-08 |
| 状态 | Draft for review |
| 适用产品 | CloudCLI（claudecodeui）技能市场 + 远程技能市场后端（data-agent 服务演进） |
| 关联文档 | `docs/superpowers/prds/2026-05-05-skills-tools-market-prd.md`（V1 PRD）、`docs/skill-market-api.md`（远程市场 API）、`docs/superpowers/specs/2026-05-04-skills-tools-market-design.md`（V1 设计） |
| 参考原型 | `/Users/song/Projects/claudecodeui/scratch/designs/skill-market-v2/index.html`（V2.0 可交互原型）；`/Users/song/Projects/opensource/dataagent`（Skill 研发工作台原型） |
| 关键决策 | ① Skill 编译目标＝项目现有 Workflow 引擎（确定性 JS 脚本）；② 协作贡献范围＝仅租户内（不跨租户共享）；③ 市场/我的技能双视图分离——市场只读预览 + 安装/卸载，我的技能承载本地 `.claude/skills` 全部技能的编辑/调试/测评 |
| 最近修订 | 2026-08-08：列表行删除置顶标记（无置顶按钮，移除 📌）；列表行删除通过率进度条（含义模糊，通过率/质量分改到详情页展示）；技能名后 WF 徽标改为中文「编译」（由长 SOP 编译为确定性 Workflow 的产物）；统一技能市场与「我的技能」的列表头部样式（共用 listHeader 组件：标题栏 + 筛选卡，仅右侧操作与状态筛选按视图差异，不再两套风格）；市场 tab 更名为「技能市场」；市场只读预览的概览页与我的技能编辑页均新增"引用片段详情"区，展开所引用片段（类型/版本/完整正文·只读），胶囊可点击定位；市场改为只读预览（不支持编辑）；删除「我的安装」tab；「我的开发」改为「我的技能」（读取 workspace `.claude/skills` 全部技能，含本地创建/文件上传/市场安装三种来源，无 GitHub 安装途径）；市场移除启用/禁用层，仅保留安装/卸载且按钮内联至列表行；市场仅展示已发布技能、不显示状态；列表→详情改为递进式子页面导航 |

---

## 1. 背景与问题分析

### 1.1 现状：三套割裂的技能子系统

当前代码库中存在**三套彼此独立、数据不互通**的技能子系统，没有统一的"技能市场"产品形态：

| 子系统 | 前端入口 | 后端 | 技能来源 | 状态 |
|---|---|---|---|---|
| A. 远程技能市场 | `SkillMarketDialog.tsx`（header 按钮触发的弹窗） | `routes/skill-market.js` -> 远程 data-agent 服务 | 远程 API（skillList/preview/download/publish） | **唯一在用** |
| B. 工作区技能 | `SkillsPanel.tsx` | `routes/workspace-skills.js` | GitHub HTTPS / 本地 ZIP | **死代码**（`AppTab` 已不含 `skills`，无组件引用） |
| C. 技能预设 | `admin/SkillPresetsTab.tsx` | `routes/admin.js` -> `services/skill-presets.js` | 远程市场（策展层） | 在用（管理员） |

三者各自维护元数据：A 用 SQLite 表 `workspace_skill_market_imports`，B 用文件 `.cloudcli/skills/metadata.json`，C 用 SQLite 表 `tenant_skill_presets`。用户面对的"技能市场"实际只是 A——一个代理远程服务的弹窗。

### 1.2 代码级痛点证据（对应六大需求）

| 需求 | 痛点 | 代码证据 |
|---|---|---|
| ① 易用性 | 已导入技能不置顶，追加到列表末尾 | `services/skill-market.js:84-93`：`[...enrichedRemoteSkills, ...importedSkillSummaries]` |
| ① 易用性 | 无分类/标签体系 | `multitenancy-schema.js:133-147` 的 `workspace_skill_market_imports` 无 `category`/`tag` 字段；`workspace-skills.js:59-86` `parseSkillManifest` 仅解析 `name`+`description` |
| ① 易用性 | 默认强制预览，非纯列表 | `SkillMarketDialog.tsx:177-182` 加载即自动选中第一个技能并加载文件 |
| ① 易用性 | 搜索仅 substring 匹配 | 前端 `SkillMarketDialog.tsx:106-119`、后端 `skill-market.js:746-759` 均为 `includes()` |
| ② 协作 | 仅创建者可发布，无 PR/Review | `skill-market.js:1812-1823` `ensurePublishAllowed`：`createUserId !== 当前用户` 即 403；全仓库无 `reviewer`/`collaborator`/`pull request` 代码 |
| ③ 模板/片段 | 无模板、无片段库 | 仅 `skill-command-expander.js:121-139` 支持 `$ARGUMENTS`/`$1` 占位符替换，且只服务定时任务 |
| ④ 编译 | 无 workflow 编译 | 技能本质是单文件 markdown 指令，无控制流、无编译器 |
| ⑤ 测评 | 无功能测评 | `skill-presets.js:596-637` `validatePreset` 仅校验 SKILL.md 能否解析，不执行、不评估 |
| ⑥ 召回 | description 无结构/质量约束 | `parseSkillManifest` 取正文第一段作 description，无长度/结构/关键词要求 |

### 1.3 dataagent 参考的借鉴与差距

`dataagent` 是一个面向广告数据团队的 **Skill 研发工作台原型**（纯前端 Vue mock，无后端）。其设计思路清晰，**研发态**能力强，但**市场态**完全缺失。V2.0 的策略是：**研发态借鉴 dataagent，市场态自行设计补齐**。

**可直接借鉴的亮点：**

1. **原子引用系统**：技能不复制依赖内容，而是以 `{{ kind:label | id=xxx | version=xxx }}` 引用块插入 SKILL.md；编辑器用只读胶囊渲染并阻止跨边界编辑，防止"改了底座、技能行为漂移"。
2. **编辑/调试/测试三标签详情页**：把研发态、运行态、质量态拆成三个独立工作模式。
3. **模板中心 + 一键装配**：模板携带"默认依赖装配清单"，创建时自动解析引用、生成测试骨架。
4. **片段库 + 版本隔离**：标准片段类型、`usedBy` 复用统计、保存即升版本、已发布技能固定旧版、升级需显式确认。
5. **测试用例四分类法**：触发路由 / 引用装配 / 安全 / 结果质量。
6. **结构化 skill -> 文件树物化**：把 skill 对象展开成完整目录交付。
7. **发布即快照**：发布时固定引用版本到 snapshot，保证可复现。
8. **召回 Badcase 闭环**（在指标层）：错召识别 -> 人工复核 -> 沉淀为测试用例 -> 回归。

**dataagent 的短板（= V2.0 必须补齐）：** 无市场形态（无安装/卸载/置顶/分享）、无后端持久化、调试与测试均为 `setTimeout` 模拟（无真实执行）、Skill 层无召回闭环、审核流是空壳、模板/片段/分类均硬编码、版本管理粗糙（字符串 `v1.8`、`+0.1`）。

---

## 2. 设计目标与非目标

### 2.1 设计目标

- **易用性优先**：默认即清晰列表，已安装可见、可分类、可搜索，零学习成本上手。
- **逻辑闭环**：覆盖"发现 -> 创建 -> 协作 -> 测评 -> 编译 -> 发布 -> 召回反馈 -> 改进"全生命周期，每一步的产物都是下一步的输入。
- **低门槛开发**：非专业开发者通过模板 + 片段 + 一键装配即可产出可用 skill。
- **团队协作**：租户内类 GitHub PR 机制，让多人参与 skill 贡献与评审。
- **质量可度量**：测评作为发布门禁，召回优化让好 skill 被准确发现。

### 2.2 非目标

- **不跨租户共享技能**（已确认协作范围为"仅租户内"）；不做全局公共市场、不做跨租户技能发布/订阅。
- 不替代 Claude Code CLI 原生 skill 加载机制；V2.0 仍以 `.claude/skills/` 为运行时可见目录。
- 不做 user-level（跨 workspace 个人）技能管理（沿用 V1 决策，后续迭代）。
- 不在安装阶段执行第三方脚本/包管理器/动态代码（沿用 V1 安全约束）。
- 不热更新正在运行的 Agent turn；技能变更对下一个 turn 或显式 reload 生效（沿用 V1）。

### 2.3 设计覆盖范围声明

本设计为**端到端闭环**，逻辑模型覆盖 CCUI 前端 + CCUI 后端 + 远程技能市场后端（data-agent 服务演进）。其中：协作 PR、版本快照、测评执行、召回索引等能力**需要远程市场后端支持**，CCUI 侧负责 UI 与代理透传。若市场后端由独立团队维护，本文档相关章节可作为对其的**接口需求**。

---

## 3. 总体设计：技能研发生命周期闭环

V2.0 的核心是把六大需求串成一条闭环，而非六个孤立功能。闭环如下：

```
        ┌─────────────────────────────────────────────────────────┐
        │                  线上真实使用反馈                         │
        │   (触发错误 / 结果偏差 / 召回失败 -> Badcase)              │
        └───────────────┬─────────────────────────┬───────────────┘
                        │                         │
   ⑥ 召回优化           ▼                         ▼            ⑤ 测评
  (description/       ┌─────────────┐        ┌──────────┐    (质量门禁
   分类改进)   ◀──────│   发 现     │        │  发 布   │◀───  + Badcase
                        │  (市场列表)  │        │ (版本快照)│     沉淀)
                        └──────┬──────┘        └────┬─────┘
                               │                    │
                               │ 安装到 workspace    │ merge 产生新版本
                               ▼                    │
                        ┌─────────────┐             │
                        │   使 用     │             │
                        │ (Agent 调用) │             │
                        └─────────────┘             │
                                                    │
   ③ 模板/片段         ┌─────────────┐        ┌──────────┐
   (低门槛创建)  ─────▶│   创 建     │───────▶│  协 作   │──┐
                        │ (模板装配)  │  PR    │ (租户内  │  │
                        └─────────────┘        │  Review) │  │
                               ▲               └────┬─────┘  │
                               │                    │        │
                               │            ④ 编译   │        │
                               │           (SOP->     ▼        │
                               │           Workflow) ┌──────┐ │
                               └──────────────────── │测评  │─┘
                                  (编译产物回归)     │门禁  │
                                                     └──────┘
```

**闭环说明：**
- **发现**（①易用性 + ⑥召回）：用户在市场列表按分类/搜索发现技能，召回优化保证好技能被准确命中。
- **创建**（③模板/片段）：非专业用户从模板一键装配，或用片段积木拼装。
- **协作**（②PR）：贡献者在租户内提 PR，owner/reviewer 评审。
- **测评**（⑤）：PR merge 前必须通过测评门禁；线上 badcase 沉淀为回归用例。
- **编译**（④）：长 SOP 技能一键编译为确定性 Workflow，编译产物回归测评验证等价性。
- **发布**：merge 生成版本快照（发布即快照）。
- **反馈**：线上使用产生的 badcase 反哺 ⑤测评用例 与 ⑥召回优化，回到发现，形成闭环。

---

## 4. 核心概念与统一数据模型

### 4.1 统一技能模型（融合三套子系统）

V2.0 废弃"三套割裂元数据"，统一为 **租户技能空间（Tenant Skill Space）+ 工作区本地技能（Workspace Local Skills）** 两层：

- **租户技能空间（市场目录）**：租户内所有技能的主数据（由市场后端管理，CCUI 缓存）。一个技能 = 一份主数据 + 多个版本快照 + 引用关系 + 协作/测评元数据。**市场仅展示 `published` 状态技能，且为只读预览**--不支持在市场内编辑。
- **工作区本地技能（`.claude/skills`）**：当前 workspace `.claude/skills/` 目录下实际存在的全部技能，是 Agent 运行时可见的真实来源。本地技能按**进入途径**区分三种来源（`localSource`）：

  | `localSource` | 含义 | 是否可编辑/调试/测评 |
  |---|---|---|
  | `market` | 从市场安装到本地（对应某个 `published` 技能的本地副本） | 本地副本可编辑，编辑后与市场源版本分离 |
  | `created` | 在「我的技能」页通过模板/空白创建的技能 | ✅ 全功能 |
  | `uploaded` | 通过文件 Tab 上传 SKILL.md / 技能文件夹导入 | ✅ 全功能 |

  > **不再提供"从 GitHub 安装"途径**（沿用 V1 安全约束的强化：不在安装阶段拉取外部仓库脚本）。本地技能的获取仅限：市场安装、本地创建、文件上传三条路径。

- **安装/卸载语义**：安装 = 将市场技能写入 `.claude/skills/`（`local=true`，下个 turn 生效）；卸载 = 从 `.claude/skills/` 移除（`local=false`）。**不再有"启用/禁用"中间层**--技能在本地即生效，移除即不生效，简化为安装/卸载二元状态。置顶（`pinned`）作为排序权重保留。
- **"已安装"派生量**：市场视角的"已安装" = `local && status==='published'`（本地存在且对应市场技能已发布）。

**统一技能主数据字段（SkillMaster）：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 技能唯一 ID |
| `name` | string | code 名（唯一，kebab-case） |
| `displayName` | string | 展示名 |
| `description` | object | **结构化**：`{summary, triggers[], notFor[], capabilities[], keywords[]}`（见 5.6） |
| `domainGroup` | enum | 一级分类（见 4.2） |
| `area` | string | 二级分类 |
| `tags` | string[] | 自由标签 |
| `status` | enum | `draft / in_review / published / deprecated`（市场仅展示 `published`） |
| `version` | int | 当前已发布版本号 |
| `ownerId` | string | 负责人（创建者，可转移） |
| `collaborators` | string[] | 协作者列表（可提 PR、merge 需 owner） |
| `sourceType` | enum | `authored / preset`（主数据来源；本地创建/上传的技能发布后归为 `authored`。**已移除 `imported_github`**） |
| `isCompiled` | bool | 是否为编译产物（Workflow skill） |
| `sourceSkillId` | string? | 编译产物的源 skill ID（见 5.4） |
| `qualityScore` | object | 最新测评得分 `{overall, trigger, assembly, safety, quality, efficiency}` |
| `recallMetrics` | object | 召回指标 `{hitRate, precision, lastEvaluatedAt}` |
| `createdAt / updatedAt` | datetime | |

**工作区本地技能扩展字段（CCUI 侧，叠加于 SkillMaster 缓存）：**

| 字段 | 说明 |
|---|---|
| `local` | bool，是否已存在于 `.claude/skills/`（安装/卸载的真实判据） |
| `localSource` | enum `market / created / uploaded`（进入本地的途径） |
| `pinned` | bool，置顶（排序权重，非启停开关） |
| `lastUsedAt` | datetime，最近使用时间（排序参考） |

### 4.2 分类体系（两级、可配置）

借鉴 dataagent 的 `domainGroup + area` 两级分类，但**改为租户可配置**（不硬编码）：

- **一级 `domainGroup`**：租户管理员定义的领域分组（如"通用能力 / 行业能力 / 经营能力"），每组带颜色、图标、hint。
- **二级 `area`**：每个 domainGroup 下的细分领域枚举。
- **来源优先级**：技能 frontmatter 声明的 `domainGroup`/`area` > 租户管理员手动归类 > LLM 辅助自动归类建议（见 5.6）。
- **UI 呈现**：顶部"领域筛选条"（颜色点 + 标题 + 计数徽标，dataagent 亮点），点击即筛。

平台提供一套**默认分类模板**，租户可基于它增删改；新增技能未分类时进入"未分类"组并提示补全。

### 4.3 版本与原子引用模型

**版本模型**（修复 dataagent 字符串版本的粗糙问题）：
- 版本号为整数（沿用远程市场现有 `version` 语义），每次 merge/publish 自增。
- 每个已发布版本 = 一份**完整快照**（技能文件树 + 引用版本固定），存于市场后端。
- 支持版本间 diff（文件级 added/modified/removed，复用现有 `compareSkillFiles`）、回滚。

**原子引用模型**（借鉴 dataagent，核心防漂移机制）：
- 技能可引用：**片段（Snippet）、模板、MCP 工具、子技能、外部资源**。
- 引用以原子块插入 SKILL.md：`{{ kind:label | id=xxx | version=xxx }}`。
- 编辑器将引用渲染为**只读胶囊**，阻止跨边界编辑；点击胶囊查看详情、可移除。
- **发布即快照**：发布时把所有引用的当前版本固化到 `references/*.snapshot.json`，保证已发布技能行为可复现。
- 片段/子技能升级生成新版本，已引用旧版的技能**不受影响**，升级需显式确认（dataagent 版本隔离亮点）。

### 4.4 技能生命周期状态机

```
 draft ──提PR──▶ in_review ──approve+merge──▶ published
   ▲                  │                           │
   │                  │ request changes           │ 废弃
   │                  ▼                           ▼
   └──────────── draft ──────────────────── deprecated
                          (可重新激活 -> draft)
```

- `draft`：草稿，仅作者/协作者可见可编辑。
- `in_review`：已提 PR，等待评审。
- `published`：已发布，租户内可见、可安装。
- `deprecated`：已废弃，列表中灰显，已安装的可继续用，不可新安装。

---

## 5. 详细需求设计

### 5.1 模块一：易用性重构（市场只读预览 / 安装卸载 / 分类 / 我的技能）

**目标**：把"加载即预览、无分类、已安装沉底"的弹窗，改成"默认清晰列表、已安装置顶、可分类可搜索、安装卸载内联"的易用市场；同时以「我的技能」页承载本地 `.claude/skills` 全部技能的研发态能力。

#### 5.1.1 默认列表优先，递进式详情子页

- 默认视图为**单栏紧凑列表**（卡片行），不自动选中、不自动加载文件预览。
- 列表行信息：分类色点 + 名称 + version + 徽章（编译 / 待更新 / 来源）+ 一级分类/二级 area + description.summary（单行截断）+ 安装/卸载按钮 + ›。**市场列表不显示状态徽章**（市场仅含已发布技能，状态无意义）；**列表行不展示通过率/质量分、不展示置顶标记**（保持简洁，质量分在详情页展示）。
- **递进式导航**：点击某行 -> 进入**整页技能详情子页**（非右侧抽屉、非左右分栏），顶部面包屑 `技能市场 / <技能名>` + 「← 返回」回到列表。详情子页占满内容区，承载概览/测评/版本等只读内容。
- 移动端继续保持单列滚动。

> 对比现状：`SkillMarketDialog.tsx:177-182` 自动选中第一个并加载文件 -> V2.0 改为不自动选中、点击才递进进入详情子页。

#### 5.1.2 市场仅展示已发布技能，安装/卸载内联

- 市场列表数据源 = `status==='published'` 的技能（`in_review`/`draft` 不进入市场，仅在我的技能可见）。
- **已安装置顶排序**：单列表内，`local && published`（已安装）的技能置顶，其后按相关度/质量分排序（不再分"我的已安装/可发现"两个分组区块，统一排序）。**不提供置顶按钮/置顶标记**（无手动置顶入口）。
- **安装/卸载按钮内联至列表行**：每行尾部直接展示「安装」或「卸载」按钮（依据 `local` 判定），无需进详情即可操作。点击安装/卸载后列表即时刷新。
- **不再有启用/禁用开关**：移除 inline toggle 与详情中的启停控件。技能在本地即生效、移除即失效，简化为安装/卸载二元状态。
- 标题栏右侧摘要（紧凑 chip）：已发布技能数 / 已安装数 / 待更新数（不再单独成行摘要卡）。
- **统一列表头部样式**：技能市场与「我的技能」共用同一头部组件（标题栏：标题 + 副标题 + 右侧操作/摘要；其下筛选卡：搜索框 + 领域筛选条），仅右侧内容（市场为摘要 chip、我的技能为「上传/新建」按钮）与状态筛选条按视图差异，避免两套风格造成混乱。

> 对比现状：`skill-market.js:84-93` 把已导入技能追加到末尾 -> V2.0 置顶排序 + 内联安装卸载按钮。

#### 5.1.3 分类与搜索

- 顶部"领域筛选条"（4.2）：一级分类色点 + 计数，点击筛选；二级 area 作为下拉细化。
- 搜索框：按技能名 / 触发词 / 关键词 / summary / area 相关度匹配（§5.6.5）。
- **市场不提供状态筛选**（仅已发布，无需筛状态）。状态筛选（已发布/评审中/草稿）属于「我的技能」页（见 5.1.5）。
- 分类筛选与搜索可叠加。

#### 5.1.4 统一入口与导航

- 废弃 `SkillsPanel` 死代码；`SkillMarketDialog` 升级为**主工作区"技能"Tab**（与 Files 平行），承载全部能力。
- 顶部子导航（pill tabs）：

  ```
  [ 技能市场 ] [ 我的技能 ] [ 模板中心 ] [ 片段库 ] [ 贡献(PR) ] [ 测评 ] [ 管理 ]
  ```

  - **技能市场**（默认页）：只读预览 + 安装/卸载，仅已发布技能。
  - **我的技能**：workspace `.claude/skills` 全部本地技能的研发工作台（见 5.1.5）。
  - **管理**仅管理员可见。
  - 已移除原「我的安装」tab（安装态不再单列视图，融入技能市场的内联按钮与「我的技能」的本地列表）。
- 保留 `tenant_skill_presets` 的"预装/策展"能力，作为管理员视角的子页。

#### 5.1.5 我的技能页（本地技能工作台）

「我的技能」读取当前 workspace `.claude/skills/` 目录下的**全部技能**（不只已安装），按 `localSource` 标注来源胶囊：`市场安装` / `本地创建` / `文件上传`。

- **数据源**：`local===true` 的技能（含 `published`/`in_review`/`draft` 各状态），保持文件系统原序。
- **来源无 GitHub**：本地技能只能通过①从市场安装、②「+ 新建技能」本地创建、③「↑ 上传技能」从文件 Tab 导入三条途径产生；**不提供"从 GitHub 安装"**。
- **支持全功能研发态**：点开技能进入详情子页，提供完整五标签--编辑 / 调试 / 测评 / 版本 / 设置（详见 §7.3）。
- **新建技能**：从模板中心选模板一键创建（自动装配依赖 + 测试骨架），产物标记 `localSource='created'`、`status='draft'`，创建后跳转我的技能详情页进入编辑。
- **上传技能**：拖拽 SKILL.md 或技能文件夹，frontmatter 校验后写入 `.claude/skills/<name>/`，导入为草稿（`localSource='uploaded'`）。上传技能不自动发布到市场；如需共享走「提 PR」流程。
- **状态筛选**：我的技能页提供状态筛选（全部/已发布/评审中/草稿），并展示状态徽章（与市场相反，这里状态有意义）。
- **头部样式**：与技能市场共用统一列表头部组件（见 5.1.2），右侧为「↑ 上传技能」「+ 新建技能」按钮，筛选卡多一行状态筛选条。

> 与市场的分工：市场 = 发现 + 只读预览 + 安装/卸载（远程目录的只读视图）；我的技能 = 本地全部技能的编辑/调试/测评/版本/设置（研发工作台）。市场安装的技能会同时出现在我的技能（`localSource='market'`）；在市场卸载则从我的技能移除。

---

### 5.2 模块二：租户内协作贡献机制（类 GitHub PR）

**目标**：打破"仅创建者可发布"的瓶颈，让租户内多人通过 PR 参与技能贡献与评审。**范围限定租户内**，不跨租户。

#### 5.2.1 技能仓库模型

每个 `published` 技能在租户内视为一个"技能仓库"：
- **主分支** = 当前已发布版本（受保护，不可直接改）。
- **贡献分支**：任何租户成员可从主分支拉一个命名分支（草稿），在其上修改。
- 分支 = 一份技能文件的草稿副本 + base 版本号 + 作者。

#### 5.2.2 Pull Request 流程

1. **创建分支**：贡献者点"Fork/分支编辑"，基于已发布版本创建草稿分支，进入技能编辑器修改。
2. **提交 PR**：填写标题、变更说明（changelog 草稿）、选择 reviewer。后端生成文件级 diff（added/modified/removed，复用 `compareSkillFiles`）。
3. **Review**：reviewer 在 diff 上行级评论、approve / request changes / comment。
4. **测评门禁**：PR 必须通过测评（§5.5）才能 merge；测评不达标阻止 merge。
5. **Merge**：owner（或租户管理员）审批通过后 merge，主分支生成新版本（version+1），保留 changelog 与快照。
6. **通知**：PR 状态变更通过现有 WebSocket 推送（租户内）。

#### 5.2.3 权限模型

| 角色 | 浏览/安装 | 创建分支/提 PR | Review 评论 | Approve/Merge | 删除/废弃 |
|---|---|---|---|---|---|
| 租户成员（view） | ✅ | ✅ | ✅（被指派时） | ❌ | ❌ |
| 协作者（collaborator） | ✅ | ✅ | ✅ | ❌（仍需 owner） | ❌ |
| 技能 Owner | ✅ | ✅ | ✅ | ✅ | ✅ |
| 租户管理员 | ✅ | ✅ | ✅ | ✅（override） | ✅ |

- Owner 可在技能设置中添加/移除 collaborator、转移 ownership。
- 租户管理员可 override merge（紧急修复场景），但留审计记录。

#### 5.2.4 版本历史与回滚

- 每次 merge 产生版本快照，技能详情页有"版本历史"时间线。
- 任意历史版本可查看 diff、可回滚（回滚 = 基于旧版本创建新 merge，不破坏历史）。

> 对比现状：`skill-market.js:1812-1823` `ensurePublishAllowed` 仅创建者可发布 -> V2.0 改为 PR + Review + Owner merge。

---

### 5.3 模块三：模板与片段管理

**目标**：让非专业开发者也能产出可用 skill。提供模板中心、片段库、模板管理，支持一键装配与一键加入。

#### 5.3.1 模板中心（Template Center）

借鉴 dataagent `TemplateCenter`，扩展为三级可见性：

- **平台内置模板**（read-only）：官方维护的最佳实践骨架（如"代码评审 skill""Bug 诊断 skill""空白 skill"）。
- **租户模板**（管理员维护）：租户内共享，团队沉淀的领域模板。
- **个人模板**（用户自建）：仅自己可见。

**模板字段**（扩展 dataagent `SkillTemplate`）：

| 字段 | 说明 |
|---|---|
| `title / description / icon / level` | 基本信息（level：标准/高阶） |
| `domainGroup / area` | 默认分类 |
| `includes` | **默认装配清单**：依赖的 tools/MCP/子技能/片段 ID（创建时自动解析为引用） |
| `content` | 带 `{{变量}}` 的 SKILL.md 骨架（frontmatter + 正文） |
| `variables` | 模板变量定义（name/desc/default），创建时引导填写 |
| `triggerExamples` | 触发示例（同时作为测评用例种子） |
| `usedBy` | 被使用次数（统计） |

**一键创建流程**（dataagent `createSkill()` 亮点）：
1. 选模板 -> 填变量 -> 点"创建技能"。
2. 自动：生成 SKILL.md（变量替换）-> 解析 `includes` 为原子引用 -> 生成测试骨架（triggerExamples 转用例）-> 进入 `draft` 态技能详情页。
3. 不直接发布，用户继续完善后走 PR 流程。

#### 5.3.2 片段库（Snippet Library）

借鉴 dataagent `SnippetLibrary`，提供可复用的"积木"：

**标准片段类型**（泛化 dataagent 4 类，可扩展）：
| 类型 | 用途 | 示例 |
|---|---|---|
| `constraint` | 约束/规则 | "SQL 必须带 LIMIT"、"禁止删除操作" |
| `output-format` | 输出格式 | "JSON Schema 输出规范" |
| `tool-usage` | 工具调用模板 | "标准搜索->读取->总结" 调用模式 |
| `checklist` | 检查清单 | "发布前自检清单" |
| `prompt` | 通用 prompt 片段 | 角色设定、语气约束 |

**片段字段**：`title / description / type / version / content(支持 {{变量}}) / variables(自动提取) / usedBy / visibility`。

**一键加入**：
- 技能编辑器内提供"插入片段"入口，从片段库选片段，以**原子引用块**插入当前 SKILL.md（只读胶囊）。
- 片段可被多技能引用，`usedBy` 统计复用度。

**版本隔离**（dataagent 亮点）：
- 片段保存生成新版本；已引用旧版的技能**不受影响**。
- 片段升级后，引用方详情页提示"片段有新版本"，需显式确认才升级（避免静默行为漂移）。

#### 5.3.3 模板管理

- 管理员视图：CRUD 模板/片段、设可见性、查看 `usedBy`、启用/停用。
- 模板/片段同样走版本管理（发布即快照）。
- 模板/片段可纳入测评（作为引用装配完整性检查的一部分）。

#### 5.3.4 技能编辑器（新增，当前缺失）

当前应用内**无技能编辑器**（技能只能外部文件系统编辑）。V2.0 需新增基于 CodeMirror 的技能编辑器：
- SKILL.md 正文编辑 + frontmatter 表单。
- **原子引用胶囊**渲染与保护（dataagent `SkillFileEditor` 亮点）。
- 文件树侧栏（多文件技能：SKILL.md + references/ + scripts/ + tests/）。
- 插入片段/引用资源入口。
- 实时校验（frontmatter 合法性、引用是否存在、description 结构）。

---

### 5.4 模块四：Skill 编译（SOP -> Workflow）

**目标**：把"长 SOP、固定流程"的自然语言 skill，一键编译为**确定性 Workflow JS 脚本**（项目现有 Workflow 引擎），再以"简约 skill"形式注册，提升执行可复现性、降 token、降不确定性。

**决策依据**：编译目标＝项目现有 Workflow 引擎（确定性 JS，含 `agent()/parallel()/pipeline()` 等 API）。

#### 5.4.1 编译流程

```
 长 SOP SKILL.md ──▶ ① 结构化分析 ──▶ ② Workflow 生成 ──▶ ③ 简约 skill 包装 ──▶ ④ 等价性校验
   (自然语言)        (LLM 辅助)        (JS 脚本)          (薄 wrapper)        (测评回归)
```

1. **结构化分析**（LLM 辅助）：解析 SKILL.md 的 SOP，识别：
   - 步骤序列、每步的输入/输出、所需工具调用。
   - 分支/循环/并行点。
   - 可确定性步骤 vs 需判断/创意的步骤（标注"需人工确认"）。
   - 输出**编译报告**：步骤映射表、工具依赖、可编译度评分（0-100%）。
2. **Workflow 生成**：把每步映射为 Workflow 引擎调用（`agent()` / `parallel()` / `pipeline()`），产出 `.js` 脚本文件，存入技能文件树 `workflow.js`。
3. **简约 skill 包装**：生成一个**薄 SKILL.md wrapper**——description 指向 workflow，正文极简（"本技能由 workflow 执行，调用 workflow.js"）。注册为**独立技能**（`isCompiled=true`，`sourceSkillId` 指向源技能），不覆盖源技能。
4. **等价性校验**：用源技能的测评用例集（§5.5）跑编译产物，对比结果，验证行为等价；不等价的步骤标注差异。

#### 5.4.2 产物与对比

- **源 skill**（保留）：长 prompt，LLM 自由解释，灵活但不确定、费 token。
- **编译 skill**（新增）：Workflow 确定性执行，可复现、省 token，但丧失灵活判断。
- 详情页提供"源/编译"切换 + 对比报告（步骤映射、token 节省、等价性、可编译度）。
- 两者可并存，用户按场景选用（需要判断用源，固定流程用编译）。

#### 5.4.3 适用边界与回退

- **可编译度高**（固定 SOP、少判断）-> 推荐编译。
- **可编译度低**（大量创意/判断）-> 编译器提示"不建议编译"，仍可强制但标注风险。
- 编译产物是独立技能，可删除/回退，不影响源技能。
- 源 skill 更新后，可"重新编译"生成新版本（走 PR + 测评门禁）。

> 现状：无任何 workflow 编译能力（技能为单文件 markdown，无控制流）。V2.0 新增编译器 + Workflow 产物注册。

---

### 5.5 模块五：Skill 测评

**目标**：提供可执行、可度量、可门禁的测评能力，作为发布质量门禁与持续改进抓手。

> **说明**：用户参考的 GitHub `alchaincyf/darwin-skill` 仓库因网络限制无法访问。本模块基于 **skill 评测通用最佳实践 + dataagent 测试四分类法 + 召回 Badcase 闭环**设计。若需严格对齐 darwin-skill 具体能力，可后续补充。

#### 5.5.1 测评维度（泛化 dataagent 四分类）

| 维度 | 验证什么 | 指标 |
|---|---|---|
| **触发路由** | 该不该触发本 skill（召回准确率） | 触发准确率、误触发率 |
| **引用装配** | 依赖的 tools/MCP/片段/子技能是否完整加载 | 装配完整率、缺失项 |
| **安全合规** | 是否越权、是否泄露、是否执行危险操作 | 安全违规数（0 为通过） |
| **结果质量** | 结论正确性、可解释性、证据充分性 | 正确率、可解释性评分 |
| **效率** | token 消耗、耗时、轮次 | 平均 token、平均耗时 |

#### 5.5.2 测试用例集

- 每个 skill 一组用例，字段（扩展 dataagent `SkillTestCase`）：`id / title / category(五维度之一) / input(prompt) / expected / status(passed/failed/pending) / duration / detail`。
- 支持**导入导出**（JSON）、批量执行、用例分组。
- 模板的 `triggerExamples` 自动转为触发路由用例种子。

#### 5.5.3 真实执行引擎（修复 dataagent 模拟执行的短板）

- 测评**真实执行**技能：复用 `agent-session-runtime`（Docker / 本地）拉起一个临时 Agent turn，喂入用例 input，采集输出与轨迹。
- 不用 `setTimeout` 模拟；采集：触发判断、引用加载、工具调用链、最终输出、token/耗时。
- 执行隔离：测评用独立 runtime 上下文，不污染用户 workspace。

#### 5.5.4 评分与展示

- 用例通过率 + 五维度得分 + 综合质量分（加权）。
- **通过率/质量分仅在详情页展示**（详情页显示维度雷达图 + 通过率），**列表行不显示通过率进度条**（保持列表简洁，进度条含义模糊已移除）。
- 测评结果写入技能主数据 `qualityScore`。

#### 5.5.5 发布门禁

- PR merge 前**必须通过测评**（通过率达标 + 安全维度 0 违规）。
- 测评不达标 -> 阻止 merge，PR 显示失败用例与维度短板。
- owner/管理员可设通过率阈值（租户级策略）。

#### 5.5.6 Badcase 闭环（借鉴 dataagent metric-recall，上移到 skill 层）

```
 线上真实使用 ──▶ Badcase 识别 ──▶ 人工复核 ──▶ 沉淀为测试用例 ──▶ 回归测评 ──▶ 改进 skill
   (触发错/结果差)   (LLM 辅助+置信度)   (确认)        (加入用例集)         (防止退化)
```

- 线上 session 产出中识别 badcase：该触发没触发、不该触发却触发、结果质量差。
- LLM 辅助识别 + 置信度 -> 人工复核确认 -> 一键沉淀为测试用例。
- 形成"使用 -> badcase -> 用例 -> 改进"的持续质量闭环。

#### 5.5.7 A/B 对比

- 同一用例集对比两版本效果：编译前后（§5.4）、description 优化前后（§5.6）、PR 前后。
- 输出维度差异报告，辅助决策。

> 现状：`skill-presets.js:596-637` `validatePreset` 仅校验 SKILL.md 能否解析，不执行不评估。V2.0 新增真实执行测评 + 门禁 + Badcase 闭环。

---

### 5.6 模块六：召回优化（description 优化）

**目标**：让好技能被准确发现。优化 skill 的 description 与分类，提升搜索召回率与准确率。

#### 5.6.1 description 结构化

把当前"自由文本取第一段"升级为**结构化 description**（写入 `SkillMaster.description`）：

```yaml
description:
  summary: 一句话能力说明（≤80字，列表展示用）
  triggers: [触发场景关键词]        # 召回主信号
  notFor: [不适用场景]              # 负向信号，降低误召回
  capabilities: [能力点]
  keywords: [同义词/别名]           # 扩展召回
```

- 编辑器提供结构化表单 + 实时预览生成的 description。
- 校验：summary 长度、triggers 非空、无冗余。

#### 5.6.2 召回测评

借鉴 dataagent `MetricRecall.vue` 的 `runRecallTest`，迁移到 skill 层：
- 给定一批 query（含正例/负例），统计该 skill 的**召回率（hitRate）**与**准确率（precision）**，Top-K 命中分析。
- 每个候选 query 返回：是否命中、置信度、候选列表、命中理由。
- 结果写入 `recallMetrics`。

#### 5.6.3 自动优化建议

- LLM 分析：当前 description + 召回测评结果 + badcase -> 给出优化建议（补关键词、明确边界、调措辞、修正分类）。
- 一键应用建议 -> 生成 description 新版本 -> A/B 验证（同 query 集对比召回率）-> 提升才采纳（走 PR + 测评）。

#### 5.6.4 召回 Badcase 闭环

- 线上"该触发没触发 / 不该触发却触发"的 case -> 沉淀为召回测试用例（与 §5.5.6 badcase 闭环共用机制，分类为"触发路由"）。
- 反哺 description 优化与分类修正。

#### 5.6.5 搜索升级

- 后端从 `includes()` substring 升级为**相关度排序**：关键词权重（triggers > keywords > summary）+ 结构化 description 加权 + 质量分加权。
- 可选：embedding 向量召回（后续迭代，作为 P2）。
- 前端搜索结果按相关度排序，高亮命中字段。

> 现状：前后端均 substring 匹配，description 无结构约束。V2.0 结构化 description + 召回测评 + 自动优化 + 相关度排序。

---

## 6. 端到端闭环使用旅程

### 6.1 普通使用者

打开技能 Tab -> 技能市场默认列表（仅已发布技能，已安装置顶）-> 按领域筛选条找分类 -> 搜索关键词（召回优化命中）-> 点开技能进入只读预览子页，看质量分/通过率/SKILL.md 概览与引用片段完整内容 -> 列表行内或详情页「安装」-> 写入 `.claude/skills/`，下个 Agent turn 生效。无需"启用"步骤，安装即生效；不用了点「卸载」移除。

### 6.2 贡献者（非专业开发者）

模板中心选模板 -> 填变量一键创建 -> 编辑器中插入片段库的约束/输出格式片段 -> 写几个测试用例 -> 跑测评自检 -> 提 PR -> reviewer 评审 -> 测评门禁通过 -> owner merge -> 发布。若 skill 是长 SOP，owner 可一键编译为 Workflow skill。

### 6.3 技能 Owner / 管理员

收到 PR -> 看 diff + 行级评论 -> 查测评报告 -> approve/merge（生成版本快照）-> 监控线上召回/badcase 看板 -> 对低召回 skill 用"自动优化建议"改进 description -> 重新发布。管理员维护分类体系、模板/片段库、预装预设。

---

## 7. 信息架构与 UI 设计

### 7.1 入口与导航

- 把 `SkillMarketDialog` 弹窗升级为**主工作区"技能"Tab**（与 Files 平行），承载全部能力。
- 顶部子导航（pill tabs）：

```
[ 技能市场 ] [ 我的技能 ] [ 模板中心 ] [ 片段库 ] [ 贡献(PR) ] [ 测评 ] [ 管理 ]
```

- "技能市场"为默认页（仅已发布、列表优先、只读预览 + 安装/卸载）；"我的技能"为本地 `.claude/skills` 研发工作台（编辑/调试/测评全功能）；"管理"仅管理员可见。
- 已移除原「我的安装」tab。

### 7.2 默认市场列表视图（易用性核心）

```
┌──────────────────────────────────────────────────────────────────┐
│ 技能市场                          已发布 42 · 已安装 8 · 待更新 2  │
│ 浏览已发布技能，安装 / 卸载到当前 workspace                       │
├──────────────────────────────────────────────────────────────────┤
│ [搜索框]                                                          │
│ 领域筛选: ● 通用(12)  ● 行业(18)  ● 经营(10)  ● 未分类(2)         │
├──────────────────────────────────────────────────────────────────┤
│ ● code-review      通用  代码评审与改进建议   v4         [卸载] › │  ← 已安装置顶
│ ● bug-diagnose     通用  Bug 根因诊断         v3         [卸载] › │
│ ● ad-revenue       行业  广告收入异动分析     v5         [卸载] › │
│ ● deploy-helper    经营  一键部署与回滚   v6 △待更新   [安装] ›  │
│ ● data-export      经营  数据导出与校验       v2         [安装] › │
│ ...                                                               │
└──────────────────────────────────────────────────────────────────┘
共 N 个
```

- **统一列表头部**（与「我的技能」共用同一组件 `listHeader`）：标题栏（标题 + 副标题 + 右侧摘要 chip）+ 其下筛选卡（搜索框 + 领域筛选条）。我的技能页右侧换为「↑ 上传技能」「+ 新建技能」按钮、筛选卡多一行状态筛选条，其余结构一致（不再两套风格）。
- **仅展示已发布技能，不显示状态徽章**（市场无 in_review/draft）。
- 行内：分类色点 + 名称 + version + 徽章（编译 / 待更新 / 来源）+ 一级分类 + summary + **安装/卸载按钮**（依据 `local` 判定，内联）+ › 进入详情。**列表行不展示通过率进度条、不展示置顶标记**（保持简洁；通过率/质量分在详情页展示）。
- 已安装（`local && published`）置顶排序，其后按相关度/质量分。
- **无启用/禁用开关、无"从 GitHub 安装"按钮、无状态筛选、无置顶按钮/标记**。
- 点击行（或 ›）-> 递进进入整页详情子页（面包屑 + 返回），非右侧抽屉。

### 7.3 技能详情子页（双模式：市场只读预览 / 我的技能全功能）

详情子页采用递进式整页导航（面包屑 `技能市场或我的技能 / <技能名>` + 「← 返回」）。**按入口分两种模式**：

**A. 技能市场只读预览模式**（从技能市场进入，仅已发布技能）：

```
┌─────────────────────────────────────────────────────────────────┐
│ ← 返回  / 技能市场 / code-review   [只读预览]                    │
│ code-review   v4   owner: alice   召回 91%        [安装] / [卸载] │
│ [ 概览 ] [ 测评 ] [ 版本 ]                                       │
├─────────────────────────────────────────────────────────────────┤
│ 概览:   摘要 + 触发词/能力胶囊 + SKILL.md 只读预览                │
│         (引用胶囊可点击定位) + 引用片段详情(类型/版本/完整内容)    │
│         ⚠ 市场为只读预览，编辑请在「我的技能」中操作本地副本      │
│ 测评:   通过率摘要 + 维度雷达 + 用例表（无"运行测评"按钮）        │
│ 版本:   时间线 + diff（无"回滚"按钮）                            │
└─────────────────────────────────────────────────────────────────┘
```

- 仅 3 个只读标签：概览 / 测评 / 版本。不提供编辑、调试、设置。
- 头部仅「安装/卸载」按钮（依据 `local`），不提供「提 PR」（提 PR 属研发动作，归我的技能）。
- 测评页隐藏「运行测评」、版本页隐藏「回滚」--市场只能看，不能改/不能跑。
- **概览页展示引用片段的完整内容**：SKILL.md 以只读胶囊标注所引用的片段（约束/输出格式/工具调用等），胶囊可点击定位；胶囊下方「引用的片段」区按片段逐张展开**类型徽章 + 标题 + 版本 + 完整正文**，让用户在安装前即可看清该技能依赖哪些片段、片段实际约束了什么（避免"只看到片段名、不知内容"的盲装）。片段版本为发布快照固定值，与 §4.3 原子引用一致。

**B. 我的技能全功能模式**（从我的技能进入，本地 `.claude/skills` 技能）：

```
┌─────────────────────────────────────────────────────────────────┐
│ ← 返回  / 我的技能 / code-review   [市场安装]                    │
│ code-review   v4   published   owner: alice        [提 PR]       │
│ [ 编辑 ] [ 调试 ] [ 测评 ] [ 版本 ] [ 设置 ]                     │
├─────────────────────────────────────────────────────────────────┤
│ 编辑:   文件树(SKILL.md/references/scripts/tests) + CodeMirror  │
│         编辑器(引用胶囊只读·点击定位) + frontmatter表单          │
│         + 插入片段入口 + 引用片段详情(类型/版本/完整内容·只读)    │
│ 调试:   playground 对话 + 执行轨迹(触发->装配->工具->答案)        │
│ 测评:   通过率摘要 + 维度雷达 + 用例表 + 运行/新建 + Badcase    │
│ 版本:   时间线 + diff + 回滚                                    │
│ 设置:   负责人/协作者/分类/废弃                                  │
└─────────────────────────────────────────────────────────────────┘
```

- 完整 5 标签：编辑 / 调试 / 测评 / 版本 / 设置（借鉴 dataagent 三标签并扩展）。
- 头部展示来源胶囊（市场安装/本地创建/文件上传）+ 状态徽章 + 「提 PR」。
- 支持编辑、调试、运行测评、回滚、废弃等全部研发态操作。
- **编辑页同样展示引用片段的完整内容**：编辑器下方「引用的片段」区按片段展开类型/版本/完整正文（只读）；SKILL.md 内的引用胶囊点击可定位到对应片段卡片。片段正文为只读--片段本身的编辑统一在「片段库」进行（§5.3.2 版本隔离），编辑态只呈现内容、不改片段，与原子引用防漂移机制一致。

### 7.4 其他视图

- **模板中心**：模板卡片网格（level 徽章 + usedBy）+ "新建模板"。
- **片段库**：片段列表（类型筛选）+ "引用到当前 skill"开关 + 版本升级提示。
- **贡献(PR)**：租户内 PR 列表（open/merged/closed）+ PR 详情（diff + 行级评论 + 测评门禁状态 + approve/merge）。
- **测评**：租户技能质量看板（通过率排行 + badcase 队列 + 召回率看板）。

---

## 8. API 设计

### 8.1 新增接口（CCUI 侧，前缀 `/api/skill-market`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/skills` | 列表（支持 category/tag 筛选 + 相关度搜索 + 已安装置顶排序）；市场仅返回 `published` |
| GET | `/skills/:name` | 详情（含质量分、召回指标、版本） |
| GET | `/workspace/skills` | 我的技能：当前 workspace `.claude/skills` 本地技能列表（含 `localSource`、`status`） |
| POST | `/skills/:name/install` | 安装：写入 `.claude/skills/`（`local=true`，`localSource='market'`），下个 turn 生效 |
| DELETE | `/skills/:name/install` | 卸载：从 `.claude/skills/` 移除（`local=false`） |
| PATCH | `/skills/:name/install-state` | 更新置顶等（`pinned`/`lastUsedAt`）；**不含 `enabled`** |
| POST | `/workspace/skills/upload` | 上传技能（SKILL.md/文件夹，frontmatter 校验，导入为 `draft`，`localSource='uploaded'`） |
| GET | `/categories` | 租户分类体系（树） |
| POST/PUT/DELETE | `/admin/categories` | 管理分类（管理员） |
| GET | `/templates` | 模板列表（平台/租户/个人） |
| POST | `/templates/:id/instantiate` | 从模板一键创建技能草稿（`localSource='created'`） |
| GET/POST/PUT/DELETE | `/snippets` | 片段 CRUD |
| POST | `/snippets/:id/attach` | 片段一键加入指定 skill（生成引用） |
| GET | `/skills/:name/prs` | 技能的 PR 列表 |
| POST | `/skills/:name/prs` | 提 PR |
| GET/POST | `/prs/:id/reviews` | PR review / 行级评论 |
| POST | `/prs/:id/merge` | merge（含测评门禁校验） |
| POST | `/skills/:name/compile` | 一键编译为 Workflow skill |
| GET | `/skills/:name/compile-report` | 编译报告 |
| GET/POST | `/skills/:name/test-cases` | 测评用例 CRUD |
| POST | `/skills/:name/eval` | 执行测评（真实 runtime） |
| GET | `/skills/:name/recall` | 召回测评 |
| POST | `/skills/:name/recall/optimize` | description 自动优化建议 |

### 8.2 变更接口

- `GET /skills` 响应增加：`category`、`qualityScore`、`recallMetrics`、`localState{local,localSource,pinned,lastUsedAt}`；已安装（`local && published`）置顶排序。**移除 `enabled` 字段**。
- 安装/卸载语义对齐 `.claude/skills` 文件系统：安装 = 写入目录，卸载 = 移除目录（不再有 enable/disable 中间态）。
- 已移除"从 GitHub 安装"接口（不再提供 GitHub HTTPS 拉取途径）。
- publish 流程改造：不再"仅创建者直接 publish"，改为"提 PR -> 测评门禁 -> merge 自动发布版本"。

### 8.3 远程市场后端契约（data-agent 服务需支持）

PR/版本快照/测评执行/召回索引等能力需远程后端新增：分支与 PR 数据模型、版本快照存储、测评执行端点、召回索引与相关度排序。CCUI 通过现有 `/data-agent/api/skill/...` 代理透传（沿用 HMAC 签名 + 租户 header）。

---

## 9. 数据库设计

### 9.1 CCUI 侧 schema 变更

**扩展 `workspace_skill_market_imports`（安装态缓存，权威来源为 `.claude/skills` 文件系统）：**

```sql
ALTER TABLE workspace_skill_market_imports ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_skill_market_imports ADD COLUMN local_source TEXT;   -- market|created|uploaded
ALTER TABLE workspace_skill_market_imports ADD COLUMN category TEXT;
ALTER TABLE workspace_skill_market_imports ADD COLUMN last_used_at DATETIME;
-- version 字段已存在（installed version）
-- 已移除 enabled 列：安装/卸载二元态，无启用/禁用中间层
```

**新增表（示例）：**

```sql
-- 租户分类体系
CREATE TABLE tenant_skill_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  parent_id INTEGER,                 -- NULL=一级
  code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(tenant_id, code)
);

-- 片段（租户/个人）
CREATE TABLE skill_snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER,
  title TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'tenant',  -- tenant|personal
  used_by INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 模板（租户/个人；平台内置由后端提供）
CREATE TABLE skill_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER,
  title TEXT NOT NULL, description TEXT, level TEXT, icon TEXT,
  domain_group TEXT, area TEXT,
  content TEXT NOT NULL, includes_json TEXT, variables_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'tenant',
  used_by INTEGER NOT NULL DEFAULT 0
);

-- 技能引用关系（CCUI 缓存，主权威在后端）
CREATE TABLE skill_references (
  skill_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
  ref_version INTEGER, pinned_snapshot TEXT,
  PRIMARY KEY(skill_id, kind, ref_id)
);
```

### 9.2 远程市场后端 schema（契约，由 data-agent 团队实现）

- `skill_branches`（贡献分支）、`skill_pull_requests`（PR）、`skill_pr_reviews`/`skill_pr_comments`（评审）、`skill_versions`（版本快照）、`skill_test_cases`/`skill_eval_runs`（测评）、`skill_badcases`（badcase）、`skill_recall_index`（召回索引）。

### 9.3 存储介质对齐

- 统一用 SQLite（CCUI 侧）取代 B 子系统的文件 `metadata.json`；废弃 `SkillsPanel` 死代码与文件元数据。
- 远程市场为技能内容与版本快照的 source of truth；CCUI 缓存摘要与安装态。

---

## 10. 权限模型

沿用现有 workspace 权限模型（owner / edit / view / system admin），叠加技能协作角色：

| 能力 | view | edit | owner | admin |
|---|---|---|---|---|
| 浏览市场/只读预览/安装/卸载 | ✅ | ✅ | ✅ | ✅ |
| 我的技能：编辑/调试/测评本地技能 | ✅ | ✅ | ✅ | ✅ |
| 创建草稿/上传技能/提 PR | ✅ | ✅ | ✅ | ✅ |
| Review 评论 | ✅（被指派） | ✅ | ✅ | ✅ |
| Approve/Merge | ❌ | ❌ | ✅ | ✅ |
| 编译技能 | ❌ | ✅ | ✅ | ✅ |
| 模板/片段管理 | ❌ | ❌ | ❌ | ✅ |
| 分类体系管理 | ❌ | ❌ | ❌ | ✅ |
| 测评用例 CRUD | ✅（读） | ✅ | ✅ | ✅ |

- 协作范围**仅限同租户**：跨租户成员不可见、不可 PR（沿用 `X-Data-Agent-Tenant` 隔离）。
- 删除/废弃技能需 owner/admin 二次确认。

---

## 11. 分期交付计划

| 阶段 | 范围 | 价值 |
|---|---|---|
| **MVP** | ①易用性重构（市场只读预览/列表优先/置顶/分类/安装卸载内联 + 我的技能本地列表）+ 本地技能 schema 扩展（`local`/`localSource`） | 立刻解决最痛的易用性问题 |
| **P1** | ③模板/片段 + 技能编辑器（含引用胶囊）+ ⑥description 结构化与相关度搜索 | 降低开发门槛、改善召回 |
| **P1** | ②租户内 PR/Review/Merge + 版本快照 | 打破单人发布瓶颈 |
| **P2** | ⑤测评（真实执行 + 门禁 + Badcase 闭环） | 质量可度量、可门禁 |
| **P2** | ④Skill 编译（SOP->Workflow） | 长流程技能确定性化 |
| **P3** | ⑥召回自动优化建议 + embedding 向量召回 + 测评 A/B | 召回持续优化 |

> MVP 可独立交付见效；P1/P2 内部模块可并行；测评门禁依赖 PR 机制就绪，编译依赖测评就绪。

---

## 12. 风险与待定问题

| 项 | 风险/问题 | 应对 |
|---|---|---|
| 远程后端依赖 | PR/测评/召回需 data-agent 服务支持，跨团队协作 | CCUI 侧先做 UI + 契约；后端按接口需求排期；可先 mock 后端推进前端 |
| 编译等价性 | LLM 辅助编译可能引入行为偏差 | 编译产物强制走测评回归；标注不可确定步骤需人工确认 |
| 测评成本 | 真实执行测评消耗 runtime 资源 | 限频、用例分级（核心用例必跑）、异步执行 + 结果缓存 |
| darwin-skill 对齐 | 仓库无法访问，测评设计基于通用最佳实践 | 标注假设；后续获取 darwin-skill 细节后对齐补充 |
| 分类治理 | 租户自定义分类可能混乱 | 提供默认模板 + 自动归类建议 + 管理员定期治理 |
| 协作仅租户内 | 跨租户无法复用优质 skill | 后续迭代可评估"全局市场发布"作为可选项（当前明确非目标） |
| 死代码迁移 | `SkillsPanel`/文件元数据废弃需平滑过渡 | 统一入口后逐步下线，保留 reconcile 逻辑兼容存量 |

## 13. 待定问题（需进一步确认）

1. **远程市场后端归属**：data-agent 服务是否由本团队可控？若不可控，PR/测评/召回的落地节奏需与对方对齐。
2. **Workflow 引擎暴露**：项目现有 Workflow 引擎（JS）是否已在 claudecodeui 应用层可调用？编译产物如何在 Agent runtime 中执行？需确认调用路径。
3. **测评 runtime 隔离**：复用 `agent-session-runtime` 做测评执行的资源配额与隔离方案。
4. **分类默认模板**：是否需要按行业预置一套默认分类体系（参考 dataagent 的 common/industry/capability）？
5. **darwin-skill 对齐**：是否需要严格复刻 darwin-skill 的测评能力？若是，请提供其关键能力点。

---

## 附录 A：名词表

| 名词 | 说明 |
|---|---|
| 技能空间 | 租户内所有技能的集合（主数据 + 版本 + 协作元数据） |
| 安装态 | 某 workspace 安装/卸载/置顶某技能的状态（本地 `.claude/skills` 存在与否） |
| 原子引用 | 以只读胶囊插入 SKILL.md 的版本固定依赖块 |
| 发布即快照 | 发布时固定所有引用版本，保证可复现 |
| 编译 skill | 长 SOP 技能编译为 Workflow JS 后的简约技能 |
| 测评门禁 | PR merge 前必须通过测评的强制检查 |
| Badcase 闭环 | 线上错误案例 -> 沉淀为测试用例 -> 回归改进的循环 |

## 附录 B：参考

- V1 PRD：`docs/superpowers/prds/2026-05-05-skills-tools-market-prd.md`
- V1 设计：`docs/superpowers/specs/2026-05-04-skills-tools-market-design.md`
- 远程市场 API：`docs/skill-market-api.md`
- dataagent 原型：`/Users/song/Projects/opensource/dataagent/chatui-demo/src/features/skill-management/`（SkillCatalog / SkillDetail / TemplateCenter / SnippetLibrary / SkillFileEditor）
- 用户参考：GitHub `alchaincyf/darwin-skill`（因网络限制未访问，测评模块基于通用最佳实践设计）
