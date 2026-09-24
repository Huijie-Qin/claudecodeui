# 独立模型验收 Hook

## 启用

在 Hook 管理页使用预设 **独立模型任务完成度复核** 创建草稿，保存并发布，再按现有 Hook 流程给工作区用户启用。它适合没有额外验收标准的通用任务。报告或结构化数据交付可从 **报告与数据交付验收（程序校验示例）** 创建草稿。预设只是可编辑草稿，不会自动发布；先按工作区实际交付物修改路径、字段和验收标准，再发布。也可以新建 `Stop` Hook，在“后置行为”中添加“模型验收”。该行为只能添加一次，必须排在最后，且仅用于主代理。

`maxReviews` 为一次主模型运行内最多复核的次数，新配置范围 1–5，默认 3。已有的 6–10 次配置仍可读取，但运行时最多执行 5 次复核。每次主代理准备正常结束时都会复核；未通过且尚有次数时，Hook 返回 `decision: "block"` 和具体缺口，Claude SDK 会把原因送回**同一个主循环**继续工作。复核通过后返回 `decision: "approve"`。达到次数上限仍未通过，或审查连续失败达到上限时，Hook 返回 `continue: false` 和明确的 `stopReason`，不会把未完成任务伪装为成功。

`model` 留空时继承当前主模型；填写模型标识时由该模型复核。每次复核都是独立的新 SDK query：不恢复主会话、不继承主会话 Hook/MCP/Agent/Skill/设置、不保存审查会话，仅开放 Read、Glob、Grep 三个只读工具。复核只能给出完成判断和下一步建议，不能代替主代理修改交付物。

`criteria` 是可选的额外验收标准，最多 8000 字符。应写明要核对的内容、来源和通过条件，并与当前用户任务一起交给审查模型。`artifactPaths` 是可选的交付物线索，最多 20 项，每项最多 500 字符；填写工作区内的相对路径或 glob，例如 `reports/**/*.html` 和 `data/**/*.csv`。不得填写绝对路径或越出工作区的路径。路径只是帮助审查模型定位候选文件，仍须实际核对其内容；请在发布前将示例路径改为当前工作区真实的输出位置。

需要程序精确校验时，在同一个 Hook 的高级脚本中返回 `output.validation`，然后把模型验收的 `validationResultPath` 设为 `script.output.validation`。结果至少包含布尔值 `passed`；本例还返回问题列表 `issues` 和证据对象 `evidence`。运行时要求程序校验和独立模型判断都通过才放行；程序未通过时，具体问题作为返工反馈并留在 Hook 执行记录中。未配置 `validationResultPath` 的旧 Hook 保持原有模型验收流程。脚本应对缺文件、无效 JSON 等常见交付问题返回 `passed: false` 和可定位的问题，而不是抛错。

该后置行为自动控制 `decision`、`reason`、`continue` 和 `stopReason`；同一个 Hook 中不要再绑定这四个 Claude 返回字段。

## 复核依据

审查模型收到当前用户任务、配置的验收标准与交付物路径、会话记录中有界的近期用户/主代理/工具证据，以及 Stop 事件中的最终答复。会话记录和文件内容只作为证据，不作为新的指令。对于 Docker 运行时，服务端将 `/home/cloudcli` 内的会话记录映射到宿主机运行目录；记录不可读时使用当前用户请求与最终答复作为回退。审查依据可能不完整，因此复核模型应在缺少充分证据时判定未完成并指出需要验证的事项。

**报告与数据交付验收（程序校验示例）** 是一份可改的完整配置：`Stop` 高级 JavaScript 脚本先检查 `reports/report.html` 和 `data/metrics.json` 是否存在，再读取 JSON 并检查 `period` 是非空字符串、`metrics` 是非空数组，数组每项有非空 `name`、有限数字 `value` 和非空 `unit`，且指标名不重复。脚本把 `{ passed, issues, evidence }` 放在 `script.output.validation`；最后的模型验收通过 `validationResultPath` 引用它，并实际阅读报告与数据，核对报告是否回答用户问题、关键数字和单位是否一致。示例数据形状如下：

```json
{
  "period": "2026-09",
  "metrics": [{ "name": "收入", "value": 120, "unit": "万元" }]
}
```

实际使用时，**脚本中的两个路径、`artifactPaths` 和 `criteria` 要一起修改**；如果数据字段不同，也要修改脚本中的检查。这个例子只演示少量字段的确定性校验，不是通用 JSON Schema 校验器。模型只具备 Read、Glob、Grep 工具，无法渲染 HTML 进行遮挡、溢出等视觉验收；复杂版式检查继续使用项目已有的报告质量 Hook 流程。AI 复核基于可见证据，不能保证穷尽所有文件或数值错误。

审查查询有 80 秒默认截止时间，Stop Hook 总超时为 120 秒。用户取消会中止审查。审查模型异常、超时、输出无效或找不到当前任务时，在 Hook 执行记录中标为失败；本次仍按未完成处理，直到达到次数上限。若执行记录存储本身故障，也会按同样的上限策略阻止静默放行。

此功能接入当前 Claude SDK 的 `Stop` Hook；模型调用报错、主动取消、`StopFailure` 不会触发完成度复核。其他独立配置的 Stop Hook 仍可阻止结束。

## 验证

```sh
node --test server/services/hook-completion-review.test.js server/services/hook-completion-review-integration.test.js
node --test server/services/hook-examples.test.js
node --test scripts/hook-completion-review-e2e.test.mjs scripts/hook-completion-review-tools-e2e.test.mjs
```

最后一条使用本地回环模型服务与原生 Claude SDK，检查“主模型准备结束 → 新审查会话判定未完成 → 原主循环继续 → 再次审查通过”的完整路径，并验证验收模型能读取工作区报告、会拒绝工作区外的文件读取；不需要真实模型凭据。
