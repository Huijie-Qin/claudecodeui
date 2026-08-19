# 画像分析接口与标签

## 接口

- `GET /api/demo-data/audience-profiles/schema`：标签、枚举、操作符和数据边界。
- `POST /api/demo-data/audience-profiles/analyze`：计算人群规模，按多个标签输出分布、全量基线与 Lift。
- `POST /api/demo-data/audience-profiles/sample`：返回少量掩码 ID 与指定标签，用于核验筛选条件。

Agent Graph 功能开关关闭时，这些接口统一返回 404。

## 基础标签

常用标签包括：

- 人口与地域：`age_band`、`gender`、`province`、`region`、`city_tier`
- 职业与行业：`industry`、`occupation`、`income_band`、`education`
- 设备：`device_brand`、`device_price_band`、`os`
- 音乐行为：`music_preference`、`listening_scene`、`weekly_listening_days`、`daily_listening_minutes`、`music_membership_count`

以 schema 实际返回为准。

## App 标签

格式为 `app.<app_id>.<field>`。支持的 App ID：

`qq-music`、`kugou-music`、`kuwo-music`、`wesing`、`netease-cloud-music`、`soda-music`、`migu-music`、`bodian-music`、`apple-music`、`spotify`、`ximalaya`、`qingting-fm`。

每个 App 提供：

- `status`：`已安装`、`已卸载`、`从未安装`
- `installed_days`：当前连续安装天数；非当前安装状态为空
- `uninstall_days_ago`：距最近卸载的天数；非已卸载状态为空
- `last_active_days_ago`：距最近活跃的天数
- `membership`：会员状态
- `install_channel`：安装渠道

## 操作符

支持 `eq`、`neq`、`in`、`not_in`、`gt`、`gte`、`lt`、`lte`、`between`、`contains`、`exists`。

- `in`、`not_in` 的值应为数组。
- `between` 的值为两个元素的数组，包含边界。
- `exists` 的值使用布尔值。
- `match` 为 `all` 时所有过滤器都需满足；`any` 表示满足任一过滤器。

## 请求示例

```json
{
  "filters": [
    { "tag": "app.soda-music.status", "operator": "eq", "value": "已安装" },
    { "tag": "app.soda-music.installed_days", "operator": "gt", "value": 30 }
  ],
  "match": "all",
  "dimensions": [
    "industry",
    "occupation",
    "province",
    "app.soda-music.uninstall_days_ago"
  ],
  "topN": 15
}
```

## 结果解释

- `cohort.size`：命中样本数。
- `cohort.share`：命中样本占全部匿名样本的比例。
- `percentage`：某标签值在人群内的比例。
- `baselinePercentage`：同一标签值在全部样本的比例。
- `lift = percentage / baselinePercentage`：大于 1 代表相对富集，小于 1 代表相对不足；它不证明因果。

## 数据边界

画像是 10 万条确定性匿名合成样本，依据公开人口、互联网与音乐行业总量进行校准。它适合验证 Agent Graph 的筛选、调用、汇总与解释链路，不代表任何真实个人，不含真实 PII，也没有为了制造结论而手工植入异常点。
