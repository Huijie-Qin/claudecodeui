# Hook 用户个人变量

Hook 可以定义需要用户自行填写的个人变量，如 Token、账号、项目标识或通知接收人。变量值按用户、工作区、Hook 隔离保存，不写入公共 Hook 配置或工作区资源文件。

## 配置与启用

1. 管理员在 Hook 编辑页的“用户个人变量”中添加变量，设置变量名、显示名称、填写说明、是否必填及是否敏感，然后保存、发布 Hook。
2. 在脚本或后置行为中引用变量。Skill 参数、MCP 工具输入、Agent 消息等原有变量选择器会列出已定义的个人变量。
3. 用户在“辅助功能”开启 Hook 时填写变量，点击“保存并启用”。缺少必填项时无法启用。模板默认或强制启用的 Hook 也会等待当前用户完成必填配置。
4. 用户可通过“配置个人变量”修改值。每项仅显示名称、填写说明和输入框。已保存的值不回显，输入框提示留空保留。关闭 Hook 会保留变量，重新启用时可继续使用。

变量值目前以文本传递，每个 Hook 最多 20 个变量，每个值最多 8192 个字符。变量名区分大小写，以字母或下划线开头，只能包含字母、数字和下划线，最多 64 个字符。

## 引用示例

启用 Hook 后，已填写的变量会按原变量名自动注入当前用户、当前工作区的 Claude 执行进程环境，Skill 中的 Shell 命令及其子进程可直接使用，无需把值写进 Skill 参数：

```sh
curl -H "Authorization: Bearer ${personal_token}" https://service.example/api
```

`${personal_token}` 是 Shell 语法，需要在 Shell 命令或脚本中使用；SKILL.md 普通文本不会自动替换。Docker 模式通过每次 `docker exec` 注入，变量值不写入容器创建配置、启动包装脚本或共享 Skill 文件；本地执行模式也支持。保存、修改或关闭 Hook 后，下次启动执行进程（含继续已有会话）生效，已运行的进程保持启动时的值。

注入范围是当前工作区内已启用且可用的 Hook，未填写的选填变量不注入。变量在同一执行进程内可由其他 Skill/工具读取。同名 Hook 变量填相同值可共用，值不同时会提示冲突；也请避免仅大小写不同的变量名。Hook 变量优先于同名的一般个人环境变量，仍遵守系统保留变量及平台禁用规则，不可覆盖 `PATH`、`HOME`、`USER_KEY` 等运行环境。已发布的 Hook 变量定义作为授权来源，无需在通用个人环境变量白名单中重复添加。

定义 `personal_token`（必填、敏感）和 `project_id`（选填）后，Skill 参数或其他模板可写为：

```text
项目：{{ccui.env.userVariables.project_id}}
凭据：{{ccui.env.userVariables.personal_token}}
```

JavaScript 高级脚本：

```javascript
export async function run(event, ccui) {
  const project = ccui.env.userVariables.project_id;
  return { output: { project } };
}
```

Python 高级脚本：

```python
async def run(event, ccui):
    project = ccui.env.userVariables["project_id"]
    return {"output": {"project": project}}
```

MCP 输入的引用绑定：

```json
{ "source": "reference", "path": "ccui.env.userVariables.personal_token" }
```

未填写的选填变量在运行时提供空字符串。只能引用本 Hook 已定义的变量。工作区沿用其绑定的已发布版本及变量定义，后续编辑发布不会改变已绑定版本。

## 保存与敏感值处理

- 所有个人变量值均加密保存，设置接口只返回已配置的变量名及缺失的必填变量名。
- 敏感变量使用密码输入框；原值在 Hook 执行日志、记录、错误、Skill/Agent 调用展示及 Claude 进程诊断中脱敏。
- 被引用的原值会按配置传给脚本、Skill、MCP 或 Agent。此功能不承诺对这些执行方自行生成的文件、回复或日志进行脱敏。
- 启用接口通过已登录用户和当前工作区确定保存范围，忽略请求体中伪造的用户、租户或工作区身份。变量校验发生在资源安装前。
- 新字段及存储表随现有数据库初始化流程迁移，旧 Hook 默认没有个人变量。
