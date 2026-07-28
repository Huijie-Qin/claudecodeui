# 本地启动 CloudCLI / Claude Code UI 项目

这份文档用于从零在本机启动当前源码项目。默认走开发模式：后端 Express/WebSocket 服务运行在 `SERVER_PORT=3001`，前端 Vite 开发服务运行在 `VITE_PORT=5173`，浏览器访问 `http://localhost:5173`。

## 1. 准备本机环境

### 1.1 安装 Git

如果还没有 Git，先安装 Git。安装后确认命令可用：

```bash
git --version
```

如果命令不存在，说明 Git 没有安装好，或者没有加入 `PATH`。

### 1.2 安装 Node.js 22+

项目 README 明确要求 Node.js v22+。推荐使用 nvm 安装和切换版本：

```bash
nvm install 22
nvm use 22
node --version
npm --version
```

期望 `node --version` 显示 `v22.x` 或更高版本。当前项目依赖里包含原生模块，例如 `node-pty` 和 `better-sqlite3`，Node 版本过低时很容易在 `npm install` 或运行时出问题。

如果你不用 nvm，也可以从 Node.js 官方安装包安装 Node 22+。安装后同样运行 `node --version` 和 `npm --version` 检查。

### 1.3 安装系统编译工具

macOS 上建议安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

这样 `npm install` 遇到需要编译的原生依赖时会更稳。

## 2. 获取项目源码

如果你还没有代码仓库：

```bash
mkdir -p ~/project
cd ~/project
git clone https://github.com/siteboon/claudecodeui.git claude-code-ui
cd claude-code-ui
```

如果你已经在项目目录里，只需要进入项目根目录：

```bash
cd /Users/huijieqin/project/claude-code-ui
```

确认当前目录是项目根目录：

```bash
pwd
ls package.json server src
```

## 3. 安装依赖

在项目根目录执行：

```bash
npm install
```

这个步骤会做几件事：

- 下载前端依赖，例如 React、Vite、Tailwind、CodeMirror。
- 下载后端依赖，例如 Express、WebSocket、better-sqlite3、node-pty。
- 执行 `postinstall` 脚本 `node scripts/fix-node-pty.js`，用于修正终端相关依赖。

安装完成后可以确认关键依赖已存在：

```bash
test -d node_modules && echo "node_modules OK"
```

## 4. 配置 `.env`

项目启动时会读取项目根目录下的 `.env`。如果没有 `.env`，后端也能启动，但端口、数据库、Provider 等配置会使用默认值。

推荐先复制示例文件：

```bash
cp .env.example .env
```

`.env` 已在 `.gitignore` 中，不要提交真实密钥。

### 4.1 基础端口配置

默认配置：

```bash
SERVER_PORT=3001
VITE_PORT=5173
HOST=0.0.0.0
```

含义：

- `SERVER_PORT`: 后端 Express API 和 WebSocket 服务端口。
- `VITE_PORT`: 前端开发服务器端口。
- `HOST=0.0.0.0`: 允许局域网访问；如果只允许本机访问，可以改成 `127.0.0.1`。

开发模式下浏览器通常打开：

```text
http://localhost:5173
```

前端会把 `/api`、`/ws`、`/shell` 代理到后端 `SERVER_PORT`。

### 4.2 数据库位置

如果不配置 `DATABASE_PATH`，后端会默认使用：

```text
~/.cloudcli/auth.db
```

如果你想让当前源码项目使用独立数据库，可以在 `.env` 中添加：

```bash
DATABASE_PATH=./data/auth.db
```

后端会自动创建数据库所在目录。项目 `.gitignore` 已忽略 `*.db`，但仍建议不要把本地数据库提交到仓库。

### 4.3 Claude Code CLI 路径

如果你的机器上已经能直接运行：

```bash
claude --version
```

通常不需要配置 `CLAUDE_CLI_PATH`。

如果 `claude` 不在 `PATH`，可以在 `.env` 中指定：

```bash
CLAUDE_CLI_PATH=/path/to/claude
```

当前后端在本地执行模式下会使用 `CLAUDE_CLI_PATH || 'claude'` 来找到 Claude Code CLI。

### 4.4 Provider / 模型配置

如果你使用 Anthropic 或兼容 Anthropic 协议的网关，可以在 `.env` 中配置变量名，例如：

