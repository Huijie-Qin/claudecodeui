import path from 'node:path';

function desktopToolchainError(variable) {
  const error = new Error(`The bundled desktop plugin toolchain is missing ${variable}.`);
  error.code = 'DESKTOP_PLUGIN_TOOLCHAIN_MISSING';
  return error;
}

function requireDesktopPath(environment, variable) {
  const value = environment[variable];
  if (
    typeof value !== 'string'
    || !value.trim()
    || (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))
  ) {
    throw desktopToolchainError(variable);
  }
  return value;
}

function isDesktopEnvironment(environment) {
  return environment.CLOUDCLI_DESKTOP_MODE === 'true';
}

const DESKTOP_PLUGIN_ENVIRONMENT_KEYS = new Set([
  'all_proxy',
  'appdata',
  'ci',
  'colorterm',
  'comspec',
  'force_color',
  'home',
  'http_proxy',
  'https_proxy',
  'lang',
  'lc_all',
  'localappdata',
  'node_extra_ca_certs',
  'no_proxy',
  'number_of_processors',
  'path',
  'pathext',
  'processor_architecture',
  'shell',
  'ssl_cert_dir',
  'ssl_cert_file',
  'systemroot',
  'temp',
  'term',
  'tmp',
  'tmpdir',
  'tz',
  'userprofile',
  'windir',
]);

export function createPluginToolEnvironment(sourceEnvironment = process.env, {
  includeNpmConfiguration = false,
} = {}) {
  if (!isDesktopEnvironment(sourceEnvironment)) {
    return { ...sourceEnvironment };
  }

  const restricted = {};
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    const normalized = key.toLowerCase();
    if (
      DESKTOP_PLUGIN_ENVIRONMENT_KEYS.has(normalized)
      || (includeNpmConfiguration && (
        normalized.startsWith('npm_config_')
        || normalized === 'npm_token'
      ))
    ) {
      restricted[key] = value;
    }
  }
  return restricted;
}

export function createNodeSpawnSpec(args, {
  runtimeEnvironment = process.env,
  environment = runtimeEnvironment,
} = {}) {
  const desktop = isDesktopEnvironment(runtimeEnvironment);
  const command = desktop
    ? requireDesktopPath(runtimeEnvironment, 'CLOUDCLI_NODE_EXECUTABLE')
    : process.execPath;
  return {
    command,
    args: [...args],
    environment: { ...environment },
  };
}

export function createNpmSpawnSpec(args, {
  runtimeEnvironment = process.env,
  environment = runtimeEnvironment,
  platform = process.platform,
} = {}) {
  const desktop = isDesktopEnvironment(runtimeEnvironment);
  if (!desktop) {
    return {
      command: platform === 'win32' ? 'npm.cmd' : 'npm',
      args: [...args],
      environment: { ...environment },
    };
  }

  const command = requireDesktopPath(runtimeEnvironment, 'CLOUDCLI_NODE_EXECUTABLE');
  const npmCli = requireDesktopPath(runtimeEnvironment, 'CLOUDCLI_NPM_CLI_PATH');
  return {
    command,
    args: [npmCli, ...args],
    environment: { ...environment },
  };
}

export function createNpxSpawnSpec(args, {
  runtimeEnvironment = process.env,
  environment = runtimeEnvironment,
  platform = process.platform,
} = {}) {
  const desktop = isDesktopEnvironment(runtimeEnvironment);
  if (!desktop) {
    return {
      command: platform === 'win32' ? 'npx.cmd' : 'npx',
      args: [...args],
      environment: { ...environment },
    };
  }

  const command = requireDesktopPath(runtimeEnvironment, 'CLOUDCLI_NODE_EXECUTABLE');
  const npmCli = requireDesktopPath(runtimeEnvironment, 'CLOUDCLI_NPM_CLI_PATH');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const npxCli = pathApi.join(pathApi.dirname(npmCli), 'npx-cli.js');
  return {
    command,
    args: [npxCli, ...args],
    environment: { ...environment },
  };
}
