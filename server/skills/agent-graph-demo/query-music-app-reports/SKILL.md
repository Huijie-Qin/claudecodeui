---
name: query-music-app-reports
description: Query the local Agent Graph demo API for music-app installs, new users, uninstalls, reinstalls, activity, subscriptions, listening, retention, channel, platform, and geographic breakdowns. Use for Chinese or English requests that compare music apps, inspect trends, build operating reports, or retrieve metric evidence for an Agent Graph analysis.
---

# 音乐 App 报表查询

从本地测试 API 获取音乐 App 经营报表。数据覆盖 12 个音乐/音频 App、2025-01-01 至 2026-07-31，以及时间、平台、地区、城市等级和获客渠道维度。

## 执行方法

1. 明确时间范围、App、维度和指标。用户未指定时，使用最近 90 天，按月和 App 分组。
2. 字段不确定时，运行 `node scripts/query_reports.mjs --schema`，或读取 `references/api.md`。
3. 运行查询脚本；先使用满足问题的最少维度，避免一次返回过多行。
4. 检查口径：安装、新增、卸载等为期间累计；`active_users` 和 `paying_users` 为每日人数相加后的人天，不是去重 MAU。用人天除以查询天数可得到平均 DAU/日付费人数。
5. 比较时同时给出绝对量和比率，说明日期、筛选条件、分组维度和估算口径。
6. 始终披露数据是“公开总体指标校准的确定性合成面板及全国加权估算”，不能写成真实 App 后台数据。

## 查询示例

```bash
node scripts/query_reports.mjs \
  --start-date 2026-01-01 \
  --end-date 2026-07-31 \
  --apps soda-music,netease-cloud-music,qq-music \
  --dimensions month,app_name \
  --metrics installs,new_users,uninstalls,active_users,d30_retention,uninstall_rate
```

按地区与平台拆分：

```bash
node scripts/query_reports.mjs \
  --start-date 2026-07-01 \
  --end-date 2026-07-31 \
  --apps soda-music \
  --dimensions province,platform \
  --metrics installs,new_users,uninstalls
```

## 输出要求

- 先回答核心结论，再给关键数据表。
- 对趋势使用同比、环比或首尾变化，避免只罗列明细。
- 不把相关性描述成因果关系。
- 引用响应中的 `dataNature`、版本和查询参数；需要来源说明时使用 schema 返回的 `sources`。
- 查询失败时保留 API 错误含义，再缩短日期或减少细分维度，不能编造结果。

完整接口与指标说明见 `references/api.md`。
