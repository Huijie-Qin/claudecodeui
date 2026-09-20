import { readFile, writeFile } from 'node:fs/promises';

const code = await readFile(new URL('./hook.py', import.meta.url), 'utf8');
export const config = {
  name: 'Python MCP 调用前参数确认',
  description: '每次 MCP 工具调用前记录并展示参数，强制等待用户确认；取消或无法确认时不执行。',
  eventName: 'PreToolUse',
  matcher: { mode: 'regex', value: '^mcp__.*' },
  includeSubagents: true,
  userVariables: [],
  extensionLogic: {
    language: 'python',
    code,
    failClosed: true,
    outputs: [
      { name: 'permissionDecision', type: 'string' },
      { name: 'permissionDecisionReason', type: 'string' },
      { name: 'matched', type: 'boolean' },
      { name: 'toolName', type: 'string' },
      { name: 'toolInput', type: 'object' },
    ],
  },
  postActions: [],
  claudeResponse: {
    bindings: {
      'hookSpecificOutput.permissionDecision': {
        source: 'reference', path: 'script.output.permissionDecision',
      },
      'hookSpecificOutput.permissionDecisionReason': {
        source: 'reference', path: 'script.output.permissionDecisionReason',
      },
    },
  },
};

const json = JSON.stringify(config, null, 2);
await writeFile(new URL('./hook.json', import.meta.url), `${json}\n`);
await writeFile(new URL('./MCP调用前参数确认Hook配置.txt', import.meta.url), `MCP 调用前参数确认 Hook

作用：每次 Claude MCP 工具调用前，记录参数并在 CCUI 权限界面展示完整 JSON，等待用户选择“确定执行”或“取消调用”。每次调用单独确认，不记住上一次授权；无需在用户 query 中要求确认。

配置：PreToolUse；正则匹配 ^mcp__.*；包含子代理；Python；无用户变量、无后置行为；异常拒绝调用（extensionLogic.failClosed=true）。这里使用的是工具调用前的异常拒绝策略，与 Stop 结束验收开关无关。

脚本输出变量（名称区分大小写，类型必须逐项一致）：
permissionDecision       string
permissionDecisionReason string
matched                  boolean
toolName                 string
toolInput                object

只有 matched 是 boolean。toolInput 返回工具参数字典，必须选 object，不能选 boolean；名称中的 I 为大写。
若出现“Script output toolInput must be boolean”（或 toolinput），请修正该输出声明及脚本字段名，保存并重新发布；同时确认目标工作空间加载的是修正后的版本，再开始新的执行回合。

启用步骤：
1. 部署包含本次 MCP 确认处理和重新发布版本同步修复的前后端并重启后端。旧服务可能自动允许非交互式工具，不能只导入配置后就认为强制确认已生效。
2. 管理页创建 Hook：按以下 JSON 字段配置，将 Python 脚本粘贴到高级脚本编辑器。也可将完整 JSON 作为 POST /api/admin/hooks 的请求体。
3. 保存并发布，绑定目标用户/租户，再在目标工作空间启用。需要强制执行时，分配为默认启用且不允许用户关闭。
4. 开始新的执行回合以加载配置。MCP 调用时先核对工具名称和展开的 JSON 参数，再选择确认或取消。
5. 修改后重新发布会更新普通工作空间使用的版本；Agent 模板明确固定的版本保持不变。旧服务曾出现“重新发布但工作空间仍用旧版本”的问题，升级重启后需再发布一次修正旧引用。已运行的回合仍使用启动时配置。

说明：当前文件只是可发布配置，未自动绑定或启用任何现有账号/工作空间。Python 无需 imports 或 input()；ccui.log.info 负责结构化参数日志，permissionDecision=ask 交给权限界面等待用户。日志和审计沿用运行层敏感字段脱敏，不能把脱敏日志视为完整参数副本。主代理和当前 SDK 的后台子代理确认路径均已通过本地测试；无法取得用户确认的执行环境须拒绝调用，不能静默放行。此 Hook 只覆盖 Claude 的 mcp__ 工具调用，不覆盖终端直连 MCP、Hook 后置行为或调度基础设施中的服务端 MCP 调用。

完整 JSON 配置：
${json}

独立 Python 脚本：
${code}
修改脚本后重新生成：node examples/python-mcp-confirm/build-config.mjs
详细说明：docs/python-mcp-confirm-hook.md
`);
