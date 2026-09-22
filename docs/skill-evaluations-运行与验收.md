# 技能测评：运行与验收

2026-09-18。本次实现用例管理、持久任务、逐例执行与独立评审、有限轮自动优化、前后报告与文件对比，以及符合条件的会话保存入口。实现代码已通过自动化与页面夹具验证；开发机现已安装 Node 22、Docker CLI、Buildx 和 Colima，构建测评镜像并通过真实容器隔离检查。前后端类型检查及 Node 22 下 35 项测评测试通过。DeepSeek 的 Anthropic 兼容接口（`deepseek-flash`）已通过真实单例执行、Docker 产物收集及独立结构化评分；完整自动优化流程尚未进行真实模型联调。

## 使用入口与记录生命周期

工作区 → 我的技能 → 技能详情 → 技能测评。可以手工添加/编辑/删除用例、上传测试文件、由 AI 准备测试用例、运行全部或自动优化。只读成员可以查看用例、报告和下载产物。

测试文件是技能完成当前用例时需要读取的输入，例如销售汇总用例的订单 CSV；纯文字任务可以不上传。上传区与上传 Skill 使用一致的虚线拖拽样式，支持一次选择或拖入多个文件，每个文件不超过 5 MB，每条用例最多关联 20 个。文件逐个上传并显示进度，部分上传失败时保留成功文件，可单独重试失败项。新上传文件存储在独立目录并保留经过安全处理的原始文件名。

用例保存在 `evals/evals.json`，附件保存在 `evals/files/`，始终可重复使用。每个工作区技能只保留最新一次运行/优化记录：**新任务受理即替换旧记录**，旧报告立即返回 410，后台清除旧证据与产物；新任务失败、取消也不恢复旧报告。无效请求或运行环境预检失败不会清除旧记录。一次自动优化内部各轮仍可查看；写入工作区的技能修改不会随报告清理而删除。

自动优化默认最多 3 轮，可选 1–10 轮。先前测，再修改并写入，最后全量复测。全部通过则提前结束，取消/退化不会自动回滚。执行中可编辑文件；检测到当前技能或受管理源副本变化时，不覆盖编辑，保留候选与对比，并继续在候选副本上复测。报告明确标出是否对应当前文件。

## 会话式执行过程

点击用例的“查看详情”可打开右侧面板，运行中即可查看。场景和模型输出使用会话消息展示，工具调用默认折叠，子任务按层级展开；评分结果单独展示，点击证据引用可跳转并展开对应过程。文本、Markdown、JSON、CSV 产物支持预览，所有产物可下载。自动优化可切换同一次任务内的初始前测及各轮后测。

消息排版与普通会话共用 `MessagePresentation` 中的用户气泡、消息头部、正文（含 JSON）、复制及时间栏；工具使用共用的 `ToolTraceFrame`、`CollapsibleDisplay`，子任务复用 `SubagentContainer`。测评传入自己的事件与受控展开状态，证据跳转会展开目标所在的各层折叠区域。

面板显示状态、耗时和停止入口，停止会取消整个当前运行。执行事件逐条保存为原子快照，面板在前台每 1.5 秒读取进度，在后台每 10 秒读取；展示按完整消息/工具事件更新，不是逐字流式输出。向上滚动暂停跟随，点击“回到最新”恢复。取消或异常保留已记录过程，重新运行依然按上述规则替换旧记录。测评面板不提供聊天输入。

评分模型的判定理由要求使用简体中文，规则检查及评分格式错误也提供中文说明。JSON 字段名、状态枚举和证据引用 ID 保持原样，代码、文件名及必要的证据引文不翻译。此设置对新生成的评分生效；旧报告保留原文，重新运行后按最新记录规则替换。

会话式面板已通过隔离页面夹具的浏览器验证：运行中查看、工具和子任务展开、证据跳转、滚动跟随、预览/下载、取消、优化轮次切换和手机端只读布局。该组 UI 测试不调用真实模型。

