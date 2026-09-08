# 会话生成与调优 Skill POC

在已完成会话的输入框工具栏点击 **会话 Skill**。POC 使用服务端持久化记录，不使用浏览器已加载的部分消息，也不恢复原模型 session。

## 两条验证路径

1. **生成新技能**：完成一个自包含文本任务，输入新技能名，点击“生成并验证”。系统汇总用户的初始输入与后续纠正，从助手消息中选择最终实质结果（排除寒暄），生成 `SKILL.md`，在独立模型调用中重跑并比较输出；不通过则按差异修正。
2. **调优已有技能**：在新会话用 `/skill-name` 完成任务，继续纠正到满意。在同一会话打开“会话 Skill”，选择调优并输入原技能名。系统先重跑现有技能，再修正失败项，同时重跑此前保留的案例。

默认最多 3 轮，API 可指定 1–5 轮；达到上限会显示“未通过”，保留候选和差异，不替换旧技能。通过全部案例后写入当前工作区 `.claude/skills/<name>/SKILL.md`，刷新命令列表，下次可直接调用。

## 试用示例

- 第一段会话：输入“计算12和8的合计，返回JSON”；继续要求“total字段是字符串，保留两位小数”，最终结果为 `{"total":"20.00"}`。生成 `sum-report-poc`。
- 第二段会话：调用 `/sum-report-poc`，输入“计算5和7的合计”；纠正“当指定币种CNY时，额外返回currency字段”，最终结果为 `{"total":"12.00","currency":"CNY"}`。对 `sum-report-poc` 调优。
- 查看第二次任务的逐轮反馈；旧案例仍需返回原结构，新案例需满足新增条件。若旧技能本来就能完成新输入，会直接验证通过，无须强行修改。

## 验证与数据边界

- 生成器、优化器和评判器可以看到目标输出。执行器只收到候选 skill 与汇总输入，不接收历史、目标或评分反馈。每次调用关闭原会话恢复、工具、MCP、工程技能加载和自动记忆。
- 候选若逐字复制了较长的完整目标答案（包括输出示例），会先要求改为占位符，再执行；该检测不能证明没有改写后的答案或短常量泄漏，因此仍需新案例验证。
- “通过”表示独立模型评判认为文本符合输入与目标；不保证任意新输入上的正确性。测试脚本另外用已知 JSON 结果做确定性断言。
- 仅支持输入数据已包含在用户消息中的文本任务、单文件本地 `SKILL.md`。缺失文件、附件、网页、数据库内容，或依赖外部操作/文件产物的任务会被拒绝或评为不通过。POC 不验证脚本、代码修改或 Office 文档产物。
- 目标取一个助手消息的原文，不合并多个消息中的产物。用户引用“第二种”“上面的内容”但用户消息中没有对应数据时，需要先补全输入。
- 这是手动触发、自动迭代的 POC；尚未接入会话完成后无感触发。生成后的技能由 Claude 的工作区技能机制加载。
- 来源记录、旧 skill、每轮结果及案例保存在服务端 `$CLOUDCLI_DATA_ROOT/session-skill-learning/<scope-hash>/<skill-name>/`；未配置数据根目录时使用 `~/.cloudcli/session-skill-learning/`。禁止存放在共享工作区内，避免其他工作区成员经文件接口读取私有会话。scope 包含租户、用户、工作区；只复用相同用户范围的案例，最多 12 个。
- 对完全相同的汇总输入，新确认的目标替代旧目标，避免将相互矛盾的输出同时作为验收要求；旧记录仍保留。
- 接口要求工作区编辑权限及原会话归属。通过后保存前再次校验 skill 版本；遇到并发人工编辑不会覆盖。运行中任务有总超时，同一工作区同名 skill 不能并发学习。
- 任务状态暂存在内存，服务重启后不会自动恢复运行任务；磁盘记录仍保留。UI 支持关闭弹窗后继续后台执行及同一浏览器标签页恢复查询。

## API

沿用现有登录认证与 `tenantId` 传参：

```http
POST /api/workspaces/:workspaceId/session-skill-jobs
Content-Type: application/json

{"tenantId":2,"provider":"claude","sessionId":"...","operation":"generate","skillName":"sum-report-poc","maxIterations":3}
```

返回 `202 {job}`，随后 `GET /api/workspaces/:workspaceId/session-skill-jobs/:jobId?tenantId=2` 查询。`operation` 可为 `generate` 或 `optimize`。状态为 `queued/running/succeeded/failed/exhausted`。

结果包含汇总输入 `input`、目标 `expectedOutput`、实际输出 `actualOutput`、候选 `skillContent`、逐轮 `iterations` 和回归 `testCases`。`succeeded` 表示技能已保存；若附带 `warning`，表示保存成功但案例记录写入遇到问题。

## 开发验证

```sh
node --test server/services/session-skill-learning.test.js server/services/session-skill-learning-runtime.test.js server/services/session-skill-learning-service.test.js
TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/routes/session-skill-jobs.test.js
```

核心测试验证生成→失败→修正、调优后的旧案例回归、输入与目标隔离、寒暄选择、达到上限、无效评判、超时不迟到保存，以及真实本地技能读写、版本和权限边界。模型响应在自动化测试中采用注入的测试替身，避免依赖生产凭据或外部服务。

使用项目已有 `.env` 模型配置，运行合成输入的真实模型验证：

```sh
node scripts/session-skill-live-poc.mjs --with-repair
```

脚本使用同一个 Claude 适配器，在临时配置目录下调用 SDK 自带的本机 Claude 可执行文件；不读取真实会话，不访问生产数据库，也不替换正式技能。它验证生成、新输入回归，以及一个明确注入了错误截断规则的旧技能能否被修正。`report.json`、`repair-report.json`、每轮输出和生成的技能保存在脚本打印的临时目录中。此脚本验证模型与学习引擎；工作区持久化和接口权限另由服务/路由测试覆盖。

2026-09-08 已用现有模型配置完成真实验证：

- 生成：输入 12 与 8，经用户纠正要求 total 字符串和两位小数，重跑得到 `{"total":"20.00"}`，通过。
- 新输入：3.25 与 4.50，优惠 0.50，并增加币种字段，得到 `{"total":"7.25","currency":"CNY"}`；同时旧案例通过。此案例原技能已适应新要求，没有无必要的改写。
- 故障修复：给旧技能明确注入“截断两位小数”的错误规则。输入 1.236 与 2.001 时，首轮输出 `{"total":"3.23"}`，评判未通过；自动优化后第二轮输出 `{"total":"3.24"}`，新旧两个案例均通过。

真实验证另外检查了 JSON 数值，不能仅凭模型自报“通过”。该验证未覆盖生产 Docker/数据库到浏览器的完整部署链路。
