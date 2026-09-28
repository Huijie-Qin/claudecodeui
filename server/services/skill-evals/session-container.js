import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { buildClaudeDockerGuestEnv, buildClaudeDockerExecArgs, buildDockerRunArgs, buildWrapperHostEnv, createClaudeDockerSpawn, ensureRuntimeHomeWritable, resolveDockerSharedPythonPath, resolveDockerBindSourcePath } from '../agent-session-runtime.js';
import { resolveContainerUser } from '../container-user.js';
import { prepareClaudeDockerCa } from '../claude-docker-ca.js';
import { applyWorkspaceMcpHelperScripts } from '../mcp-helper-scripts.js';
import { resolveUserWorkspaceMcpToolAccess } from '../mcp-tool-access.js';

import { fail, redact } from './contracts.js';

export const NATIVE_CASE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite'];

export async function readEvaluationMcpConfig(workspacePath) {
  if (!workspacePath) return {};
  let handle;
  try {
    handle = await fs.open(path.join(workspacePath, '.mcp.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid file');
    const contents = await handle.readFile('utf8');
    if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error('File too large');
    const config = JSON.parse(contents);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid config');
    const servers = config.mcpServers ?? {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)
      || Object.values(servers).some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid servers');
    return servers;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw fail('无法读取 workspace 的 .mcp.json，请检查 JSON 格式、文件大小和读取权限（不支持符号链接）。', 'EVAL_MCP_CONFIG_INVALID');
  } finally { await handle?.close(); }
}

function secretValues(configs, environment) {
  return [...new Set([
    ...Object.entries(environment).filter(([key]) => /key|token|secret|password|authorization/i.test(key)).map(([, value]) => value),
    ...Object.values(configs).flatMap(config => [...Object.values(config.env || {}), ...Object.values(config.headers || {}), ...Object.values(config.helperEnv || {})]),
  ].filter(value => typeof value === 'string' && value.length >= 4))].sort((a, b) => b.length - a.length);
}

export async function prepareEvaluationSession({ scope, temp, projection, id, image, sharedImage = image, docker, env, auth,
  resolvedEnvironment, spawnImpl, applyHelpers = applyWorkspaceMcpHelperScripts, resolveAccess = resolveUserWorkspaceMcpToolAccess }) {
  const workspace = path.join(temp, 'workspace'), home = path.join(temp, 'home');
  const owner = resolveContainerUser(env);
  await ensureRuntimeHomeWritable(fs, workspace, owner);
  await ensureRuntimeHomeWritable(fs, home, owner);
  await fs.chmod(temp, 0o700);
  const rawServers = await readEvaluationMcpConfig(scope.workspacePath);
  const mcpServers = scope.tenantId && scope.workspaceId
    ? await applyHelpers(rawServers, { tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      runtimeMode: 'docker', runtimeHomePath: home, runtimeOwner: owner }) : rawServers;
  await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify({ mcpServers }), { mode: 0o600 });
  await fs.chown(path.join(workspace, '.mcp.json'), owner.uid, owner.gid).catch(() => {});
  // The private parent temp directory prevents other host users reading this fallback.
  await fs.chmod(path.join(workspace, '.mcp.json'), 0o644);
  const guestEnv = { ...(resolvedEnvironment ? buildClaudeDockerGuestEnv(resolvedEnvironment) : auth) };
  const ca = await prepareClaudeDockerCa({ runtimeHomePath: home, env, containerEnv: guestEnv });
  Object.assign(guestEnv, ca.env);
  const executionEnv = { ...buildWrapperHostEnv(env, guestEnv), HOME: '/home/cloudcli', TMPDIR: '/tmp',
    CLAUDE_CONFIG_DIR: '/home/cloudcli/.claude', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  let sharedPythonHostPath = resolveDockerSharedPythonPath(env, sharedImage);
  if (sharedPythonHostPath) {
    try { await fs.access(sharedPythonHostPath); } catch { sharedPythonHostPath = null; }
  }
  const args = buildDockerRunArgs({ containerName: id, image, uid: owner.uid, gid: owner.gid,
    workspaceHostPath: workspace, runtimeHomePath: home, sharedPythonHostPath,
    memory: env.CLOUDCLI_DOCKER_MEMORY || '2g', cpus: env.CLOUDCLI_DOCKER_CPUS || '2',
    bindHostRoot: env.CLOUDCLI_DOCKER_BIND_HOST_ROOT, bindContainerRoot: env.CLOUDCLI_DOCKER_BIND_CONTAINER_ROOT });
  // Installed workspace Python dependencies can be read without modifying the shared environment.
  const sharedIndex = args.findIndex(value => value.endsWith('dst=/opt/cloudcli/python'));
  if (sharedIndex >= 0) args[sharedIndex] += ',readonly';
  const source = resolveDockerBindSourcePath(projection, { hostRoot: env.CLOUDCLI_DOCKER_BIND_HOST_ROOT, containerRoot: env.CLOUDCLI_DOCKER_BIND_CONTAINER_ROOT });
  args.splice(args.length - 3, 0, '--pull=never', '--label', 'cloudcli.skill-eval=true',
    ...(scope.id ? ['--label', `cloudcli.eval-job=${scope.id}`] : []),
    '--mount', `type=bind,src=${source},dst=/skill,readonly`,
    '--tmpfs=/output:rw,nosuid,nodev,size=50m,mode=1777');
  const secrets = secretValues(rawServers, { ...guestEnv, ...Object.fromEntries((resolvedEnvironment?.secretEnvValues || []).map((value, index) => [`secret_${index}`, value])) });
  return {
    args, workspace, home, mcpServers, env: executionEnv,
    shellArgs: script => buildClaudeDockerExecArgs({ containerName: id, executable: 'sh', args: ['-lc', script],
      env: executionEnv, envAllowlist: Object.keys(executionEnv).filter(name => name !== 'PATH') }),
    brokerName: ['evaluation', 'evaluation_runtime', `evaluation_${id.replaceAll('-', '_')}`].find(name => !Object.hasOwn(mcpServers, name)),
    access: resolveAccess(scope),
    sanitize: text => secrets.reduce((value, secret) => value.split(secret).join('[REDACTED]'), redact(text)),
    spawn: createClaudeDockerSpawn({ containerName: id, envAllowlist: Object.keys(executionEnv).filter(name => name !== 'PATH'),
      spawnImpl, hostEnv: { ...env, CLOUDCLI_DOCKER_CLI_PATH: docker } }),
  };
}
