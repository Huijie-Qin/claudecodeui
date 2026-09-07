# Agent 模板端到端测试报告

日期：2026-09-07

结论：已同步最新 `develop`，完成模板配置、发布、创建项目、实际 Agent 使用的完整链路测试。发现并修复两个 MCP 配置问题，修复后的 343 个后端测试、21 个前端逻辑测试、13 组端到端场景全部通过，另完成浏览器操作验证。

## 代码与环境

- 基线：`c48b8c8 fix(mcp): trust system CA certificates`；本地 `develop` 与 `origin/develop` 的提交差异为 `0 / 0`。
- 拉取前的本地改动已保留。备份分支为 `codex/backup-before-agent-template-qa-20260907`，Git 中保留 `8124530` autostash，完整补丁另存于 `/private/tmp/ccui-before-develop-20260907.patch`。
- 后端回归与完整链路在隔离的 Node.js 22.22.3 容器运行；实际 Claude CLI 为 2.1.141，使用项目的 Claude Agent SDK。
- 独立数据库、租户、用户、工作区和测试端口；Skill Market、MCP 和模型响应均使用本地测试服务。模型响应固定，但应用接口、SDK 子进程、Skill 加载、MCP 协议和 Hook 脚本执行均使用真实代码。
- 前端执行 TypeScript 检查、生产构建、相关逻辑测试和浏览器交互验证。后端 TypeScript 检查与构建通过；本次新增和修改文件的定向 ESLint 检查通过；`git diff --check` 通过。前端构建仅出现既有的大 chunk 提示。
- 未部署到现有 3001 服务，未修改其业务数据库，未提交或推送代码。
- 测试结束后已移除本次临时容器和下载的测试 CLI，保留脚本、修复、报告及运行日志。

## 发现与修复

### 1. MCP 名称包含双下划线时，默认值与强制值未生效

复现：配置服务器 `qa__echo`，为 `echo_settings` 设置默认参数和强制参数，调用 `mcp__qa__echo__echo_settings`。原解析逻辑把服务器识别为 `qa`，导致参数覆盖配置无法匹配；真实 MCP 服务收到未覆盖的输入。

修复：优先按已配置服务器名称匹配，重叠名称取最长匹配，再解析工具名称。增加 `qa` 与 `qa__echo` 同时存在的回归测试，并在真实 SDK → MCP 调用中验证。

相关文件：

- `server/services/mcp-tool-overrides.js`
- `server/services/mcp-tool-overrides.test.js`

### 2. 模板参数编辑允许保存错误类型，空数字被转换为 0

复现：在模板 MCP 设置中，为数组参数 `filters` 输入对象 `{"bad":"array"}`，原页面允许保存；数字输入留空时，原逻辑通过 `Number('')` 转为 `0`。接口也缺少参数值类型检查。

修复：页面与服务端共用参数值检查，验证基本 JSON 类型、整数、枚举和数组元素类型；数字留空明确报错。合法的 `0`、`false`、空字符串、空数组和空对象保持原值。

相关文件：

- `shared/mcpParameterValue.js`
- `server/services/agent-templates.js`
- `server/services/agent-templates.test.js`
- `src/components/admin/AgentTemplateMcpSettingsDialog.tsx`

该检查用于模板参数的类型和值兼容性，不是完整 JSON Schema 校验器；不在此次修复中增加对所有组合 schema、字符串格式及数值范围约束的支持。

## 验证范围与结果

| 范围 | 验证内容 | 结果 |
| --- | --- | --- |
| 模板管理 | 创建、编辑后保存、重新发布、租户可见性、非管理员权限、项目快照 | 通过 |
| Skill 配置 | 137 项目录全量读取，检索第 137 项，导入、校验、发布、模板选择 | 通过 |
| Skill 使用 | 项目安装 `SKILL.md` 与引用资源，项目技能列表显示，真实 SDK 调用 `test-skill-137` 并加载内容 | 通过 |
| 项目说明 | 模板生成 `CLAUDE.md`，创建后展示引导语，SDK 请求包含项目记忆 | 通过 |
| MCP 配置 | HTTP 握手、`tools/list`、发布、项目 `.mcp.json`、项目连接检测 | 通过 |
| 默认值 | 参数缺失时补齐；Agent 已给出的空字符串、空数组保持原值 | 通过 |
| 强制值 | 覆盖 Agent 给出的值；缺失参数也补齐；`0`、`false` 等合法值保留 | 通过 |
| 不设置参数 | 不生成该参数的覆盖规则，保留 Agent 原始输入 | 通过 |
| 参数校验 | 拒绝未知工具、未知参数、错误类型、错误枚举；页面阻止空数字和对象冒充数组 | 通过 |
| MCP tools | 部分选择、全选、全不选；未设置选择规则时默认全部允许；个人偏好覆盖及用户隔离 | 通过 |
| 禁用工具执行 | SDK 会话中未勾选的 `read_status` 未到达 MCP 服务；浏览器全不选时两个工具均被阻止 | 通过 |
| Hook 设置 | 发布、模板选择、默认开关、用户开关、聊天可见性、禁止用户关闭、非法组合拒绝 | 通过 |
| Hook 使用 | 实际 Stop 脚本执行并写入记录，聊天中显示执行完成；版本锁定、项目和用户隔离 | 通过 |
| Hook 深度回归 | JavaScript/Python 执行器、资源装载、失败记录、MCP 调用、Skill 后续回合；28 种 Hook 事件和能力矩阵 | 通过 |
| 关联回归 | MCP helper、代理、访问控制、工具覆盖、Skill 安装、模板 Hook 资源失败降级及现有 MCP loop 改动 | 通过 |

