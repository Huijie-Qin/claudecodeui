import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';

export interface DesktopRuntimePaths {
  runtimeRoot: string;
  backendEntry: string;
  claudeCli: string;
  nodeExecutable: string;
  npmCli: string;
}

export function resolveDesktopRuntimeRoot(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'runtime')
    : join(options.appPath, '.runtime');
}

export function resolveBundledClaudeCliPath(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`Unsupported desktop platform: ${platform}.`);
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported desktop architecture: ${arch}.`);
  }
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error(`Unsupported Windows desktop architecture: ${arch}.`);
  }

  return join(
    runtimeRoot,
    'claude',
    `${platform}-${arch}`,
    platform === 'win32' ? 'claude.exe' : 'claude',
  );
}

export function resolveBundledNodeExecutablePath(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`Unsupported desktop platform: ${platform}.`);
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported desktop architecture: ${arch}.`);
  }
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error(`Unsupported Windows desktop architecture: ${arch}.`);
  }

  return join(
    runtimeRoot,
    'node',
    `${platform}-${arch}`,
    platform === 'win32' ? 'node.exe' : 'node',
  );
}

export function resolveBundledNpmCliPath(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const nodeExecutable = resolveBundledNodeExecutablePath(runtimeRoot, platform, arch);
  return join(dirname(nodeExecutable), 'npm', 'bin', 'npm-cli.js');
}

export function resolveBundledNodeToolchainBinPath(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return join(dirname(resolveBundledNodeExecutablePath(runtimeRoot, platform, arch)), 'bin');
}

export function resolveDesktopRuntimePaths(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): DesktopRuntimePaths {
  const runtimeRoot = resolveDesktopRuntimeRoot(options);
  return {
    runtimeRoot,
    backendEntry: join(runtimeRoot, 'dist-server', 'server', 'index.js'),
    claudeCli: resolveBundledClaudeCliPath(
      runtimeRoot,
      options.platform,
      options.arch,
    ),
    nodeExecutable: resolveBundledNodeExecutablePath(
      runtimeRoot,
      options.platform,
      options.arch,
    ),
    npmCli: resolveBundledNpmCliPath(
      runtimeRoot,
      options.platform,
      options.arch,
    ),
  };
}

export function createDesktopBackendEnvironment(
  paths: DesktopRuntimePaths,
  port: number,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const pathDirectories = [...new Set([
    join(dirname(paths.nodeExecutable), 'bin'),
    dirname(paths.nodeExecutable),
    dirname(paths.claudeCli),
  ])];
  const inheritedPath = baseEnvironment.PATH || baseEnvironment.Path || '';
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    CLOUDCLI_BACKEND_ENTRY: paths.backendEntry,
    CLOUDCLI_DESKTOP_MODE: 'true',
    CLOUDCLI_NODE_EXECUTABLE: paths.nodeExecutable,
    CLOUDCLI_NPM_CLI_PATH: paths.npmCli,
    CLAUDE_EXECUTION_MODE: 'local',
    CLAUDE_CLI_PATH: paths.claudeCli,
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: '1740000',
    HOST: '127.0.0.1',
    SERVER_PORT: String(port),
  };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'path') {
      delete environment[key];
    }
  }
  environment.PATH = inheritedPath
    ? `${pathDirectories.join(delimiter)}${delimiter}${inheritedPath}`
    : pathDirectories.join(delimiter);
  return environment;
}

export function assertDesktopRuntimeExists(paths: DesktopRuntimePaths): void {
  if (!existsSync(paths.backendEntry)) {
    throw new Error(`Bundled backend entry was not found: ${paths.backendEntry}`);
  }
  if (!existsSync(paths.claudeCli)) {
    throw new Error(`Bundled Claude CLI was not found: ${paths.claudeCli}`);
  }
  if (!existsSync(paths.nodeExecutable)) {
    throw new Error(`Bundled standalone Node runtime was not found: ${paths.nodeExecutable}`);
  }
  if (!existsSync(paths.npmCli)) {
    throw new Error(`Bundled npm CLI was not found: ${paths.npmCli}`);
  }
  const toolchainBin = join(dirname(paths.nodeExecutable), 'bin');
  const windowsRuntime = basename(paths.nodeExecutable).toLowerCase() === 'node.exe';
  for (const toolName of ['npm', 'npx']) {
    const shim = join(toolchainBin, windowsRuntime ? `${toolName}.cmd` : toolName);
    if (!existsSync(shim)) {
      throw new Error(`Bundled ${toolName} shim was not found: ${shim}`);
    }
  }
}
