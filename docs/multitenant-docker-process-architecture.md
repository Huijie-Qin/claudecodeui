# 多租户 Docker Claude Code 进程架构图

Last updated: 2026-04-28

这份图聚焦当前设计中的三个关系：

- 宿主机上一个 CloudCLI / Claude Code UI 后端进程，与多个 Docker Claude Code runtime 的 1 对多关系。
- 多租户维度下 tenant、user、workspace、session runtime 的隔离边界。
- 宿主机目录与容器内 `/workspace`、`/home/cloudcli` 的 bind mount 映射关系。

## 进程与多租隔离架构

```mermaid
flowchart TB
  Browser["Browser UI<br/>http://localhost:5173"]

  subgraph Host["Host Machine"]
    direction TB

    App["One CloudCLI Host Process<br/>Node server + WebSocket + Claude Agent SDK<br/>npm run dev / deployed backend"]
    DB["CloudCLI DB<br/>tenants / users / workspaces / sessions / runtime binding"]

    subgraph HostControl["Host Runtime Control Plane"]
      direction LR
      RuntimeMgr["agent-session-runtime<br/>create or resolve runtime"]
      WrapperA["wrapper A<br/>claude-docker-wrapper"]
      WrapperB["wrapper B<br/>claude-docker-wrapper"]
      WrapperC["wrapper C<br/>claude-docker-wrapper"]
    end

    subgraph HostTenantA["Tenant A Host Storage"]
      direction TB
      AWorkspace["~/.cloudcli/workspaces/tenant-A/user-1/workspace-X"]
      ARuntime1["~/.cloudcli/runtimes/claude/tenant-A/user-1/workspace-X/runtime-1"]
      ARuntime2["~/.cloudcli/runtimes/claude/tenant-A/user-1/workspace-X/runtime-2"]
    end

    subgraph HostTenantB["Tenant B Host Storage"]
      direction TB
      BWorkspace["~/.cloudcli/workspaces/tenant-B/user-7/workspace-Y"]
      BRuntime1["~/.cloudcli/runtimes/claude/tenant-B/user-7/workspace-Y/runtime-3"]
    end
  end

  subgraph Docker["Docker Runtime Boundary"]
    direction TB

    subgraph ContainerA1["Container cc-runtime-1<br/>Tenant A / User 1 / Workspace X / Session 1"]
      direction TB
      A1CLI["Claude Code CLI process"]
      A1Workspace["/workspace"]
      A1Home["/home/cloudcli"]
    end

    subgraph ContainerA2["Container cc-runtime-2<br/>Tenant A / User 1 / Workspace X / Session 2"]
      direction TB
      A2CLI["Claude Code CLI process"]
      A2Workspace["/workspace"]
      A2Home["/home/cloudcli"]
    end

    subgraph ContainerB1["Container cc-runtime-3<br/>Tenant B / User 7 / Workspace Y / Session 3"]
      direction TB
      B1CLI["Claude Code CLI process"]
      B1Workspace["/workspace"]
      B1Home["/home/cloudcli"]
    end
  end

  Browser -->|"WebSocket / HTTP"| App
  App --> DB
  App -->|"prepareClaudeRuntime(options)"| RuntimeMgr
  RuntimeMgr --> WrapperA
  RuntimeMgr --> WrapperB
  RuntimeMgr --> WrapperC

  App -->|"SDK spawn(pathToClaudeCodeExecutable)<br/>stream-json stdio"| WrapperA
  App -->|"SDK spawn(pathToClaudeCodeExecutable)<br/>stream-json stdio"| WrapperB
  App -->|"SDK spawn(pathToClaudeCodeExecutable)<br/>stream-json stdio"| WrapperC

  WrapperA -->|"docker exec -i -w /workspace<br/>-e HOME=/home/cloudcli claude &quot;$@&quot;"| A1CLI
  WrapperB -->|"docker exec -i -w /workspace<br/>-e HOME=/home/cloudcli claude &quot;$@&quot;"| A2CLI
  WrapperC -->|"docker exec -i -w /workspace<br/>-e HOME=/home/cloudcli claude &quot;$@&quot;"| B1CLI

  AWorkspace -. "bind mount" .-> A1Workspace
  ARuntime1 -. "bind mount home/" .-> A1Home
  AWorkspace -. "bind mount" .-> A2Workspace
  ARuntime2 -. "bind mount home/" .-> A2Home
  BWorkspace -. "bind mount" .-> B1Workspace
  BRuntime1 -. "bind mount home/" .-> B1Home

  A1CLI --> A1Workspace
  A1CLI --> A1Home
  A2CLI --> A2Workspace
  A2CLI --> A2Home
  B1CLI --> B1Workspace
  B1CLI --> B1Home
```

## 宿主机目录与容器目录映射

```mermaid
flowchart LR
  subgraph Host["Host Machine"]
    direction TB
    HostWorkspace["Workspace root<br/>~/.cloudcli/workspaces/&lt;tenant&gt;/&lt;user&gt;/&lt;workspace&gt;"]
    HostRuntime["Runtime root<br/>~/.cloudcli/runtimes/claude/&lt;tenant&gt;/&lt;user&gt;/&lt;workspace&gt;/&lt;runtime&gt;"]
    HostHome["Runtime home<br/><runtime>/home"]
    HostWrapper["Wrapper script<br/><runtime>/wrapper/claude-docker-wrapper"]
  end

  subgraph Container["Docker Container"]
    direction TB
    ContainerWorkspace["/workspace<br/>Claude Code cwd"]
    ContainerHome["/home/cloudcli<br/>Claude Code HOME"]
    ContainerClaude["claude process<br/>Claude Code CLI"]
  end

  HostWorkspace == "docker run --mount src=workspace,dst=/workspace" ==> ContainerWorkspace
  HostHome == "docker run --mount src=runtime/home,dst=/home/cloudcli" ==> ContainerHome
  HostWrapper -->|"docker exec -i<br/>-w /workspace<br/>-e HOME=/home/cloudcli<br/>claude &quot;$@&quot;"| ContainerClaude

  ContainerClaude -->|"reads/writes project files"| ContainerWorkspace
  ContainerClaude -->|"reads/writes session state<br/>.claude / config / cache"| ContainerHome
```

## 读图要点

- 宿主机只有一个 CloudCLI 后端进程作为控制平面，但它可以按 session/runtime 维度管理多个 Docker container。
- 每个 Docker container 内有自己的 Claude Code CLI 进程，容器内 cwd 固定为 `/workspace`。
- `pathToClaudeCodeExecutable` 在 Docker 模式下不是宿主机 `claude`，而是当前 runtime 的 wrapper 脚本。
- wrapper 通过 `docker exec -i ... claude "$@"` 把 Claude Agent SDK 生成的参数原样转发给容器内 Claude Code CLI。
- workspace 目录和 runtime home 目录分开挂载：`/workspace` 面向项目文件，`/home/cloudcli` 面向 Claude 会话状态和配置。
- tenant/user/workspace/runtime 维度都体现在宿主机目录层级中，避免不同租户共享宿主机 `~/.claude` 或同一份 runtime home。
- 后续追问时，后端通过 session id 找回同一个 runtime，再由 SDK 传入 `--resume <sessionId>`；容器内 Claude Code CLI 在同一个 `/home/cloudcli` 下恢复上下文。
