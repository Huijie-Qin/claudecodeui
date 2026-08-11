# CCUI Admin Hook 需求设计方案

## 1. 文档说明

本文档用于定义 CCUI 管理员 Hook 系统的产品需求、配置模型、交互方式、接口契约和后续执行引擎方案。

当前设计采用方案 A：

- Hook 由系统管理员统一创建、编辑、发布、启动、停止和删除。
- 不提供普通用户点击安装、启用或停用 Hook 的入口。
- 新发布 Hook 默认未启动；管理员点击“启动”后为全部现有用户绑定并开启。
- Hook 启动后创建的新用户会自动绑定该 Hook。
- Hook 不按项目单独配置，不在基本信息中配置用户权限。
- Hook 配置、全局启动状态、用户绑定关系和运行记录均保存到 CCUI 数据库，不写入 .claude/settings.json。
- 继续使用当前安装的 @anthropic-ai/claude-agent-sdk 0.2.116，不要求升级版本。

### 1.1 当前实现状态

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| Admin Hook 列表 | 已实现 | 支持搜索、创建、编辑、发布、启动、停止、删除 |
| Admin Hook 单页配置器 | 已实现 | 支持事件、精确/正则 Matcher、统一门槛、高级脚本和基础行为配置 |
| 更多事件管理 | 已实现 | 28 个事件可配置为创建页可见事件 |
| Hook 配置数据库 | 已实现 | hooks、hook_actions、user_hook_bindings |
| Admin Hook API | 已实现 | CRUD、发布、启动、停止、设置、资源目录 |
| Hook 配置发布校验 | 已实现 | 校验事件、门槛、脚本输出和行为参数 |
| Claude Agent SDK Hook 执行接入 | 未实现 | 尚未把已发布配置编译到 options.hooks |
| 高级脚本真实执行 | 未实现 | 配置模板已定义只读 workspace API；当前仍只保存脚本配置 |
| 基础行为真实执行 | 未实现 | 当前只保存行为配置 |
| 用户 Hook 绑定 | 已实现 | 启动时绑定全部用户，新用户自动绑定；不提供用户安装入口 |
| 模拟测试与运行记录 | 未实现 | 作为执行引擎阶段实现 |

## 2. 背景与目标

Claude Code 在回答、工具调用、权限请求、上下文压缩等环节提供 Hook 回调。CCUI 需要把这些底层回调封装成管理员可以理解和配置的统一能力。

系统需要解决以下问题：

1. 管理员可以选择在哪个 Claude Code 生命周期位置触发 Hook。
2. 管理员不需要编写 JSON 或表达式，即可配置 Hook 的执行门槛。
3. 管理员可以通过基础行为完成记录、调用 MCP、追加上下文、流程控制和输入输出修改。
4. 基础行为无法表达需求时，可以选择性启用内联高级脚本。
5. 脚本计算结果可以被统一门槛和后续基础行为直接使用。
6. Hook 真实执行时，环境变量必须替换为当前用户、租户和会话的实时值。
7. 高级脚本可以通过受限只读 API 读取当前用户工作空间内的文件。
8. 所有运行过程可审计、可追溯，并对敏感信息脱敏。

## 3. 范围与约束

### 3.1 本期需求范围

- 支持当前 Agent SDK 暴露的 28 个 Hook 事件。
- 默认在 Hook 创建页展示：
  - 回答结束 Stop
  - 用户提交问题 UserPromptSubmit
  - 工具执行前 PreToolUse
  - 工具成功后 PostToolUse
- 管理员通过“更多事件”调整创建页可见事件。
- 每个 Hook 只配置一次统一执行门槛。
- 基础行为不再单独配置执行条件。
- 高级脚本是可选能力，不是必须执行的流程步骤。
- 匹配条件支持精确匹配和正则匹配。
- 调用工具第一期只允许调用 CCUI 已接入的 MCP 工具。
- 回答异常结束时，可以通过“发起恢复回合”让模型在新回合中调用指定 Skill。

### 3.2 明确不做

- 不提供独立脚本注册中心或脚本市场。
- 不把 SQL 行数统计预置为专用行为。
- 不提供 HTTP 调用行为。
- 不提供发送通知行为。
- 不提供回答 MCP 询问行为。
- 不提供设置会话信息行为。
- 不提供更新文件监听目录行为。
- 不提供设置 Worktree 路径行为。
- 不允许 Hook 直接主动调用 Bash、Read、Write、Edit、Skill 等 Claude Code 内置工具。
- 不给每个基础行为配置独立触发条件。
- 不让管理员在统一门槛中填写具体用户 ID、租户 ID、项目 ID或会话 ID。
- 不允许普通用户查看脚本源码、MCP 参数映射或完整运行记录。

## 4. 用户角色

### 4.1 系统管理员

管理员可以：

- 查看和搜索所有 Hook。
- 创建、编辑和保存 Hook 草稿。
- 发布、启动或停止 Hook。
- 删除 Hook。
- 配置创建页可见事件。
- 编辑高级脚本和基础行为。
- 后续查看模拟测试结果与真实运行记录。

### 4.2 普通用户

普通用户不需要安装或手动启停 Hook。管理员启动后，系统通过 `user_hook_bindings` 将 Hook 绑定到全部用户；后续执行器只加载当前用户已绑定且全局已启动的 Hook。

普通用户不能：

- 创建或编辑 Hook。
- 查看高级脚本。
- 查看完整行为参数。
- 查看其他用户的运行记录。

## 5. 核心概念

一个 Hook 由以下部分组成：

~~~text
基本信息
+ 触发事件 Event
+ 原生匹配条件 Matcher
+ 高级脚本 Advanced Script（可选）
+ Hook 统一执行门槛 Gate
+ 基础行为 Actions（按顺序执行）
~~~

### 5.1 触发事件 Event

决定 Hook 在 Claude Code 生命周期的哪个位置执行，同时决定当前能读取哪些事件字段、能配置哪些基础行为。

### 5.2 匹配条件 Matcher