## 运行环境

需要与应用服务在同一主机上的 Docker daemon 和 CLI。此版不支持远程 Docker daemon 的路径映射，也不支持多个应用进程共同修改同一工作区；数据库 worker 租约防止重复领取，但文件协调锁是进程内锁。普通会话/外部编辑器不遵守该锁，写回使用两次摘要检查和恢复日志，不能对任意外部并发写入承诺绝对互斥。

构建隔离镜像（只在部署时联网安装依赖）：

```sh
docker build -t cloudcli-skill-eval:local -f examples/skill-evaluations/Dockerfile examples/skill-evaluations
```

启动应用前配置：

```sh
export SKILL_EVAL_IMAGE=cloudcli-skill-eval:local
export SKILL_EVAL_STORAGE_ROOT=/absolute/path/outside-workspaces/skill-evaluations
export SKILL_EVAL_MAX_COST_USD=10
```

`SKILL_EVAL_STORAGE_ROOT` 默认 `~/.cloudcli/skill-evaluations`，必须在工作区之外；需要应用用户的读写权限。可选 `DOCKER_CLI_PATH` 指定 Docker 路径。模型凭据复用租户/用户的 Claude 环境配置，需要 API key 或 auth token；支持 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`。仅登录桌面 Claude、但没有这些凭据时会提示配置错误。

macOS 可使用独立 Colima profile。应用的 `TMPDIR` 必须以相同路径挂载进虚拟机，否则 Docker 无法读取技能快照。示例：

```sh
mkdir -p "$HOME/.cloudcli/skill-eval-tmp" "$HOME/.cloudcli/skill-evaluations"
colima start skill-eval --cpus 2 --memory 4 --disk 20 \
  --runtime docker --vm-type vz --mount-type virtiofs \
  --mount "$HOME/.cloudcli/skill-eval-tmp:w" \
  --activate=false --ssh-config=false --port-forwarder none
docker --context colima-skill-eval build -t cloudcli-skill-eval:local \
  -f examples/skill-evaluations/Dockerfile examples/skill-evaluations
```

在本地 `.env` 中设置 `DOCKER_CONTEXT=colima-skill-eval`，并将 `TMPDIR` 设置为上述目录的绝对路径（不要写 `$HOME`，环境文件不展开 shell 变量）。此 profile 不切换全局 Docker context；停止和重启分别使用 `colima stop skill-eval`、`colima start skill-eval`。项目 `.env` 已被 Git 忽略，凭据只保存在本地或应用模型设置中。当前测评执行器仍使用 Claude，尚未增加 Codex 登录接入。

本机初始化时已在 `~/.colima/skill-eval/colima.yaml` 修复最小虚拟机镜像的 DNS 断链，并为该 profile 的 Docker daemon 配置现有主机代理。重新构建镜像时，主机 Docker CLI 也需要代理；容器构建期间的代理地址为虚拟机可访问的主机地址。例如本机：

```sh
HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 \
docker --context colima-skill-eval build \
  --build-arg HTTP_PROXY=http://192.168.5.2:7897 \
  --build-arg HTTPS_PROXY=http://192.168.5.2:7897 \
  -t cloudcli-skill-eval:local -f examples/skill-evaluations/Dockerfile examples/skill-evaluations
```

这些代理仅服务于依赖下载和镜像构建；实际测评容器仍使用 `--network=none`。本地应用使用 `npm run server:dev` 启动，在 `http://127.0.0.1:3001` 完成首次账号设置后使用；`5188` 为独立模拟页面夹具。

执行器使用 Claude SDK 的独立模型进程，关闭原生工具、用户/项目设置和插件，通过两个专用工具执行：`shell` 在离线容器中运行，`delegate` 启动同一容器内的一层子任务并等待完成。容器无网络、无模型凭据、非 root、只读根文件系统，仅挂载只读技能快照与指定输入；产物写入 50 MiB tmpfs，再由受信采集器读取。镜像需有 `sh`、`sleep`、`/usr/bin/python3`；额外依赖应预装进镜像。

