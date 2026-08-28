# Skill 来源、编辑与校验实施计划

## 目标

修复本地技能发布后来源误判和上传技能需要移除两次的问题；允许所有“我的技能”在当前工作区编辑；保留市场技能的远端绑定；增加本地修改保护、严格的名称/目录一致性校验以及可组合的解析诊断。

设计依据：`docs/superpowers/specs/2026-08-28-skill-origin-editing-and-validation-design.md`

## 实施原则

- 先以失败测试固定现有缺陷，再逐层修改数据、服务、路由和页面。
- 来源、远端绑定、本地安装和本地修改分别建模，不再通过单个市场记录反推全部状态。
- 所有破坏性覆盖和目录重命名都由后端做最终校验，前端只负责展示结构化确认流程。
- 不改变远端技能市场协议，不删除远端技能。

## 任务 1：扩展市场绑定持久化模型

涉及文件：

- `server/database/multitenancy-schema.js`
- `server/database/multitenancy-db.js`
- `server/database/multitenancy-db.test.js`

步骤：

1. 为 `workspace_skill_market_imports` 增加 `origin`、`binding_type` 和 `baseline_hash` 字段，使用启动时 `ensureColumn` 兼容已有数据库。
2. 扩展 hydrate/normalize/replace 逻辑，确保完整往返新字段。
3. 增加按不区分大小写名称查找和重命名绑定的方法，纯大小写变更也必须安全。
4. 对旧记录采用保守默认值，并允许服务层在具备本地元数据和当前账号信息时补齐显式来源。
5. 增加数据库测试，覆盖新库、旧库迁移、字段往返、绑定重命名和大小写冲突。

完成标准：数据库升级不删除现有绑定，新字段能被所有读写路径保留。

## 任务 2：统一 manifest 解析、诊断和名称冲突规则

涉及文件：

- `server/services/workspace-skills.js`
- `server/services/workspace-skills.test.js`

步骤：

1. 将 `parseSkillManifest` 改为返回结构化 `diagnostics`，同时保留兼容的 `parseError` 汇总文本。
2. 要求根目录存在 `SKILL.md`，并校验 frontmatter 的 name、description 以及 name 与目录 basename 完全一致。
3. 根入口缺失时递归查找嵌套 `SKILL.md`，仅将路径和可分析的名称问题加入诊断，不把嵌套文件作为有效入口。
4. 移除本地上传中的 `toLowerCase()`，按 manifest name 原样生成预览和安装目录。
5. 将安装冲突检查改为不区分大小写，覆盖托管源、运行目录和现有元数据。
6. 增加测试：大写名称保留、根入口缺失、嵌套入口、多诊断叠加、名称大小写不一致、`Foo`/`foo` 重名。

完成标准：所有新建/上传/扫描路径使用同一套名称规则，错误包含用户可操作的诊断信息。

## 任务 3：拆分工作区技能来源与编辑权限

涉及文件：

- `server/services/workspace-skills.js`
- `server/services/workspace-skills.test.js`
- `server/routes/workspace-skills.js`
- `server/routes/workspace-skills.test.js`

步骤：

1. `listWorkspaceSkills`、详情和上下文解析优先读取显式 `origin`/`bindingType`，不再把“存在绑定”等同于市场来源。
2. 输出 `bindingType`、`installed`、`published`、`locallyModified`、`diagnostics` 等页面所需字段。
3. 将只允许本地来源的写操作守卫改为允许所有工作区技能编辑；系统内置技能仍不可写。
4. 保持市场导入技能的编辑只作用于当前工作区本地文件。
5. 解析失败技能仍允许文件树读写，便于在页面内修复。
6. 增加路由和服务测试，证明本地已发布技能及市场导入技能都可编辑。

完成标准：编辑权限不再依赖 `origin === local`，但路径穿越、符号链接和系统技能写保护保持不变。

## 任务 4：实现 manifest name 的确认保存与原子目录重命名

涉及文件：

- `server/services/workspace-skills.js`
- `server/services/workspace-skills.test.js`
- `server/routes/workspace-skills.js`
- `server/routes/workspace-skills.test.js`
- `server/database/multitenancy-db.js`

步骤：

1. 扩展保存接口参数，区分“未选择”“同步重命名”“保存但不重命名”。
2. 未选择时返回 `SKILL_DIRECTORY_RENAME_REQUIRED`，附当前名称和目标名称。
3. 同步重命名前执行不区分大小写的工作区重名检查；冲突返回 `SKILL_NAME_CONFLICT`。
4. 使用唯一临时目录处理普通重命名和纯大小写重命名。
5. 同步迁移运行目录、托管源目录、`metadata.json` 键值和数据库市场绑定名称。
6. 为每一步保存补偿信息；失败时按逆序回滚，返回具体失败信息。
7. 用户选择不重命名时保存 manifest，随后由解析器标记名称不一致。
8. 增加测试：确认分支、拒绝分支、大小写重命名、重名阻止和注入失败后的回滚。

完成标准：任何成功响应后目录、元数据和绑定一致；任何失败都不留下半迁移状态。

## 任务 5：增加内容基线和本地修改保护

涉及文件：