页面名称为“匹配条件”，对应 Agent SDK 原生 Matcher。

Matcher 只匹配当前事件规定的固定对象，用于在进入 CCUI Hook Engine 前进行粗筛选。例如：

| 事件 | Matcher 实际匹配内容 | 示例 |
| --- | --- | --- |
| PreToolUse | 工具名称 toolName | Bash、Skill、mcp__server__tool |
| PostToolUse | 工具名称 toolName | mcp__database__query |
| SessionStart | 会话来源 source | startup、resume、clear、compact |
| Elicitation | MCP Server 名称 | database-server |
| PreCompact | 压缩触发方式 | manual、auto |
| Stop | 无原生 Matcher | 每次回答结束都进入统一门槛 |

Matcher 不负责分析回答是否包含 SQL，也不负责判断工具参数内容。此类业务判断由高级脚本和统一执行门槛完成。

匹配方式：

- 精确匹配：用于明确指定一个工具或一个事件值，例如 `mcp__database__query`。
- 正则匹配：用于覆盖一组符合命名规则的值，例如 `^mcp__data_.*__query$`。
- 正则表达式在前端即时校验，后端保存时再次校验。
- “修改输入”依赖具体工具的 `inputSchema`，因此只允许精确匹配一个具体工具；正则匹配不能配置该行为。

### 5.3 高级脚本 Advanced Script

高级脚本是当前 Hook 内部的可选 JavaScript 计算逻辑：

- 不需要注册。
- 与 Hook 配置一起保存和发布。
- 在统一执行门槛之前执行。
- 默认不预置任何输出字段。
- 管理员通过 @output 声明需要暴露的输出。
- 输出自动进入统一门槛和基础行为字段选择器。
- 脚本入参提供 `workspace` 只读文件 API，只能使用相对当前用户工作空间根目录的路径。

### 5.4 统一执行门槛 Gate

统一门槛只判断一次，控制该 Hook 的全部基础行为：

~~~text
判断哪个数据 → 怎么判断 → 和什么比较
~~~

支持：

- 满足全部条件 all。
- 满足任一条件 any。
- 未配置条件时默认通过。

### 5.5 基础行为 Action

基础行为通过结构化表单配置，不要求管理员编写代码。统一门槛通过后，行为按列表顺序串行执行。

## 6. 支持的 Hook 事件

当前 SDK 0.2.116 本地类型定义包含以下 28 个事件。

### 6.1 会话与回答

| 事件 | 页面名称 | 触发时机 |
| --- | --- | --- |
| Setup | 初始化环境 | Claude Code 初始化或维护环境时 |
| SessionStart | 会话开始 | 新建、恢复、清空或压缩后恢复会话时 |
| Stop | 回答结束 | 模型准备结束本轮回答时 |
| StopFailure | 回答异常结束 | 本轮因模型或 API 错误异常结束时 |
| SessionEnd | 会话结束 | 会话退出或结束时 |

### 6.2 用户输入与通知

| 事件 | 页面名称 | 触发时机 |
| --- | --- | --- |
| UserPromptSubmit | 用户提交问题 | 问题正式提交给模型前 |
| UserPromptExpansion | 命令展开 | Slash Command 或 MCP Prompt 展开时 |
| Notification | Claude Code 通知 | Claude Code 产生通知时 |

### 6.3 工具与权限

| 事件 | 页面名称 | 触发时机 |
| --- | --- | --- |
| PreToolUse | 工具执行前 | Skill、MCP 或内置工具执行前 |
| PostToolUse | 工具成功后 | 工具成功执行后 |
| PostToolUseFailure | 工具失败后 | 工具执行失败后 |
| PermissionRequest | 请求权限 | 工具等待权限确认时 |
| PermissionDenied | 权限被拒绝 | 工具权限被拒绝时 |

### 6.4 Agent 与任务

| 事件 | 页面名称 | 触发时机 |
| --- | --- | --- |
| SubagentStart | 子 Agent 开始 | 子 Agent 启动时 |
| SubagentStop | 子 Agent 结束 | 子 Agent 准备结束时 |
| TeammateIdle | 团队成员空闲 | Agent Team 成员进入空闲时 |
| TaskCreated | 任务创建 | Claude 创建任务时 |
| TaskCompleted | 任务完成 | Claude 完成任务时 |

### 6.5 上下文、MCP 与工作区

| 事件 | 页面名称 | 触发时机 |
| --- | --- | --- |
| PreCompact | 压缩前 | 上下文压缩前 |
| PostCompact | 压缩后 | 上下文压缩后 |
| Elicitation | MCP 发起询问 | MCP Server 请求用户补充信息时 |
| ElicitationResult | MCP 询问结果 | 用户回答 MCP 询问后 |
| ConfigChange | 配置变化 | Claude 配置变化时 |
| InstructionsLoaded | 指令加载 | CLAUDE.md 等指令加载时 |
| CwdChanged | 工作目录变化 | 当前工作目录变化时 |
| FileChanged | 监听文件变化 | 监听文件新增、修改或删除时 |
| WorktreeCreate | Worktree 创建 | 创建隔离 Worktree 时 |
| WorktreeRemove | Worktree 删除 | 移除 Worktree 时 |

## 7. 管理端交互设计

### 7.1 Hook 列表

列表卡片展示：

- Hook 名称。
- 功能说明。
- 当前状态：草稿、已发布、已停用。
- 触发事件。
- 基础行为数量。
- 发布版本。
- 最近更新时间。

列表操作：

- 编辑。
- 发布或停用。
- 删除。
- 搜索。
- 新建 Hook。

### 7.2 Hook 配置页

配置采用单页布局，不使用“下一步”向导。

#### 区域 1：基本信息与触发位置

- 第一行左侧：名称。
- 第一行右侧：触发位置。
- 事件说明通过“触发位置”旁的信息图标悬浮展示，不占用固定页面空间。
- “更多事件”位于触发位置区域。
- 第二行：功能说明，横跨整个页面内容区。
- 基本信息不展示用户权限选项。

