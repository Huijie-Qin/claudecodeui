export const DEFAULT_CLAUDE_DOCKER_IMAGE = 'docker.io/cloudcliai/sandbox:claude-code';
export const DOCKER_CLI_PATH_ENV_NAME = 'CLOUDCLI_DOCKER_CLI_PATH';

export function resolveClaudeDockerImage(env = process.env) {
  return String(env.CLOUDCLI_CLAUDE_DOCKER_IMAGE || '').trim() || DEFAULT_CLAUDE_DOCKER_IMAGE;
}

export function resolveDockerCliExecutable(env = process.env) {
  return String(env?.[DOCKER_CLI_PATH_ENV_NAME] || '').trim() || 'docker';
}
