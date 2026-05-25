import os from 'os';

const ROOT_USER_HOME = '/root';
const ROOT_USER_WORKSPACES_ROOT = '/workspace';

export function resolveWorkspacesRoot({ env = process.env, homedir = os.homedir() } = {}) {
  const configuredRoot = String(env.WORKSPACES_ROOT || '').trim();
  if (configuredRoot) {
    return configuredRoot;
  }

  const homeDirectory = String(homedir || '').trim();
  if (homeDirectory === ROOT_USER_HOME) {
    return ROOT_USER_WORKSPACES_ROOT;
  }

  return homeDirectory || ROOT_USER_WORKSPACES_ROOT;
}