#### 区域 2：匹配条件

- 只有当前事件支持 Matcher 时才显示选择器。
- 工具类事件必须提示管理员选择具体工具。
- 选择具体工具后，页面可以读取该工具的 inputSchema。
- 不支持 Matcher 的事件显示无需额外匹配条件。

#### 区域 3：高级脚本（可选）

- 默认关闭。
- 开启后显示事件专属脚本模板。
- 脚本模板直接列出当前可用参数及行内注释。
- 默认 return.output 为空。
- 不预置文本、数字、布尔等无业务含义的输出。
- 用户通过 @output 声明输出字段。

#### 区域 4：Hook 执行统一门槛

- 默认无条件执行。
- 点击“添加条件”后使用选择器配置。
- 字段、运算符、枚举值均优先使用下拉选择。
- 开放文本比较值才使用输入框。
- 一个 Hook 只配置一组统一门槛。

#### 区域 5：基础行为

- 页面展示当前事件支持的行为。
- 点击行为卡片后添加行为实例并展开编辑器。
- 已添加行为可以编辑、收起、排序和删除。
- 行为不再配置自己的执行条件。

### 7.3 更多事件

“更多事件”弹窗按以下分组展示 28 个事件：

- 会话。
- 用户输入。
- 工具。
- Agent。
- 上下文。
- MCP。
- 工作区。

管理员至少选择一个事件。保存后，Hook 创建页只展示选中的事件。

## 8. 字段与变量系统

### 8.1 字段来源

统一字段目录由以下数据组成：

| 来源 | 路径示例 | 用途 |
| --- | --- | --- |
| 当前事件 | $event.prompt | 门槛、记录、参数映射 |
| 工具输入 Schema | $event.toolInput.command | 修改输入、门槛、记录 |
| 环境上下文 | $context.username | 记录、参数映射、模板 |
| 高级脚本输出 | $script.output.hasSql | 门槛、记录、参数映射 |
| 前序行为输出 | $actions.0.output | 后续行为参数 |

### 8.2 环境变量

当前资源接口提供：

- $context.userId
- $context.username
- $context.tenantId
- $context.sessionId
- $context.projectId

资源接口只暴露能够从当前认证用户、会话和项目中真实解析的字段。没有数据库字段或运行时解析逻辑的数据不得预置到配置页面。

### 8.3 统一门槛限制

以下高基数字段不能作为管理员统一门槛：

- userId
- tenantId
- projectId
- sessionId
- transcriptPath
- cwd

管理员不应填写某个具体用户、租户、项目或会话 ID；这类信息只在 Hook 实际执行时从当前运行环境注入。

### 8.4 模板变量

追加上下文和恢复 Skill 参数使用文本模板。输入斜杠可以打开变量选择器。

斜杠选择器支持当前运行链路中的字段和环境变量，但不把 Skill 当作变量插入。

示例：

~~~text
当前用户为 ${context.username}。
脚本识别的风险等级为 ${script.output.riskLevel}。
~~~

运行时由 Hook Engine 使用当前认证用户、租户和会话的真实值进行替换。

## 9. 高级脚本设计

### 9.1 执行位置

~~~text
事件触发
→ Matcher
→ 高级脚本（可选）
→ 统一执行门槛
→ 基础行为
~~~

### 9.2 脚本模板

脚本参数使用直接解构形式，每个参数旁显示类型、含义和来源。管理员只需要在业务逻辑区域编写代码。

~~~js
/**
 * @output hasSql:boolean 回答是否包含 SQL
 * @output sqlLineCount:number SQL 有效行数
 */
export async function run({
  workspace,            // WorkspaceFiles：当前用户工作空间的只读文件 API
  lastAssistantMessage, // string：模型本轮回答
  userId,               // number：当前用户 ID
  tenantId,             // number：当前租户 ID
}) {
  // ===== 在这里编写业务逻辑 =====
  const packageJson = await workspace.readJson('package.json');
  const hasSql = typeof lastAssistantMessage === 'string'
    && /\b(select|with|insert|update|delete)\b/i.test(lastAssistantMessage);

  return {
    output: {
      hasSql,
      sqlLineCount: hasSql ? lastAssistantMessage.split('\n').length : 0,
    },
  };
}
~~~

`workspace` 由后续高级脚本执行器按当前认证用户的工作空间注入，不暴露 Node.js 原生 `fs`：

~~~ts
interface WorkspaceFiles {
  readText(relativePath: string): Promise<string>;
  readJson(relativePath: string): Promise<unknown>;
  list(relativeDirectory?: string): Promise<Array<{
    path: string;
    type: 'file' | 'directory';
  }>>;
  exists(relativePath: string): Promise<boolean>;
}
~~~

所有路径必须相对工作空间根目录；执行器必须解析真实路径并阻止 `..`、绝对路径、符号链接越界和超限读取。

### 9.3 输出规则

- output 是 CCUI 自定义结构化结果，不等同于 SDK 原生 Hook 返回值。
- 默认 output 为空。
- @output 声明格式为：字段名、类型、中文说明。
- 支持 string、number、boolean、object、array。
- 页面解析 @output 后自动生成 $script.output.字段名。
- `$script.output.字段名` 会自动出现在统一门槛、记录数据、调用工具参数、追加上下文和其他支持变量的基础行为选择器中。
- 脚本输出必须是 JSON 可序列化数据。

脚本模板中的注释示例使用 `@output-example`，因此不会产生虚假字段。管理员把它改成真正的 `@output` 并返回同名值后，页面才会暴露该字段：

~~~js
/**
 * @output sqlLineCount:number SQL 有效行数
 */
const sqlLineCount = 12;
return { output: { sqlLineCount } };
~~~

### 9.4 执行安全要求

真实执行阶段必须满足：

