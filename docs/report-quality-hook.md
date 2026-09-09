# HTML 报告验收与修正

这个示例复用 CCUI 现有的 Hook 和工作区 Skill。用户调用生成技能后，`Stop` Hook 检查报告的验收结果；未通过时，把检查问题交回当前 agent，继续校验或修复。通过后才正常结束，超过次数上限则明确报告失败。

验收比较 HTML 示例的结构、样式与当前数据，不做截图或像素相似度判断。示例使用 Python 3 标准库，不需要安装第三方 Python 包。

## 1. 将示例复制到工作区

在 CCUI 仓库根目录执行，将目标路径替换为需要生成报告的工作区：

```sh
REPORT_WORKSPACE=/absolute/path/to/workspace
cp -R examples/report-quality/. "$REPORT_WORKSPACE/"
```

复制命令包含 `.claude` 和 `.ccui` 隐藏目录。示例包含 HTML 模板、数据文件、两个技能以及 Hook 的工作区配置；`reports/report.html` 由生成技能创建，示例不预置通过验收的产物。若目标工作区已有同名文件，先选择新的测试工作区或保留已有文件的副本。

两个技能分别是：

- `generate-html-report`：读取 HTML 示例和数据，生成报告。
- `check-html-report`：运行确定性检查，写出问题列表和验收结果，供 agent 修复、Stop Hook 读取。

## 2. 配置输入与输出

修改工作区中的 `.ccui/report-quality.json`：

```json
{
  "enabled": true,
  "reference": "reports/example.html",
  "report": "reports/report.html",
  "source": "reports/data.json",
  "checkerSkill": ".claude/skills/check-html-report/SKILL.md",
  "verdict": ".ccui/report-quality-result.json",
  "maxAttempts": 5
}
```

路径均相对于当前工作区。将 `reference` 指向认可的 HTML 示例，`source` 指向本次数据，`report` 指向生成报告。`verdict` 是校验技能写入的结果文件；`maxAttempts` 限制自动修正次数。`enabled: false` 会关闭该工作区的报告验收。

可将 `checkerSkill` 改为自己的校验技能，并通过可选的 `checkerScript` 指定对应的 Python 脚本（默认 `.claude/skills/check-html-report/scripts/check_report.py`）。脚本须接受相同命令参数、输出相同验收 JSON 契约和六个文件指纹。修改业务校验规则后，在新用户轮中生效；修正循环中不允许改动标准。输入文件大小上限为 2 MiB。

实际报告的数据与 `source` 中的本次数据比较，不要求沿用 HTML 示例里的旧数值。来源文件格式如下：

```json
{
  "version": 1,
  "title": "区域经营日报",
  "fields": { "report-period": "2026-09-09", "total-orders": 0 },
  "tables": {
    "regional-results": {
      "headers": ["区域", "订单数"],
      "rows": [["华南", 0]]
    }
  }
}
```

模板中的字段使用唯一的 `data-field="report-period"` 等标记；表格使用唯一的 `table[data-table="regional-results"]` 标记，并保留表头和表体。自定义模板时，同时调整这些标记和来源数据中的对应项目。

字符串按规范化空白后的文本比较，金额需要固定小数位时使用 `"1234.50"` 这样的字符串；数字按数值比较，零有效。`null`、空字符串和技术占位符不能通过。合法空表需要来源显式提供 `rows: []` 与非空 `emptyText`，报告保留表头、空表体，并以对应的 `data-empty-for` 元素展示空表说明。完整规则见校验技能的 `SKILL.md`。

## 3. 用现有 Hook 设置启用

管理员在 **管理后台 → Hooks → 从示例创建** 中选择 **HTML 报告验收与修正**。

1. 打开新建的 Hook，确认事件为 `Stop`。
2. 保留预置的脚本、输出映射和“Hook 执行异常时按校验失败终止”选项。
3. 发布 Hook，并将它绑定给需要使用的用户或租户。
4. 用户进入现有的 **设置 → 辅助功能**，选择目标工作区并启用该 Hook。

这套配置使用 `decision: block` 让当前 agent 继续工作；不需要添加 `invoke_skill` 或 `send_agent_message` 后置行为。校验技能由当前 agent 根据反馈执行。

## 4. 生成报告

在目标工作区开启 Claude 会话，调用：

```text
/generate-html-report

按 .ccui/report-quality.json 配置生成报告，使用当前数据并保留 HTML 示例的结构与样式。
遇到 Stop Hook 的验收反馈时，按校验技能的要求修复报告，再重新校验。
```

每次尝试结束时，Hook 会提供当前会话和本次验收标识。校验技能使用这些标识运行检查，并将结果写到 `verdict` 指定的文件。验收记录必须与当前文件内容匹配，旧的通过记录不能用于已经改变的报告或数据。

需要单独检查文件时，可在目标工作区运行：

```sh
python3 .claude/skills/check-html-report/scripts/check_report.py \
  --config .ccui/report-quality.json \
  --session-id demo \
  --attempt-token manual-1
```

命令返回码 `0` 表示通过，`1` 表示未通过，完整 JSON 同时写入结果文件和标准输出。上面的自定义标识仅用于手动检查；在 Hook 修复循环中必须使用反馈给出的原始 `sessionId` 和 `attemptToken`。

## 5. 查看和验证结果

成功时检查生成的 `reports/report.html` 和 `.ccui/report-quality-result.json`。需要了解每轮处理时，在该工作区“辅助功能”的 Hook 条目中打开 **执行记录**。

建议用以下流程验证闭环：

1. 使用示例数据生成一次报告，确认报告数据正确且 Hook 验收通过。
2. 修改数据，再次要求生成报告，确认报告使用新数据，旧通过记录不会直接放行。
3. 在测试报告中人为制造一个字段值、结构或样式错误，让 agent 继续处理，确认反馈中列出问题并促使修复。
4. 将测试副本的校验路径设为不存在，确认结果明确显示校验失败，不会把异常视为验收通过。

若达到修正次数上限，阅读失败反馈并修改模板、数据或要求，再开始新的处理。校验脚本异常也会明确终止为失败，而不会静默放行。

## 范围

这是用于自动修正报告的 POC，验收以约定的 HTML 结构、样式与数据规则为准。它不提供浏览器渲染或截图对比，也不证明内容满足规则之外的全部业务要求。

生成和校验都在可写工作区内运行，校验记录不构成抵御恶意伪造的安全边界。日常使用应保留校验技能与规则，让生成技能只修改报告产物。

同一工作区共用配置中的报告和验收文件，一次只运行一个报告任务。并行任务使用独立工作区，避免互相覆盖产物。

## 开发验证

在 CCUI 仓库运行 `npm run test:report-quality` 验证真实文件检查器和 Stop 决策。`npm run test:hooks` 回归现有 Hook 行为。

配置好现有模型环境变量后，显式运行 `node scripts/report-quality-live.mjs --run` 可验证真实 Claude SDK 的文件修正流程（会调用模型）。它只使用临时工作区中的合成数据，不使用实际会话或应用数据库；保留初始失败、每轮 Stop 及最终独立检查记录。

2026-09-09 实测：同一 session 第一次 Stop 返回 `block`，agent 通过文件工具修复缺章与错误金额并运行校验脚本，第二次 Stop 通过。独立复验确认结构、完整性与数据均通过，模板、数据和校验器未被修改。
