# 音乐 App 报表 API

## 接口

- `GET /api/demo-data/music-reports/schema`：App、维度、指标、指标语义、数据性质和校准来源。
- `GET /api/demo-data/music-reports/query`：查询报表。

Agent Graph 功能开关关闭时，这些接口统一返回 404。

| 参数 | 说明 |
|---|---|
| `startDate` / `endDate` | `YYYY-MM-DD`，范围为 2025-01-01 至 2026-07-31 |
| `apps` | App ID 或中文名，逗号分隔；省略代表全部 |
| `dimensions` | 逗号分隔的分组维度 |
| `metrics` | 逗号分隔的指标 |

## App ID

`qq-music`、`kugou-music`、`kuwo-music`、`wesing`、`netease-cloud-music`、`soda-music`、`migu-music`、`bodian-music`、`apple-music`、`spotify`、`ximalaya`、`qingting-fm`。

## 维度

- 时间：`date`、`week`、`month`；一次最多选择一个。
- App：`app_id`、`app_name`、`app_category`、`company`。
- 细分：`platform`、`province`、`region`、`city_tier`、`acquisition_channel`。
- `province` 与 `region` 不要同时选择。

## 指标

- 流量：`installs`、`new_users`、`uninstalls`、`reinstalls`。
- 活跃：`active_users`、`streams`、`listening_minutes`、`avg_listening_minutes`。
- 付费：`paying_users`、`subscription_starts`、`subscription_cancels`、`payer_rate`。
- 留存/流失：`d1_retention`、`d7_retention`、`d30_retention`、`uninstall_rate`。

`active_users` 和 `paying_users` 是查询期间每日值的累计（人天），用于保持日期、地区、平台和 App 分组可加；不能直接称为去重 DAU 或 MAU。查询整月时，将人天除以当月天数才是平均每日水平。

## 数据边界

输出是以 500 万设备确定性合成面板为基础的全国加权估算，并用 CNNIC、腾讯音乐、网易云音乐及国家统计局公开总体指标校准量级。App 级安装、卸载和留存并非公开披露事实；同一版本和查询参数始终得到相同结果，但不得将其用于真实商业决策或对外发布市场份额。