- 不在 CCUI 主进程中直接 eval。
- 使用隔离进程或受限沙箱。
- 禁止直接访问文件系统、网络、process、require、动态 import 和 child_process。
- 文件访问只能通过执行器注入的只读 `workspace` API，并强制限定到当前用户工作空间。
- 输入只允许来自白名单上下文。
- 默认超时 5 秒。
- 脚本源码最大 128 KB。
- 输出大小、日志大小和执行时间必须受限。
- 敏感环境变量不得传入脚本。

## 10. 基础行为设计

### 10.1 行为清单

| 行为 | 类型 | 可用条件 |
| --- | --- | --- |
| 记录数据 | record_data | 全部事件 |
| 调用工具 | call_tool | 全部事件；第一期仅 MCP 工具 |
| 追加模型上下文 | append_context | SDK 支持 additionalContext 的事件 |
| 发起恢复回合 | invoke_skill_recovery | 仅 StopFailure |
| 流程决策 | decision | 支持决策控制的事件 |
| 修改输入 | update_input | PreToolUse 且精确选择具体工具 |
| 修改输出 | update_output | PostToolUse |

### 10.2 记录数据

管理员只勾选需要保存的字段：

- 当前事件字段。
- 高级脚本输出。
- 前序行为输出。
- 允许记录的环境字段。

系统自动补充 Hook ID、版本、用户、会话、执行状态和时间，不在行为编辑器中重复配置。

### 10.3 调用工具

第一期只能调用已连接且健康的 MCP 工具。

配置流程：

1. 选择具体 MCP 工具。
2. 页面读取工具 inputSchema。
3. 为每个参数选择数据来源。
4. 数据来源可以是固定值、事件字段、环境变量、脚本输出或前序行为输出。
5. 运行前校验必填参数和参数类型。
6. 调用结果作为该行为 output，供后续行为使用。

Hook 不能直接主动调用 Bash、Read、Write、Edit 或 Skill，因为这些工具属于 Claude 模型回合内部的工具调度。Hook 回调不是模型，也没有通用的“主动调用 Claude Code 内置工具”接口。

### 10.4 追加模型上下文

管理员填写可编辑文本，并插入变量：

~~~text
当前用户 ${context.username} 的风险等级为
${script.output.riskLevel}，请按高风险流程继续处理。
~~~

运行时转换为当前事件支持的 additionalContext。

### 10.5 发起恢复回合

仅用于回答异常结束 StopFailure。

配置内容：

- 选择 Skill。
- 填写 Skill 参数模板。
- 设置最多执行轮数，范围 1 至 5。

该行为不是在已经失败的回调中继续向模型发送消息，而是由 CCUI Session Runner 续接同一会话，发起一个新的模型回合。

必须增加：

- recoveryDepth 递归保护。
- 同一 Hook 不得在恢复回合中再次触发自己。
- 用户短信开关检查。
- 频率限制与去重。
- 不可恢复错误过滤。

### 10.6 流程决策

管理员通过选择器选择当前事件允许的结果，并编辑原因。

示例：

- continue：继续。
- block：阻止。
- allow：允许。
- deny：拒绝。
- ask：要求用户确认。

后端必须根据事件能力再次校验结果，不能只信任前端。

### 10.7 修改输入

修改输入只表示修改即将交给工具的 tool_input。

例如 Hook 精确匹配 Bash 时，可修改：

- command：Bash 即将执行的命令。
- description：显示给用户的命令说明。
- timeout：超时时间。
- run_in_background：是否后台运行。

例如匹配某个 MCP 工具时，可修改该工具 inputSchema 中定义的字段。

配置流程：

~~~text
选择具体工具
→ 选择需要修改的字段
→ 选择新值来源
→ 固定值或变量引用
~~~

执行时必须复制完整原始 tool_input，应用单字段修改并重新通过 Schema 校验，再把完整 updatedInput 返回 SDK。

### 10.8 修改输出

仅在 PostToolUse 可用。

可以修改：

- 整个工具返回值。
- 返回给 Claude 的文本内容。
- MCP structuredContent。

修改输出只影响 Claude 后续看到的工具结果，不会撤销工具已经完成的数据库写入、文件写入或网络请求。

## 11. 配置数据模型

当前前后端配置契约如下：

~~~ts
type HookConfig = {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'disabled';
  eventName: HookEventName;
  matcher: {
    mode?: 'exact' | 'regex';
    value?: string;
  };
  gate: {
    mode: 'all' | 'any';
    conditions: Array<{
      id: string;
      field: string;
      operator:
        | 'equals'
        | 'not_equals'
        | 'contains'
        | 'not_contains'
        | 'starts_with'
        | 'ends_with'
        | 'matches_regex'
        | 'greater_than'
        | 'less_than'
        | 'is_true'
        | 'is_false'
        | 'is_empty'
        | 'is_not_empty';
      value?: string | number | boolean;
    }>;
  };
  advancedScript: null | {
    enabled: true;
    language: 'javascript';
    code: string;
    outputs: Array<{
      name: string;
      type: 'string' | 'number' | 'boolean' | 'object' | 'array';
      description: string;
    }>;
  };
  actions: Array<{
    id: string;
    type: HookActionType;
    position: number;
    config: Record<string, unknown>;
  }>;
  version: number;
  globalEnabled: boolean;
  boundUserCount: number;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};
~~~

## 12. 状态与发布规则

~~~mermaid
stateDiagram-v2
  [*] --> draft
  draft --> publishedStopped: 发布
  publishedStopped --> publishedStarted: 启动（绑定全部用户）
  publishedStarted --> publishedStopped: 停止
  publishedStarted --> draft: 编辑并保存
  publishedStopped --> draft: 编辑并保存
  draft --> [*]: 删除
  publishedStarted --> [*]: 删除
  publishedStopped --> [*]: 删除
~~~

规则：

- 新建 Hook 状态为 draft。
- 保存已发布 Hook 后重新变为 draft。
- 发布前执行严格校验。
- 发布成功后版本号加 1。
- 发布成功后 `global_enabled = 0`，必须由管理员点击“启动”。
- 启动时在一个事务中设置 `global_enabled = 1`，并为 `users` 表中的全部用户写入绑定关系。
- Hook 启动期间新增用户时，数据库触发器自动写入绑定关系。
- 停止只设置 `global_enabled = 0`，不删除绑定记录。
- 后续执行器只加载 `published + global_enabled + 当前用户已绑定` 的 Hook。
- 发布至少包含一个基础行为。