```bash
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_BASE_URL=https://your-provider.example.com
ANTHROPIC_MODEL=your-model-name
```

不要把真实 API Key 写入文档或提交到 Git。也可以启动后在 UI 的 Settings / Provider 相关页面里配置。

### 4.5 Docker Claude Runtime 可选配置

如果你要验证当前分支里的 Docker-backed Claude session runtime，可以在 `.env` 中显式开启：

```bash
CLAUDE_EXECUTION_MODE=docker
CLOUDCLI_CLAUDE_DOCKER_IMAGE=docker.io/cloudcliai/sandbox:claude-code
CLOUDCLI_RUNTIME_ROOT=~/.cloudcli/runtimes
CLOUDCLI_DOCKER_SHARED_PYTHON=true
# 可选；默认值为 $CLOUDCLI_RUNTIME_ROOT/.shared/python
CLOUDCLI_DOCKER_PYTHON_SHARED_ROOT=~/.cloudcli/runtimes/.shared/python
```

本地普通开发可以不设置这些变量；默认执行模式是 `local`。开启 Docker 模式前，需要本机 Docker 可用，并且镜像里能运行 `claude`。

Docker 模式默认把所有 runtime 的 Python user site、pip 下载/轮子缓存、uv 缓存和 pipx 环境挂载到同一个宿主机目录。目录先按 Claude Docker 镜像引用分桶，Python 包再按 `pythonX.Y` 存放，因此同一镜像、同一 Python 小版本下安装的包只保存一份。用户的 `/home/cloudcli`、Claude 配置和 workspace 仍然独立。

容器会设置 `PIP_USER=1` 和 `PIP_BREAK_SYSTEM_PACKAGES=1`，因此 Claude 在非 virtualenv 环境中执行普通的 `pip install <package>` 或 `python3 -m pip install <package>` 时，会绕过 Debian/Ubuntu 的 PEP 668 限制并写入共享 user site；共享 `bin` 目录也会加入 `PATH`。显式使用 `--target`、`--prefix`、`--no-user` 或在 virtualenv 内安装属于主动绕过共享策略的行为。共享 user site 是一个全局环境：安装另一个版本或卸载包会影响使用同一镜像的其他 runtime，生产环境建议固定版本，并只允许受信任用户安装依赖。如需恢复原有的每用户存储方式，设置 `CLOUDCLI_DOCKER_SHARED_PYTHON=false`。

如果代理变量使用 `localhost`、`127.0.0.1` 或 `::1`，Docker runtime 会把代理主机改写为 `host.docker.internal`，并添加 `host-gateway` 映射，避免容器把宿主机代理误认为容器自身。

如果 UI 本身也通过 `compose.yml` 在容器中运行，必须在项目根目录的 `.env` 中把 workspace 和 runtime root 都设置为 Docker 宿主机上的绝对路径，例如：

```bash
WORKSPACES_ROOT=/data/workspaces
CLOUDCLI_RUNTIME_ROOT=/data/runtimes
```

在宿主机创建目录，然后检查配置并重新创建 UI 容器：

```bash
sudo install -d -o "$(id -u)" -g "$(id -g)" /data/workspaces /data/runtimes
docker-compose config
docker-compose up -d --force-recreate
```

UI 容器通过宿主机的 `/var/run/docker.sock` 创建 Claude 子容器，因此 Claude 的 workspace 和 runtime bind source 都是由宿主 Docker daemon 解析的。`compose.yml` 会把 `WORKSPACES_ROOT` 和 `CLOUDCLI_RUNTIME_ROOT` 以相同的宿主机和容器路径挂载；不要改成 named volume，也不要只在 UI 容器内部创建这些目录。单独重新构建镜像不会更新 volume 配置，必须重新创建 UI 容器。

`CLOUDCLI_DOCKER_PYTHON_SHARED_ROOT` 默认位于 `CLOUDCLI_RUNTIME_ROOT` 下，因此会被上面的 runtime bind 一并覆盖。如果把它单独改到 `HOME` 和 `CLOUDCLI_RUNTIME_ROOT` 之外，也需要在 Compose 中增加对应的宿主机同路径 bind mount。

## 5. 启动开发模式

在项目根目录执行：

```bash
npm run dev
```

这个命令会同时启动两个进程：

- `npm run server:dev`: 使用 `tsx` 启动后端 `server/index.js`。
- `npm run client`: 启动 Vite 前端开发服务器。

