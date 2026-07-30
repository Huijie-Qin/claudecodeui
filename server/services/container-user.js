function currentUid(processImpl = process) {
  return typeof processImpl.getuid === 'function' ? processImpl.getuid() : 1000;
}

function currentGid(processImpl = process) {
  return typeof processImpl.getgid === 'function' ? processImpl.getgid() : 1000;
}

function parseContainerId(value, fallback, name) {
  const normalized = value === undefined || value === null || String(value).trim() === ''
    ? String(fallback)
    : String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > 0xfffffffe) {
    throw new Error(`${name} must be a valid POSIX user or group id`);
  }
  return parsed;
}

export function resolveContainerUser(env = process.env, processImpl = process) {
  const defaultUid = currentUid(processImpl);
  const defaultGid = currentGid(processImpl);
  return {
    uid: parseContainerId(
      env.CLOUDCLI_DOCKER_UID,
      defaultUid > 0 ? defaultUid : 1000,
      'CLOUDCLI_DOCKER_UID',
    ),
    gid: parseContainerId(
      env.CLOUDCLI_DOCKER_GID,
      defaultGid > 0 ? defaultGid : 1000,
      'CLOUDCLI_DOCKER_GID',
    ),
  };
}

export function usesDockerAgentRuntime(env = process.env) {
  return String(env.CLAUDE_EXECUTION_MODE || 'local').trim().toLowerCase() === 'docker';
}