### 12.1 当前配置限制

- 名称最多 120 个字符。
- 功能说明最多 1000 个字符。
- Matcher 最多 240 个字符。
- 一个 Hook 最多 20 个统一门槛条件。
- 一个 Hook 最多 20 个基础行为。
- 高级脚本最多 128 KB。
- 脚本最多声明 50 个输出字段。
- 单个行为配置最多 256 KB。

## 13. 数据库设计

### 13.1 当前已实现表

hooks：

- id
- name
- description
- status
- event_name
- matcher_json
- gate_json
- advanced_script_json
- version
- global_enabled
- created_by
- updated_by
- created_at
- updated_at
- published_at

hook_actions：

- id
- hook_id
- position
- action_type
- config_json
- created_at
- updated_at

user_hook_bindings：

- user_id
- hook_id
- bound_by
- bound_at
- updated_at

`(user_id, hook_id)` 是主键。该表表示用户与 Hook 的绑定关系，不表示用户自行安装，也不提供用户侧开关。执行器通过该表查询当前用户可加载的 Hook。

### 13.2 执行阶段新增表

建议增加：

#### hook_versions

保存每次发布的不可变配置快照，运行时只引用已发布版本。

#### hook_runs

记录一次 Hook 运行：

- Hook 与版本。
- 用户和会话。
- 事件和 Matcher 结果。
- 门槛结果。
- 最终状态。
- 总耗时。
- 脱敏错误。

#### hook_action_runs

记录脚本和每个行为的输入摘要、输出摘要、状态、耗时和错误。

#### hook_records

保存 record_data 行为选择的结构化业务数据。

## 14. Admin API

### 14.1 当前已实现

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/admin/hooks | Hook 列表 |
| POST | /api/admin/hooks | 创建草稿 |
| GET | /api/admin/hooks/:hookId | Hook 详情 |
| PUT | /api/admin/hooks/:hookId | 保存 Hook |
| POST | /api/admin/hooks/:hookId/publish | 发布 |
| POST | /api/admin/hooks/:hookId/start | 为全部用户启动 |
| POST | /api/admin/hooks/:hookId/stop | 停止全局执行 |
| DELETE | /api/admin/hooks/:hookId | 删除 |
| GET | /api/admin/hooks/settings | 获取可见事件 |
| PUT | /api/admin/hooks/settings | 保存可见事件 |
| GET | /api/admin/hooks/resources | 获取事件、工具、MCP、Skill 和环境变量目录 |

所有接口必须经过系统管理员权限校验。

### 14.2 执行阶段新增

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | /api/admin/hooks/:hookId/validate | 完整校验 |
| POST | /api/admin/hooks/:hookId/test | 模拟测试 |
| GET | /api/admin/hooks/:hookId/runs | 运行记录 |
| GET | /api/admin/hook-runs/:runId | 运行详情 |

## 15. Claude Agent SDK 对接与编译

### 15.1 SDK 要求的真实类型

当前项目安装的 @anthropic-ai/claude-agent-sdk 0.2.116 对 options.hooks 的类型定义为：

~~~ts
type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: {
    signal: AbortSignal;
  },
) => Promise<HookJSONOutput>;

interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  // 单位为秒，限制当前 Matcher 下所有 Callback 的执行时间
  timeout?: number;
}

type CompiledSdkHooks =
  Partial<Record<HookEvent, HookCallbackMatcher[]>>;
~~~

因此，编译后的 Hook 不是 JSON，也不能保存回数据库。它是包含 JavaScript Callback 函数、运行时用户信息和 AbortSignal 的内存对象，只在本次 query 生命周期内有效。

数据库保存的是声明式 Hook 配置；每次发起 query 前，都要重新把配置编译成上述内存对象。

### 15.2 一条 PreToolUse Hook 的编译输入

数据库中的配置示例：

~~~json
{
  "id": "hook-fill-tenant-id",
  "name": "自动补全 SQL 工具租户",
  "status": "published",
  "version": 3,
  "eventName": "PreToolUse",
  "matcher": {
    "value": "mcp__data_query__submit_sql"
  },
  "gate": {
    "mode": "all",
    "conditions": [
      {
        "id": "condition-1",
        "field": "$event.toolInput.tenant_id",
        "operator": "is_empty"
      }
    ]
  },
  "advancedScript": null,
  "actions": [
    {
      "id": "action-update-tenant",
      "type": "update_input",
      "position": 0,
      "config": {
        "targetPath": "tool_input.tenant_id",
        "replacement": {
          "source": "reference",
          "path": "$context.tenantId"
        }
      }
    }
  ]
}
~~~

### 15.3 真实、正确的编译结果

上述一条配置编译后，传给 SDK 的对象格式如下：

~~~js
const compiledAdminHooks = {
  PreToolUse: [
    {
      matcher: 'mcp__data_query__submit_sql',
      timeout: 30,
      hooks: [
        async (input, toolUseID, { signal }) => {
          if (input.hook_event_name !== 'PreToolUse') {
            return {};
          }

          const result = await hookEngine.execute({
            definition: publishedHookDefinition,
            rawInput: input,
            runtime: {
              userId,
              sessionId,
              tenantId,
              toolUseID,
            },
            signal,
          });

          if (!result.matched || !result.updatedInput) {
            return {};
          }

          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: result.permissionDecision ?? 'allow',
              permissionDecisionReason: result.reason,
              updatedInput: result.updatedInput,
              additionalContext: result.additionalContext,
            },
          };
        },
      ],
    },
  ],
};
~~~

这个对象满足 SDK 的真实结构：

