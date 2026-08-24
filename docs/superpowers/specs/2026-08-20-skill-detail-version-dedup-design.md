# Skill 详情版本信息去重设计

## 问题

技能详情数据为了兼容市场和工作区来源，可能同时包含 `version` 与 `marketVersion`，以及 `importedVersion` 与 `localVersion`。当前详情页逐项渲染这些字段，因此 `frontend-polisher` 会重复显示市场版本和本地版本。

## 目标

- Skill 详情中的市场版本最多显示一次。
- Skill 详情中的本地版本最多显示一次。
- 创建者保持显示一次。
- 不改变接口数据结构、技能列表卡片或导入状态逻辑。

## 展示规则

详情视图在渲染前计算两个展示值：

- `displayMarketVersion`：优先使用 `marketVersion`，不存在时回退到 `version`。
- `displayLocalVersion`：优先使用 `localVersion`，不存在时回退到 `importedVersion`。

只有计算结果为数字时才渲染对应信息。创建者继续使用现有 `createUserId`，不参与版本字段归一化。

## 实现边界

在技能详情展示模块中增加一个无副作用的元数据归一化函数，由详情视图消费其结果。保留原始详情对象中的兼容字段，避免影响操作按钮、更新判断和其他调用方。

## 验证

- 四个版本字段同时存在时，只显示一条市场版本和一条本地版本，并遵循优先级。
- 只有 `version` 或 `importedVersion` 时仍能正确显示兼容字段。
- 版本字段不存在时不渲染空标签。
- 本地浏览器回归确认 `frontend-polisher` 显示：市场版本 v3、本地版本 v3、创建者 design-team，且均不重复。