- `server/services/skill-market.js`
- `server/services/skill-market.test.js`
- `server/services/workspace-skills.js`
- `server/services/workspace-skills.test.js`
- `server/routes/skill-market.js`
- `server/routes/skill-market.test.js`

步骤：

1. 增加稳定的技能目录摘要算法，按相对路径和文件内容排序计算 SHA-256。
2. 市场导入、市场更新、本地发布和发布更新成功后保存 `baselineHash`。
3. 列表和详情比较当前摘要与基线，输出 `locallyModified`。
4. 市场更新发现本地修改且请求未携带显式覆盖参数时返回 `SKILL_LOCAL_CHANGES`。
5. 确认覆盖后更新本地文件与基线，清除本地修改状态。
6. 对无基线的旧绑定首次建立当前摘要，避免升级后产生错误提示。
7. 增加测试：页面内编辑和外部编辑均能被检测；未确认更新被阻止；确认更新后状态恢复。

完成标准：市场更新不会静默覆盖本地定制，且摘要不受文件遍历顺序影响。

## 任务 6：修复发布、重新导入和一次移除流程

涉及文件：

- `server/services/skill-market.js`
- `server/services/skill-market.test.js`
- `server/routes/skill-market.js`
- `server/routes/skill-market.test.js`
- `server/services/workspace-skills.js`
- `server/routes/workspace-skills.js`

步骤：

1. 本地首次发布写入 `origin=local`、`bindingType=published`，不得将技能转为市场来源。
2. 市场首次导入写入 `origin=market`、`bindingType=imported`。
3. 重新导入已有 `published` 绑定时保留发布关系、远端 ID 和创建者能力。
4. 将“我的技能”移除统一为完整本地清理：运行目录、托管源和本地管理元数据一次删除。
5. 移除时保留数据库远端绑定，将 `installed` 由实际目录状态计算为 false。
6. 技能市场移除入口复用同一清理语义，远端项目随后显示可导入。
7. 增加回归测试：上传技能和新建技能发布后均一次移除；绑定保留；重新导入后创建者仍可发布更新。

完成标准：不再出现“第一次移除变成本地创建、第二次才消失”的状态跳变。

## 任务 7：更新前端类型、标签、悬浮提示和确认弹窗

涉及文件：

- `src/components/skills-market/utils/skillFormatting.ts`
- `src/components/skills-market/utils/skillFormatting.test.ts`
- `src/components/skills-market/SkillsWorkspacePanel.tsx`
- `src/components/skills-market/SkillPublishAction.tsx`
- `src/lib/api.ts`
- 相关前端测试文件

步骤：

1. 扩展 WorkspaceSkill/详情/API 错误类型，接收来源、绑定、修改状态和诊断列表。
2. “我的技能”标签按显式状态组合：本地已发布显示“本地创建 + 已导入”，市场本地修改显示“市场安装 + 本地已修改”。
3. “解析失败”标签增加可访问的悬浮提示，一次展示全部诊断。
4. 将 `detailEditable` 从来源判断改为工作区管理权限判断。
5. 保存 `SKILL.md` 收到重命名确认错误时打开项目统一弹窗；确认或拒绝后携带明确选择重试保存。
6. 市场更新收到本地修改错误时打开覆盖确认弹窗；确认后携带覆盖参数重试。
7. 按创建者和解析状态调整“发布/发布更新”按钮，不允许非创建者发布他人的市场技能。
8. “我的技能”移除统一调用一次完整本地移除，并在成功后刷新市场和我的技能。
9. 增加组件/纯函数测试，覆盖标签组合、tooltip 内容、编辑权限和两类确认流程。

完成标准：页面不再从 `origin` 推断全部行为，错误交互不使用浏览器原生确认框。

## 任务 8：兼容性回归与完整验证

步骤：

1. 运行数据库、工作区技能、技能市场及路由测试。
2. 运行技能页面相关前端测试。
3. 运行 TypeScript、ESLint 和生产构建。
4. 在隔离本地工作区手工验证：
   - 上传含大写 name 的 ZIP，目录大小写保持一致。
   - 本地上传和新建技能发布后显示正确双标签。
   - 两类技能一次移除后从我的技能消失，市场变为可导入。
   - 重新导入后创建者仍可发布更新。
   - 市场技能本地编辑后显示本地修改，市场更新需要确认。
   - 修改 manifest name 的自动重命名、拒绝重命名和重名冲突。
   - 根入口缺失和多个诊断的悬浮提示。
5. 检查 `git diff --check` 和工作树，确保不包含本地数据库、临时 ZIP、构建产物或其他无关文件。

## 建议提交拆分

1. `test(skills): cover skill origin and manifest validation`
2. `feat(skills): persist explicit market binding state`
3. `feat(skills): validate and rename skill directories`
4. `feat(skills): support local edits for market skills`
5. `fix(skills): remove published local skills in one action`
6. `feat(skills): show skill diagnostics and local changes`
7. `test(skills): verify skill lifecycle regressions`

## 完成定义

- 五项用户需求及确认的覆盖保护行为全部实现。
- 新增和既有测试通过，无旧测试被无理由删除或弱化。
- 类型检查、Lint 和生产构建通过。
- 本地手工流程可复现并验证关键状态转换。
- 设计文档与最终实现保持一致；如实现中发现必要偏差，先更新设计说明再交付。