- 第一层 Key 必须是 SDK HookEvent，例如 PreToolUse。
- 每个 Event 的值必须是 HookCallbackMatcher 数组。
- matcher 是 SDK 原生 Matcher 字符串。
- hooks 必须是异步 Callback 数组。
- timeout 的单位是秒。
- Callback 的第二个参数是 toolUseID。
- Callback 的第三个参数包含 signal，用于取消和超时传播。
- Callback 必须返回 Promise<HookJSONOutput>。
- 没有需要作用于 SDK 的结果时返回空对象。

PreToolUse 修改输入时，正确的 SDK 返回结构是：

~~~js
{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: '已补全当前用户租户',
    updatedInput: {
      sql: 'SELECT * FROM orders',
      tenant_id: 1001,
    },
    additionalContext: '已按照当前登录用户补全租户参数。',
  },
}
~~~

updatedInput 必须是修改后的完整工具输入对象，不能只返回 tenant_id 这一个 Patch。

#### 15.3.1 可直接用于 CCUI 的完整 TypeScript 模板

下面是编译完成后可直接赋值给 Agent SDK options.hooks 的完整模板：

~~~ts
import {
  query,
  type Options,
} from '@anthropic-ai/claude-agent-sdk';

const compiledAdminHooks = {
  PreToolUse: [
    {
      // SDK 原生 Matcher；工具事件匹配 tool_name
      matcher: 'mcp__data_query__submit_sql',

      // 当前 Matcher 下全部 Callback 的超时时间，单位为秒
      timeout: 30,

      hooks: [
        async (input, toolUseID, { signal }) => {
          if (input.hook_event_name !== 'PreToolUse') {
            return {};
          }

          const result = await hookEngine.execute({
            definition: publishedHookDefinition,
            rawInput: input,

            runtime: {
              userId: currentUser.id,
              tenantId: currentUser.tenantId,
              sessionId: input.session_id,
              toolUseID,
            },

            signal,
          });

          // 统一门槛未通过，不影响 Claude 原流程
          if (!result.matched) {
            return {};
          }

          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision:
                result.permissionDecision ?? 'allow',
              permissionDecisionReason:
                result.reason,

              // 必须是修改后的完整工具输入
              updatedInput:
                result.updatedInput,

              // 可选：追加给模型的上下文
              additionalContext:
                result.additionalContext,
            },
          };
        },
      ],
    },
  ],
} satisfies NonNullable<Options['hooks']>;

const sdkOptions: Options = {
  ...baseSdkOptions,

  // 正式实现时必须与 CCUI 已有内部 Hook 合并，
  // 不能直接覆盖 PreToolUse 和 Notification。
  hooks: mergeSdkHooks(
    baseSdkOptions.hooks,
    compiledAdminHooks,
  ),
};

const queryInstance = query({
  prompt: inputQueue,
  options: sdkOptions,
});
~~~

其中：

- publishedHookDefinition 是从不可变发布版本读取的 Hook 定义。
- currentUser 来自 CCUI 服务端认证上下文，不能来自前端提交。
- hookEngine.execute 负责高级脚本、统一门槛和基础行为。
- mergeSdkHooks 负责保留 CCUI 平台内部 Hook。
- input、toolUseID 和 signal 均由 Agent SDK 在事件触发时传入。
- compiledAdminHooks 包含函数，只能保存在本次 query 的内存中。

SDK 触发 PreToolUse 时，Callback 收到的真实输入形态为：

~~~ts
{
  hook_event_name: 'PreToolUse',
  session_id: 'session-123',
  transcript_path: '/path/to/transcript.jsonl',
  cwd: '/workspace/project',
  tool_name: 'mcp__data_query__submit_sql',
  tool_input: {
    sql: 'SELECT * FROM orders',
    tenant_id: null,
  },
  tool_use_id: 'tool-use-001',
}
~~~

修改输入后的真实返回形态为：

~~~ts
{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason:
      '已补全当前登录用户的租户参数',
    updatedInput: {
      sql: 'SELECT * FROM orders',
      tenant_id: 1001,
    },
    additionalContext:
      '系统已按照当前登录用户补全 tenant_id。',
  },
}
~~~

SDK 随后使用 updatedInput 中的完整参数执行真实 MCP 工具。

### 15.4 无 Matcher 事件的格式

Stop、UserPromptSubmit 等没有配置原生 Matcher 时，直接省略 matcher：

~~~js
const compiledAdminHooks = {
  Stop: [
    {
      timeout: 30,
      hooks: [
        async (input, toolUseID, { signal }) => {
          return hookEngine.executeAndAdapt({
            definition: stopHookDefinition,
            rawInput: input,
            runtime: { userId, sessionId, toolUseID },
            signal,
          });
        },
      ],
    },
  ],
};
~~~

不要把 CCUI 的统一执行门槛拼成 matcher。回答是否包含 SQL、用户是否允许短信通知等条件仍由 Hook Engine 判断。

### 15.5 配置编译过程

编译流程如下：

~~~mermaid
flowchart TD
  A["取得服务端认证 userId"] --> B["查询 published Hook"]
  B --> C["筛选 global_enabled = 1"]
  C --> D["联查当前用户的 Hook 绑定"]
  D --> E["校验 Event 是否属于 SDK HOOK_EVENTS"]
  E --> F["读取 Hook 发布版本快照"]
  F --> G["校验 Matcher 与事件能力"]
  G --> H["创建包含定义和运行时上下文的 Callback 闭包"]
  H --> I["生成 HookCallbackMatcher"]
  I --> J["按 eventName 放入数组"]
  J --> K["与 CCUI 已有内部 Hook 合并"]
  K --> L["赋值给 sdkOptions.hooks"]
  L --> M["调用 query"]
~~~

具体步骤：