模型/评审/优化仍需访问配置的模型服务。模型请求包含技能、用例和所需执行证据；执行容器不访问生产 MCP、业务网络或真实工作区。普通聊天运行环境不会用于降级执行。

资源默认上限：50 条用例、输入单文件 5 MiB、技能总量 50 MiB、每个用例 5 分钟、每条命令 60 秒、每条用例 32 次工具调用、单任务 60 分钟；总报告证据 512 MiB。所有模型调用共用任务预算，单次调用最多 2 美元；预算由 SDK 上报费用约束，实际供应商账单仍以供应商为准，缺少费用数据会停止任务。AI 生成用例预算为 2 美元。

## 判定与当前支持范围

独立评审能读取文本、Markdown、JSON、CSV 输入和产物，并引用真实消息/文件证据。JSON 格式校验失败不能被语义评审覆盖。PDF、图片、表格等未接内容解析器时返回“无法判定”；网络/MCP 依赖需要先转为输入样本，此版本不伪造工具结果。高于评审上下文限额时不会静默截断后给通过。

会话保存入口仅对**明确 `/技能名 任务` 调用且成功完成**的可复现 Claude 回答显示。仅纯文本上下文及技能内 Read 操作可保存；带图片、外部工具、shell、写文件、子任务、补充消息或 hook 恢复的调用不自动转换。场景与预期来自服务端原始记录，重复保存幂等；依赖旧文本上下文时自动附带上下文文件。历史调用不回填此入口。

新发布/导入市场技能的用例 ID 会登记保护；受保护用例可编辑但不可删除。已有安装的历史技能在下一次受控发布/导入时登记，不猜测此前哪些本地用例属于发布版。通用文件管理器修改技能目录会提示改用“我的技能”编辑器，以保持用例与受管理副本一致。

自动优化不修改用例、答案、附件、技能名和权限配置。优化模型只输出受限制的文件变更，再由服务端验证并写入。页面对比是完整文件前后文本，执行报告可以查看本任务各轮证据；当前未加入逐行高亮 diff 和多模态文件解析。

## 验证方式

```sh
npm run test:skill-evals
npx tsx --test src/components/skills-market/evaluation/types.test.ts
npm run typecheck
npm run build
```

本地页面夹具（不消耗模型额度、不运行 Docker，数据仅在临时目录）：

```sh
node scripts/skill-evaluations-browser-fixture.mjs
# http://127.0.0.1:5188；?readonly 检查只读页面
```

先检查真实容器环境（不调用模型，不消耗模型额度）：

```sh
node scripts/skill-evaluation-sandbox-smoke.mjs
```

此脚本检查容器断网、非 root、只读输入和根文件系统、凭据隔离、Python、产物读取及容器清理。它不代表模型端到端联调成功。

真实集成冒烟（会消耗模型执行及独立评分请求，需先配置镜像和模型环境；两个冒烟脚本均自动读取项目 `.env`）：

```sh
node scripts/skill-evaluation-smoke.mjs
```

冒烟必须实际调用 shell、写出 `check.txt`、完成产物收集，并由独立评分给出通过且引用 `artifact:check.txt` 才通过。开发机已使用 DeepSeek 跑通此检查。脚本输出的 `sdkReportedCostUsd` 是 Claude SDK 估算值，不代表 DeepSeek 的实际账单。

SDK 原生可执行文件直接启动，只有 SDK 指定 Node 启动时才使用当前 Node 路径；两种方式均保留隔离环境，避免将新版原生 CLI 误传给 Node。

任务在数据库中持久化，页面可离开再进入。进程重启后，未完成任务会清理其容器并标记中断，不自动重放工具。文件提交中断会依据日志恢复一致副本；如果检测到外部编辑，保留双方文件并继续锁住该技能的任务，需管理员核查存储目录下任务的 `commit.json` 和记录的备份路径。清理旧报告失败会由 worker 重试。