### 真实 SDK 调用证据

测试模型发起 `echo_settings` 时给出 `limit=99`、`region=us`、`include_metadata=true`，省略 `topic` 和 `filters`。MCP 服务实际收到：

```json
{
  "limit": 7,
  "region": "cn",
  "include_metadata": false,
  "topic": "template-topic",
  "filters": ["published"]
}
```

同一会话故意请求未勾选的 `read_status`，该请求未到达 MCP 服务。会话读取了 Skill 内容及项目记忆，完成后 Stop Hook 新增了执行记录。

### 浏览器验证

通过管理后台编辑并发布 `QA UI 浏览器验证模板`，设置 MCP tools 全不选、`topic` 不设置、`limit` 强制为 `0`、`filters` 默认为 `[]`，Hook 强制启用且在聊天中显示。

随后通过“创建新项目”使用此模板创建 `qa-ui-created`，检查项目 Skill、MCP 设置和 Hook 开关。Hook 显示“模板强制启用”，启用开关不可关闭。

2026-09-07 15:07（Asia/Shanghai）的浏览器会话中：

1. `Skill(test-skill-137)` 返回 `Launching skill: test-skill-137`。
2. 模型刻意请求的两个 MCP 工具均返回 `No such tool available`，符合全不选的预期。
3. 会话完成并显示 Stop Hook“已完成”卡片。

只读查询隔离数据库进一步确认，浏览器创建的项目（workspace 4）产生了 1 条 `template-e2e` Hook 数据记录。

## 测试数量与证据

| 测试 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| 后端相关回归 | 343 | 0 | 0 |
| 前端相关逻辑 | 21 | 0 | 0 |
| 完整端到端场景组 | 13 | 0 | 0 |

以上合计 377 个测试/场景组，不包含额外的浏览器手动操作。这里的“全量”指 Agent 模板及 Skill/MCP/Hook 相关测试范围，不代表仓库全部无关功能的测试总量。

本地证据保存在 `.tmp/agent-template-qa-20260907/`：

- `e2e-report.json`：最终 13 组端到端结果及 MCP 实收参数。
- `sdk-e2e-server.log`：完整链路运行日志。
- `final-regression-node22.log`：343 项后端测试结果。
- `frontend-tests.log`：21 项前端测试结果。
- `build-client.log`、`lint.log`：构建及定向静态检查结果。

初期排障日志也保留在该目录；最终结果以以上列出的报告为准。主机 Node 24 运行部分 SQLite 测试曾触发原生断言退出，因此后端最终验收使用项目要求的 Node 22，全部通过。

## 复跑

新增 `scripts/agent-template-e2e.mjs` 和对应 npm 命令。在 Node 22、项目依赖和可用 Claude CLI 已安装、前端已构建的环境下执行：

```sh
npm run test:agent-templates:e2e
```

保留测试实例用于浏览器验证：

```sh
npm run test:agent-templates:e2e -- --serve
```

默认应用地址为 `http://127.0.0.1:3901`。脚本打印测试账号与报告路径，并在独立临时目录中创建测试数据。可使用 `AGENT_TEMPLATE_E2E_PORT`、`AGENT_TEMPLATE_E2E_ROOT`、`AGENT_TEMPLATE_E2E_REPORT` 指定端口和结果位置；CLI 不在默认路径时设置 `CLAUDE_CLI_PATH`。

此次结果确认应用配置和实际执行链路；真实业务 Skill Market/MCP 服务的网络、凭证和返回内容，以及真实模型自主选择工具的表现，未作为本次本地固定响应测试的验收对象。