1. 从 ws.userId 读取当前认证用户，不接收前端提交的 userId。
2. 查询 status 为 published 的 Hook。
3. 联查 `user_hook_bindings`，只保留 `global_enabled = 1` 且当前用户存在绑定记录的 Hook。
4. 加载不可变的发布版本，避免运行中读取到正在编辑的草稿。
5. 使用 SDK 导出的 HOOK_EVENTS 校验 eventName。
6. 校验当前事件是否支持已配置的基础行为。
7. 把 Matcher 编译为 SDK 正则字符串：正则模式原样使用；精确模式转义后添加起止锚点；空值或 `*` 时省略 matcher。
8. 为每个 Hook 创建一个 Callback 闭包，闭包持有 Hook ID、版本和当前运行时上下文。
9. Callback 统一调用 Hook Engine，不把脚本和行为直接编译成多个 SDK Callback。
10. 按 eventName 组成 Partial<Record<HookEvent, HookCallbackMatcher[]>>。
11. 与 CCUI 现有的 PreToolUse、Notification 等内部 Hook 合并。
12. 把合并结果赋值给 sdkOptions.hooks，再调用 query。

### 15.6 编译器伪代码

~~~js
function compileHookDefinitions(definitions, runtime) {
  const compiled = {};

  for (const definition of definitions) {
    const eventName = definition.eventName;
    const matcher = compileSdkMatcher(definition.matcher);

    const callbackMatcher = {
      ...(matcher ? { matcher } : {}),
      timeout: 30,
      hooks: [
        createAdminHookCallback(definition, runtime),
      ],
    };

    if (!compiled[eventName]) {
      compiled[eventName] = [];
    }
    compiled[eventName].push(callbackMatcher);
  }

  return compiled;
}