启动成功后，终端会看到类似信息：

```text
CloudCLI Server - Ready
Server URL: http://localhost:3001
To run in development mode with hot-module replacement, go to http://localhost:5173
```

然后打开：

```text
http://localhost:5173
```

## 6. 首次打开页面

第一次打开页面时，通常需要完成初始化：

1. 设置本地管理员或登录密码。
2. 进入 UI 后选择或创建租户。
3. 创建或选择 workspace。
4. 在 Provider 设置中确认 Claude / Codex / Cursor / Gemini 的可用状态。
5. 进入 Chat 页面，选择 Provider 并开始会话。

如果 WebSocket 未连接，先确认：

- 浏览器访问的是 `http://localhost:5173`。
- 后端 `http://localhost:3001` 已启动。
- `.env` 中 `SERVER_PORT` 和 `VITE_PORT` 没有冲突。
- 当前用户已经选择了有效租户。

## 7. 常用开发命令

### 7.1 启动后端

```bash
npm run server:dev
```

只启动后端，适合调试 API、WebSocket、Provider runtime。

### 7.2 启动前端

```bash
npm run client
```

只启动前端，适合后端已经在另一个终端运行时使用。

### 7.3 类型检查

```bash
npm run typecheck
```

这个命令会检查前端和后端 TypeScript 类型。

### 7.4 多租相关测试

```bash
npm run test:multitenancy
```

这个命令会跑多租、workspace access、session ownership、Docker runtime service、消息历史、前端 tenant/session 相关测试。当前分支如果改了多租或 session runtime，优先跑这个。

### 7.5 构建生产包

```bash
npm run build
```

构建完成后会生成：

- `dist/`: 前端静态资源。
- `dist-server/`: 编译后的后端代码。

### 7.6 生产模式启动

```bash
npm run server
```

生产模式默认访问后端端口：

```text
http://localhost:3001
```

## 8. 停止服务

如果使用 `npm run dev`，在终端按：

```text
Ctrl + C
```

`concurrently --kill-others` 会停止前端和后端两个进程。

如果端口仍被占用，可以检查占用进程：

```bash
lsof -i :3001
lsof -i :5173
```

确认是旧进程后再结束它。

## 9. 常见问题

### 9.1 `npm install` 失败

优先检查：

```bash
node --version
npm --version
```

确认 Node 是 v22+。如果原生依赖编译失败，macOS 上确认已经安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

然后重新安装：

```bash
rm -rf node_modules package-lock.json
npm install
```

### 9.2 浏览器打不开 `localhost:5173`

检查前端进程是否启动：

```bash
lsof -i :5173
```

如果没有监听，重新运行：

```bash
npm run client
```

如果端口被占用，可以临时改 `.env`：

```bash
VITE_PORT=5174
```

然后重新启动 `npm run dev`。

### 9.3 API 或 WebSocket 请求失败

检查后端进程是否启动：

```bash
lsof -i :3001
```

检查 `.env` 中前后端端口是否匹配：

```bash
SERVER_PORT=3001
VITE_PORT=5173
```

Vite 会根据 `SERVER_PORT` 把 `/api`、`/ws`、`/shell` 代理到后端。

### 9.4 Claude 显示未安装

先在终端确认：

```bash
claude --version
```

如果命令不存在，安装 Claude Code CLI，或在 `.env` 中设置：

```bash
CLAUDE_CLI_PATH=/path/to/claude
```

修改 `.env` 后需要重启后端。

### 9.5 本地代理影响访问

如果你的 shell 设置了 `http_proxy`、`https_proxy` 或 `all_proxy`，本地请求可能被转到代理。调试 localhost 时可以用：

```bash
curl --noproxy '*' http://localhost:3001
```

这样可以绕过代理验证后端是否真的可访问。

### 9.6 修改 `.env` 后没有生效

`.env` 在后端启动时由 `server/load-env.js` 读取。修改 `.env` 后需要停止并重新运行：

```bash
npm run dev
```

只刷新浏览器不会让后端重新读取 `.env`。

## 10. 推荐的日常启动流程

已有代码和依赖时，日常只需要：

```bash
cd /Users/huijieqin/project/claude-code-ui
nvm use 22
npm install
npm run dev
```

然后打开：

```text
http://localhost:5173
```
