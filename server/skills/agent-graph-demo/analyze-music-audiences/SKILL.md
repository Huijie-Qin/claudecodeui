---
name: analyze-music-audiences
description: Define cohorts with music-app installation and profile tags, then analyze audience distributions, baseline shares, and lift through the local Agent Graph demo API. Use for audience sizing, user profiling, label-based segmentation, cross-tag analysis, or questions such as users who have kept Soda Music installed for more than 30 days and their industries, occupations, regions, and uninstall behavior.
---

# 音乐用户画像分析

使用 CCUI 内置的匿名画像样本按标签圈定人群，再分析该人群的标签分布、全量基线和 Lift。

## 工作流

1. 把自然语言条件翻译为标签过滤器。先读取 `references/tags.md`；如果字段不确定，再查询 schema。
2. “安装某 App 超过 N 天”必须同时包含 `status = 已安装` 和 `installed_days > N`，避免把已卸载用户误算为当前安装用户。
3. 多个条件默认使用 `match=all`；用户明确要求满足任一条件时才使用 `match=any`。
4. 先调用 analyze 获取人群规模和画像分布；只有确实需要逐条核验时才调用 sample，且只取最少标签和少量脱敏样本。
5. 解读每个分组的 `percentage`、`baselinePercentage` 和 `lift`。Lift 大于 1 表示该标签在人群中相对全样本更集中，但不表示因果关系。
6. 回答中说明数据边界：这是基于公开行业统计校准的确定性匿名合成样本，不是真实个人画像，也不含真实 PII。

## 圈选并分析

例如，圈选“汽水音乐当前已安装超过 30 天”的用户，分析行业、职业、地区和卸载相关标签：

```bash
node scripts/analyze_audience.mjs \
  --filters '[{"tag":"app.soda-music.status","operator":"eq","value":"已安装"},{"tag":"app.soda-music.installed_days","operator":"gt","value":30}]' \
  --dimensions industry,occupation,province,app.soda-music.uninstall_days_ago \
  --top-n 15
```

`uninstall_days_ago` 对当前已安装用户通常为空；若要研究卸载时间，应另建 `status = 已卸载` 的人群，不要把两个状态混在同一个结论中。

## 查看脱敏样本

```bash
node scripts/analyze_audience.mjs \
  --mode sample \
  --filters '[{"tag":"app.soda-music.status","operator":"eq","value":"已安装"}]' \
  --tags industry,occupation,province,app.soda-music.installed_days \
  --limit 20
```

仅报告 API 返回的掩码用户 ID。不要试图关联、推断或补全真实身份。

## 查询 Schema

```bash
node scripts/analyze_audience.mjs --mode schema
```

接口、标签和操作符的完整说明见 `references/tags.md`。