function compileSdkMatcher(matcher) {
  const value = matcher?.value?.trim();
  if (!value || value === '*') return undefined;
  if (matcher.mode === 'regex') return value;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^(?:${escaped})$`;
}

function createAdminHookCallback(definition, runtime) {
  return async (input, toolUseID, { signal }) => {
    const execution = await hookEngine.execute({
      definition,
      rawInput: input,
      runtime: {
        ...runtime,
        sessionId: input.session_id,
        toolUseID,
      },
      signal,
    });

    return hookResultAdapter.toSdkOutput({
      eventName: definition.eventName,
      execution,
    });
  };
}
~~~

### 15.7 与项目现有 Hook 合并

当前项目已经在 server/claude-sdk.js 中注册：

- PreToolUse：MCP 参数覆盖。
- Notification：向 CCUI 推送需要用户注意的通知。

管理员 Hook 不能直接覆盖 sdkOptions.hooks，必须按事件合并 Matcher 数组：

~~~js
function mergeSdkHooks(baseHooks = {}, adminHooks = {}) {
  const merged = { ...baseHooks };

  for (const [eventName, callbackMatchers] of Object.entries(adminHooks)) {
    merged[eventName] = [
      ...(merged[eventName] ?? []),
      ...callbackMatchers,
    ];
  }

  return merged;
}

const sdkOptions = mapCliOptionsToSDK(runtimeOptions);

// 此处保留项目现有的内部 Hook 注册逻辑。
registerInternalHooks(sdkOptions);

const definitions = await hookRuntimeRepository.listEnabledPublishedHooks({
  userId: ws.userId,
});

const adminHooks = compileHookDefinitions(definitions, {
  userId: ws.userId,
  tenantId: runtimeOptions.tenantId,
});

sdkOptions.hooks = mergeSdkHooks(
  sdkOptions.hooks,
  adminHooks,
);

const queryInstance = query({
  prompt: inputQueue,
  options: sdkOptions,
});
~~~

合并顺序和同一事件下多个 Hook 的结果冲突必须通过集成测试确认。平台内部安全 Hook 不允许被管理员 Hook 删除或覆盖。

### 15.8 Callback 内部执行过程

SDK 调用 Callback 后，Hook Engine 执行：

~~~mermaid
flowchart TD
  A["SDK HookInput"] --> B["Event Adapter 标准化字段"]
  B --> C["再次校验 Hook 发布状态和版本"]
  C --> D["执行高级脚本（可选）"]
  D --> E["判断统一执行门槛"]
  E -- "未通过" --> F["返回空 HookJSONOutput"]
  E -- "通过" --> G["按 position 执行基础行为"]
  G --> H["合并行为结果"]
  H --> I["Result Adapter"]
  I --> J["返回当前事件合法的 HookJSONOutput"]
~~~

事件与典型 SDK 输出对应关系：

| 事件 | 典型 HookSpecificOutput |
| --- | --- |
| UserPromptSubmit | additionalContext、sessionTitle |
| PreToolUse | permissionDecision、updatedInput、additionalContext |
| PostToolUse | additionalContext、updatedMCPToolOutput |
| PostToolUseFailure | additionalContext |
| PermissionRequest | decision |
| StopFailure | 当前版本没有 StopFailure 专属 HookSpecificOutput |

StopFailure 的记录数据和调用 MCP 等副作用在 Callback 内执行；需要模型调用 Skill 时，由 CCUI Session Runner 在 Callback 结束后发起新的恢复 query。

### 15.9 单次执行链路

~~~mermaid
flowchart TD
  A["用户向模型发送问题"] --> B["CCUI 取得认证用户和会话"]
  B --> C["加载该用户启用的发布版本"]
  C --> D["编译并合并 options.hooks"]
  D --> E["Agent SDK 开始 query"]
  E --> F["SDK 触发某个 Hook Event"]
  F --> G["SDK Matcher 粗筛"]
  G --> H{"是否启用高级脚本"}
  H -- "是" --> I["安全执行高级脚本"]
  H -- "否" --> J["统一执行门槛"]
  I --> J
  J -- "不通过" --> K["记录 no_match 并返回空对象"]
  J -- "通过" --> L["按顺序执行基础行为"]
  L --> M["Result Adapter 生成 HookJSONOutput"]
  M --> N["SDK 根据结果继续、修改或阻止流程"]
~~~

### 15.10 Skill 的处理

Skill 不是 Hook 可以直接调用的普通函数。

- 模型主动选择 Skill 时，它表现为 toolName 为 Skill 的工具调用，可用 PreToolUse 或 PostToolUse Hook 观察。
- Hook 如果需要主动让模型调用 Skill，必须通过“发起恢复回合”启动一个新的 Agent SDK query。
- 新回合使用 Slash Command 形式调用 Skill，并必须防止递归。

## 16. 运行记录与审计

### 16.1 三类记录的区别

| 类型 | 用途 | 内容 |
| --- | --- | --- |
| Hook 结构化记录 | 业务分析 | record_data 主动选择的业务字段 |
| 审计日志 | 安全追溯 | 谁在何时触发哪个 Hook、配置版本和执行结果 |
| 指标记录 | 运行监控 | 成功率、耗时、错误数、超时数 |

系统审计日志自动生成，管理员不需要在“记录数据”行为中重复选择。

### 16.2 脱敏字段

保存或展示前必须递归处理：

- authorization
- cookie
- token
- password
- secret
- api_key
- apikey
- access_token
- refresh_token
- credential

字段名大小写不敏感，超长内容必须截断。

## 17. 场景示例

### 17.1 记录模型生成 SQL 的行数

该能力不预置为专用行为，通过通用配置完成：

~~~text
触发位置：回答结束 Stop
匹配条件：无
高级脚本：提取 SQL，并输出 hasSql 和 sqlLineCount
统一执行门槛：hasSql 等于 是
基础行为：记录数据
记录字段：hasSql、sqlLineCount、当前用户、当前会话
~~~

### 17.2 工具执行前修改 MCP 参数

~~~text
触发位置：工具执行前 PreToolUse
匹配条件：选择 mcp__data_query__submit_sql
统一执行门槛：当前用户已启用数据治理 等于 是
基础行为：修改输入
修改字段：tool_input.tenant_id
修改为：$context.tenantId
~~~

运行时结果：

~~~ts
{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: {
      sql: 'SELECT ...',
      tenant_id: 1001,
    },
  },
}
~~~

### 17.3 回答异常后调用短信 Skill

~~~text
触发位置：回答异常结束 StopFailure
基础行为：发起恢复回合
Skill：send-sms
参数：给当前用户 ${context.userId} 发送：本轮模型执行失败，请稍后重试。
最多执行轮数：3
~~~

当前用户是否已绑定该 Hook 是执行器的系统前置条件，不由管理员重复配置。短信 Skill 或其后端服务根据已认证的 userId 查询真实的短信授权状态和接收号码；Hook 配置不预置手机号、短信开关或接收对象。

实际执行：

~~~text
本轮模型请求失败
→ StopFailure Hook
→ 读取当前认证用户环境变量
→ 渲染 Skill 参数
→ CCUI 续接同一会话发起新 query
→ 新回合调用 /send-sms
→ 记录脱敏执行结果
~~~

## 18. 验收标准

### 18.1 配置阶段

1. 管理员可以创建、编辑、发布、启动、停止和删除 Hook。
2. 默认显示四个常用事件，并能通过“更多事件”配置 28 个事件的可见范围。
3. 名称和触发位置等宽对齐，事件说明使用悬浮提示。
4. 功能说明横跨整个内容区。
5. 页面不展示用户权限配置。
6. 匹配条件根据事件动态展示，并支持精确匹配和通过前后端校验的正则匹配。
7. 统一门槛只配置一次，基础行为不出现独立执行条件。
8. 高级脚本默认关闭，默认输出为空。
9. @output 声明的脚本字段会自动进入门槛和基础行为选择器。
10. 记录数据、调用工具、追加上下文、恢复回合、流程决策、修改输入和修改输出按事件能力展示。
11. 调用工具只展示真实可用的 MCP 工具，并根据 inputSchema 生成参数表单。
12. PreToolUse 未精确选择工具时不能发布修改输入行为。
13. 发布前后端必须完成严格校验。
14. 发布后 Hook 默认未启动；启动后为全部现有用户建立绑定，新用户自动绑定。
15. 高级脚本模板提供只读 workspace API 及 @output 到基础行为的注释示例。

### 18.2 执行阶段

1. 每次 query 只加载全局已启动、当前用户已绑定的 published Hook。
2. Matcher、高级脚本、统一门槛和基础行为按规定顺序执行。
3. 高级脚本在安全隔离环境中运行。
4. 修改输入返回完整 updatedInput。
5. MCP 调用使用真实工具执行器，不使用 Mock。
6. 恢复 Skill 使用新模型回合并具备递归保护。
7. 普通用户不需要也不能在用户侧安装或启停 Hook。
8. 高级脚本只通过受限只读 workspace API 访问当前用户工作空间，不能越界。
9. 管理员可以查看脱敏运行记录。
10. 普通用户不能查看完整脚本、参数和其他用户记录。
11. Hook 执行失败不会泄露 Secret 或破坏非相关会话。

## 19. 代码位置

当前实现对应文件：

- src/components/admin/HookConfigsTab.tsx：Hook 列表、CRUD 和更多事件。
- src/components/admin/hook-config/HookConfigEditor.tsx：单页 Hook 配置器。
- src/components/admin/hook-config/catalog.ts：28 个事件、字段和行为能力矩阵。
- src/components/admin/hook-config/types.ts：前端配置类型。
- server/services/hook-configs.js：后端校验、CRUD、资源目录。
- server/database/hook-config-schema.js：hooks、hook_actions 与 user_hook_bindings 数据库表及新用户自动绑定触发器。
- server/routes/admin.js：Admin Hook API。
- server/services/hook-configs.test.js：Hook 配置服务测试。

## 20. 后续实施顺序

建议按以下顺序继续：

1. 发布版本快照 hook_versions。
2. Hook Compiler 与 Agent SDK options.hooks 接入，并使用 user_hook_bindings 加载当前用户 Hook。
3. Event Adapter 与 Result Adapter。
4. 高级脚本安全执行器及只读 workspace API。
5. 基础行为执行器。
6. 模拟测试。
7. 运行记录、结构化记录与指标。
8. Chat 中的简化 Hook 执行状态展示。
9. 完整集成测试与安全测试。
