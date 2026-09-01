# Skill 市场下架 API 转发设计

日期：2026-09-01  
状态：已确认

## 背景

当前浏览器通过 CCUI 的 `POST /api/skill-market/skills/:name/unpublish` 发起下架。CCUI 已经负责工作区权限、创建者身份、精确小写 `yes`、本地发布绑定和远端 Skill ID 校验，但随后调用的是 DataAgent 门户接口 `/data-agent/portal/skill/delete`。该接口依赖门户登录会话，CCUI 的服务端请求没有浏览器 `session`，因此返回 `account not log in`。

首次发布和发布更新已经通过 DataAgent 的服务接口完成：`/data-agent/api/skill/save`、`/data-agent/api/skill/update` 和 `/data-agent/api/skill/publish`。这些请求统一使用 CCUI 的 HMAC 服务签名，并携带租户与账户头，不依赖浏览器 Cookie。远端删除现已确认提供同类接口 `/data-agent/api/skill/delete`。

## 目标

1. 保留现有 CCUI 下架接口及前端交互，不改变浏览器请求契约。
2. 将远端下架改为由 CCUI 后端转发到 DataAgent `/api/skill/delete`。
3. 删除请求与 save、update、publish 使用相同的基地址、HMAC、租户和账户上下文。
4. 远端成功后清理当前工作区的市场绑定，但保留所有本地 Skill 文件。
5. 远端失败时不修改本地绑定或文件。

## 方案比较

### 方案 A：复用现有市场请求工具转发 `/api/skill/delete`（采用）

现有 `requestMarketJson` 已经处理环境基地址、`/data-agent` 前缀、HMAC、`X-Data-Agent-Tenant`、`X-Account-Id`、超时、日志和错误归一化。下架只需使用新的服务接口路径，行为与发布链路一致，变更范围最小。

### 方案 B：增加通用 DataAgent 透明代理

通用代理会扩大可调用路径和权限范围，也绕开每个业务动作的参数与权限校验，不采用。

### 方案 C：前端直接调用 DataAgent

该方案需要前端处理镜像与现网路径，并把远端删除和本地绑定清理拆成两次请求，容易形成部分成功状态，不采用。

## 请求流程

1. 浏览器调用：

   ```http
   POST /api/skill-market/skills/:name/unpublish?workspaceId=<id>&tenantId=<id>
   Content-Type: application/json

   {"confirmation":"yes"}
   ```

2. CCUI 校验工作区编辑权限、精确小写 `yes`、`bindingType=published`、当前账户是创建者，并从绑定读取 `id`，兼容回退 `skillId`。
3. CCUI 通过现有市场 JSON 请求工具调用：

   ```http
   POST /data-agent/api/skill/delete
   Content-Type: application/json
   Authorization: CLOUDSOA-HMAC-SHA256 ...
   X-Data-Agent-Tenant: <tenant code>
   X-Account-Id: <username>

   {"data":{"id":"<remote skill id>"}}
   ```

4. DataAgent 成功后，CCUI 删除当前工作区对应的市场绑定。
5. CCUI 返回下架结果；本地 Skill 目录和文件保持不变，前端刷新后将其显示为可再次发布的本地 Skill。

## 环境地址

业务代码只传 `/api/skill/delete`，继续由现有基地址和路径规范化生成最终 URL：

- 镜像：`网址/dataagent-mirror/data-agent/api/skill/delete`
- 现网：`网址/dataagent/data-agent/api/skill/delete`

不在路由或服务中增加镜像、现网条件分支。

## 错误与一致性

- 缺少确认、绑定、创建者权限或远端 ID 时，不发送远端请求。
- DataAgent HTTP 错误或业务错误时，不清理本地绑定，不修改本地文件。
- DataAgent 已成功但本地绑定写入失败时，继续返回现有的部分成功错误，明确标记远端已经下架；本地文件仍不删除。
- 请求和日志中不引入或转发浏览器 Cookie；HMAC 密钥和签名继续由现有请求工具管理。

## 测试策略

- 服务测试验证最终镜像路径为 `/dataagent-mirror/data-agent/api/skill/delete`。
- 验证请求方法、`{"data":{"id":"..."}}` 负载、租户头和账户头。
- 配置 HMAC 时验证删除请求使用与其他 `/api/skill/*` 请求相同的签名规则。
- 验证远端成功后绑定被清除、本地文件保持不变。
- 验证远端失败时绑定和本地文件均保持不变。
- 保留确认、绑定类型、创建者和远端 ID 的防护测试。
- 运行相关服务测试、类型检查、静态检查及前后端构建。

## 验收标准

- 下架不再请求 `/portal/skill/delete`，也不再依赖浏览器 `session`。
- 镜像和现网均通过 `/data-agent/api/skill/delete` 完成远端删除。
- 下架与 save、update、publish 使用相同的服务认证和身份头。
- 成功后远端 Skill 下架、本地市场绑定清除、本地 Skill 文件原样保留。
- 任一失败路径均不删除本地文件。
