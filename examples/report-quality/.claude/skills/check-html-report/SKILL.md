---
name: check-html-report
description: Validate an actual local HTML report against its reference template and current source JSON, returning a reproducible verdict with file fingerprints for structure, completeness, and data.
---

# HTML 报告验收

必须运行本技能的检查脚本读取实际文件，不能仅根据生成者的说明宣布通过。从工作区根目录执行：

```sh
python3 .claude/skills/check-html-report/scripts/check_report.py \
  --config .ccui/report-quality.json \
  --session-id '<Stop 反馈给出的 sessionId>' \
  --attempt-token '<Stop 反馈给出的 attemptToken>'
```

手工演示可给两个标识使用自定义非空值，但 Stop 验收必须使用当轮反馈中的原值。命令返回码 `0` 表示通过，`1` 表示未通过；详细 JSON 同时写入配置的 `verdict` 和标准输出。

检查器独立计算文件 SHA256；每个输入文件（包括配置、技能和脚本）最大 2 MiB。配置可用可选 `checkerScript` 指定工作区内的脚本路径，默认使用上方路径；命令应运行配置指向的实际脚本，不能为另一个未运行的脚本生成指纹。检查三类条件：

- `structure`：样例中的章节及顺序、静态文字、DOM 层级、属性、CSS 和类名位置保留，表格单元格网格完整。只允许绑定字段的文本值与绑定表格的数据行变化；每列仍须保持样例单元格的标签和样式。
- `completeness`：字段/表格存在且唯一；必需内容不能空白，也不能保留 `TODO`、`null`、`undefined` 等占位符。`0` 是合法数据。
- `data`：报告标题、字段、表格及其行数符合本次来源文件；历史样例值不参与数值比较。没有可读取的来源文件不能通过。

## source JSON 格式

```json
{
  "version": 1,
  "title": "区域经营日报",
  "fields": {"report-period": "2026-09-09", "total-orders": 0},
  "tables": {
    "regional-results": {
      "headers": ["区域", "订单数"],
      "rows": [["华南", 0]]
    }
  }
}
```

`fields` 的键对应唯一的 `data-field`；`tables` 的键对应唯一的 `table[data-table]`。字符串按规范化空白后的文本精确比较，因此金额格式建议写成字符串，例如 `"1234.50"`；数字按有限十进制数值比较，零有效。`null`、布尔值、对象、空字符串及技术占位符不是有效单元格来源。

表格必须使用 `thead`（也支持第一行全部为 `th` 的表头）。脚本展开 `rowspan`/`colspan` 校验逻辑网格；多级表头用 ` / ` 连接不重复的上级/下级标题，来源 `headers` 使用同样格式。来源 `rows` 是展开后的完整逻辑行，顺序与报告一致，不能省略行或将数字拼进错误列。

合法空表必须在来源中显式给出 `"rows": []` 和非空 `"emptyText"`，报告保留表头与空表体，并添加无额外属性或嵌套标签的 `<p data-empty-for="表格键">说明</p>` 展示该说明。否则空表不能通过。

## 结果与修复

保留脚本返回的 `version/sessionId/attemptToken/passed/checks/issues/fingerprints`，不要手工编辑验收文件。每轮只按 `issues` 修改配置指定的报告，再运行脚本；不修改样例、来源、配置、技能或检查器。

如果对文字解释做补充语义评审，给出问题位置、实际证据和修复要求；不能将机器失败改写成通过。本检查不执行 HTML 脚本、不联网、不做浏览器视觉或未提供来源的数据真实性判断。
