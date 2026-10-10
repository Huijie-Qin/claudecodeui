---
name: generate-html-report
description: Generate or repair an HTML report from the local reference template and current source data, then validate its structure, completeness, and data before completion.
---

# 生成 HTML 报告

从工作区根目录读取 `.ccui/report-quality.json`，随后读取其中的 `reference` 与 `source` 实际文件。`reference` 是历史样例，用于保留章节、表头、CSS、类名与布局；日期、数值和明细行以本次 `source` 为准，不能复制历史样例数据。

1. 从样例复制生成配置指定的 `report`。保留 `section[id]`、各级标题、`data-field`、`data-table`、样式和类名。只更新报告正文中的当期值与明细，不修改样例、源数据、配置、验收技能或脚本。
2. 将 `source.fields` 的值写进同名 `data-field` 元素，将 `source.tables` 的表头与行写进同名 `table[data-table]`。来源中的字符串定义展示格式；数字按其数值展示。保留零值。没有来源的值不能猜测或补造。
3. 使用 `check-html-report`，读取它生成的完整结果；根据 `issues` 修正报告文件后重跑。若 Stop 反馈提供 `sessionId` 和 `attemptToken`，必须原样传入检查命令，不能复用旧验收结果或自行写 verdict。
4. 只有检查器的 `passed` 和三个检查项均为 `true` 才能宣布通过。达到配置中的 `maxAttempts` 后仍失败，说明未通过及具体缺失条件；不能修改验收规则、源数据或样例来绕过失败。

本技能验收 HTML 结构、字段完整性和指定来源数据，未验证浏览器像素布局。若另外检查了截图，可说明该检查；未打开浏览器不能声称视觉验收通过。
