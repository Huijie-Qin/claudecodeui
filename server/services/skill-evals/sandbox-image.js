import path from 'node:path';

import { findAppRoot, getModuleDir } from '../../utils/runtime-paths.js';

import { fail } from './contracts.js';

export const DEFAULT_SANDBOX_IMAGE = 'cloudcli-skill-eval:local';

export function createSandboxImageManager({ docker, image, autoBuild, command }) {
  let pending = null;
  const unavailable = (message) => fail(message, 'EVAL_RUNTIME_UNAVAILABLE', 503);
  async function inspect() {
    const { stdout } = await command(docker, ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 10000, maxBuffer: 4096 });
    if (!stdout.trim()) throw unavailable('无法读取测评镜像，请检查 SKILL_EVAL_IMAGE。');
    return stdout.trim();
  }
  async function prepare() {
    if (!image) throw unavailable('请在 .env 中配置 SKILL_EVAL_IMAGE。');
    try { await command(docker, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000, maxBuffer: 4096 }); }
    catch { throw unavailable('无法连接 Docker，请确认 Docker 已运行，且后端运行用户有访问权限。可通过 DOCKER_CLI_PATH 指定 Docker 路径。'); }
    try { return await inspect(); }
    catch (error) {
      if (!/No such (?:image|object)/i.test(String(error.stderr || error.message))) {
        throw unavailable('无法检查测评镜像，请确认 Docker 访问权限和 SKILL_EVAL_IMAGE 配置。');
      }
      if (!autoBuild) throw unavailable('测评镜像尚未安装。请在 .env 设置 SKILL_EVAL_AUTO_BUILD=true 并重启后端，自动构建测评环境。');
    }
    const context = path.join(findAppRoot(getModuleDir(import.meta.url)), 'examples/skill-evaluations');
    console.info('[skill-evals] 正在自动构建测评镜像，首次构建可能需要几分钟。');
    try {
      await command(docker, ['build', '--tag', image, '--file', path.join(context, 'Dockerfile'), context], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
      const id = await inspect();
      console.info('[skill-evals] 测评镜像已就绪。');
      return id;
    } catch { throw unavailable('测评镜像自动构建失败。请检查服务器能否访问镜像仓库和软件源，以及部署目录中的 examples/skill-evaluations/Dockerfile 是否完整。'); }
  }
  return {
    get preparing() { return pending !== null; },
    ensure() {
      if (!pending) pending = prepare().finally(() => { pending = null; });
      return pending;
    },
  };
}
