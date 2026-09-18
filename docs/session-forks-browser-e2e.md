# 分支聊天页面端到端验收

2026-09-18，通过浏览器实际操作验收普通聊天和 DataAgent 两个入口。最终页面无控制台错误，分支相关接口正常；新增回归后的 `npm run test:session-fork` 共 147 项通过。

## 测试范围

使用当前真实 App、分支路由与服务、历史 provider、SQLite 和 Claude SDK。运行数据全部位于独立临时目录；登录、非核心配置接口、WebSocket 适配器属于测试夹具，模型响应由本地模拟服务提供。SDK 真正发送的消息体用于校验继承上下文，不以模拟模型返回的文字作为唯一证据。未连接真实账号或外部模型。

原聊天预置两轮：先要求记住蓝色并读取文件，随后改为红色。从第一条已完成助手回复分支，期望只继承蓝色问答和 Read 调用/结果。

| 页面场景 | 结果 |
| --- | --- |
| 普通聊天从较早回复创建分支 | 新 URL、标题和侧栏立即出现，历史仅到选中回复 |
| DataAgent 创建分支 | 保持 `/data-agent/session/…` 路由，新会话立即登记 |
| 分支刷新 | 来源入口、继承问答和工具记录保留 |
| 页面输入后续问题 | 实际 SDK resume 成功，新问答写入新会话，刷新后仍在 |
| 核验实际模型请求 | 包含蓝色问答、工具调用/结果和新问题，不含后续红色问答 |
| 点击“查看原聊天” | 原聊天两轮完整，未混入分支续聊内容；原 JSONL SHA-256 不变 |
| 运行中与未完成回复 | 运行中分支按钮禁用；中断回复的分支按钮数量为 0 |
| 旧会话列表推送后分支 | 复现缺陷并修复，两套界面复测通过 |
| 最终干净环境 | 控制台 error 为 0，API 失败请求为 0，Claude 图标正常 |

## 本次修复

`useProjectsState` 和 `DataAgentApp` 的 effect 会随本地列表、选中会话或路由变化再次运行，重复应用同一个旧 `projects_updated` 对象。普通聊天因此在新 URL 上显示“新会话”空状态；DataAgent 的侧栏也可能丢失新会话。

新增 `createProjectUpdateTracker`，先验证租户作用域，再保证每个推送对象只消费一次。列表替换和历史刷新均在此检查之后执行，新收到的合法推送仍正常处理。已补回归用例，并加入分支专项测试入口。

## 复现入口与证据

```sh
TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx scripts/session-fork-browser-fixture.mjs
```

默认监听 `127.0.0.1:4417`，终端输出本轮原聊天、DataAgent、未完成回复和证据 URL。测试账号为 `fork-browser`，密码为 `fixture-only`。退出进程会清理本轮临时数据；重启会创建新的会话 UUID。

在原聊天加载完毕后，可用测试控制接口广播一次列表，然后从蓝色回复点击“分支到新聊天”，验证旧事件不会覆盖新分支：

```sh
curl -X POST http://127.0.0.1:4417/__fork-test__/broadcast-projects
```

- [首次复现及修复后两入口的证据](../artifacts/session-fork-e2e/evidence.json)：3 次分支、2 次 SDK 续聊、原历史哈希。
- [最终干净环境证据](../artifacts/session-fork-e2e/final-evidence.json)：1 次分支、1 次 SDK 续聊、上下文检查、原历史哈希、无失败接口和控制台错误。

本地夹具单独保留 SQLite statements，避开已记录的 Node 24/native addon GC 异常；未修改生产数据库驱动或应用启动配置。
