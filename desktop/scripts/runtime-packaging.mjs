import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CLAUDE_TARGETS = Object.freeze([
  Object.freeze({
    key: 'darwin-arm64',
    packageName: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    executableName: 'claude',
  }),
  Object.freeze({
    key: 'darwin-x64',
    packageName: '@anthropic-ai/claude-agent-sdk-darwin-x64',
    executableName: 'claude',
  }),
  Object.freeze({
    key: 'win32-x64',
    packageName: '@anthropic-ai/claude-agent-sdk-win32-x64',
    executableName: 'claude.exe',
  }),
]);

export const NODE_VERSION = '24.18.1';
export const NODE_DIST_BASE_URL = 'https://nodejs.org/dist';
export const NODE_TARGETS = Object.freeze([
  Object.freeze({
    key: 'darwin-arm64',
    archiveName: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    archiveSha256: 'eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941',
    archiveRoot: `node-v${NODE_VERSION}-darwin-arm64`,
    executableName: 'node',
    executablePath: ['bin', 'node'],
    npmPath: ['lib', 'node_modules', 'npm'],
  }),
  Object.freeze({
    key: 'darwin-x64',
    archiveName: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    archiveSha256: '6fb20fceacbb157c2f95825b80df4a454a0f6d81cdcd7bb81eeae9147e0e76ec',
    archiveRoot: `node-v${NODE_VERSION}-darwin-x64`,
    executableName: 'node',
    executablePath: ['bin', 'node'],
    npmPath: ['lib', 'node_modules', 'npm'],
  }),
  Object.freeze({
    key: 'win32-x64',
    archiveName: `node-v${NODE_VERSION}-win-x64.zip`,
    archiveSha256: 'ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765',
    archiveRoot: `node-v${NODE_VERSION}-win-x64`,
    executableName: 'node.exe',
    executablePath: ['node.exe'],
    npmPath: ['node_modules', 'npm'],
  }),
]);

export const RUNTIME_DIRECTORIES = Object.freeze([
  'dist',
  'dist-server',
  'public',
  'default_files',
  'scripts',
]);

export const RUNTIME_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  '.env.example',
  'LICENSE',
  'NOTICE',
  'server/services/hook-python-runner.py',
]);

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

function packageLockKey(packageName) {
  return `node_modules/${packageName}`;
}

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function resolveLockedClaudePackages(lock) {
  const packages = requireObject(lock?.packages, 'Root package-lock.json has no packages map.');
  const sdk = requireObject(
    packages[packageLockKey(SDK_PACKAGE)],
    `Root package-lock.json does not lock ${SDK_PACKAGE}.`,
  );
  if (typeof sdk.version !== 'string' || !sdk.version) {
    throw new Error(`${SDK_PACKAGE} has no locked version.`);
  }

  const targets = CLAUDE_TARGETS.map((target) => {
    const entry = requireObject(
      packages[packageLockKey(target.packageName)],
      `Root package-lock.json does not lock ${target.packageName}.`,
    );
    if (entry.version !== sdk.version) {
      throw new Error(
        `${target.packageName}@${entry.version ?? 'unknown'} does not match ${SDK_PACKAGE}@${sdk.version}.`,
      );
    }
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      throw new Error(`${target.packageName}@${entry.version} has no SHA-512 integrity in package-lock.json.`);
    }

    return {
      ...target,
      version: entry.version,
      integrity: entry.integrity,
      resolved: typeof entry.resolved === 'string' ? entry.resolved : null,
    };
  });

  return { sdkVersion: sdk.version, targets };
}

export function verifyBufferIntegrity(buffer, integrity, label = 'artifact') {
  const [algorithm, expected] = integrity.split('-', 2);
  if (algorithm !== 'sha512' || !expected) {
    throw new Error(`${label} uses an unsupported integrity value.`);
  }
  const actual = createHash(algorithm).update(buffer).digest('base64');
  if (actual !== expected) {
    throw new Error(`${label} failed SHA-512 verification.`);
  }
}

export function verifyFileIntegrity(path, integrity, label = path) {
  verifyBufferIntegrity(readFileSync(path), integrity, label);
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function claudeExecutableRelativePath(targetKey) {
  const target = CLAUDE_TARGETS.find((candidate) => candidate.key === targetKey);
  if (!target) {
    throw new Error(`Unsupported bundled Claude target: ${targetKey}.`);
  }
  return join('claude', target.key, target.executableName);
}

export function nodeExecutableRelativePath(targetKey) {
  const target = NODE_TARGETS.find((candidate) => candidate.key === targetKey);
  if (!target) {
    throw new Error(`Unsupported bundled Node target: ${targetKey}.`);
  }
  return join('node', target.key, target.executableName);
}

export function nodeToolchainBinRelativePath(targetKey) {
  if (!NODE_TARGETS.some((candidate) => candidate.key === targetKey)) {
    throw new Error(`Unsupported bundled Node target: ${targetKey}.`);
  }
  return join('node', targetKey, 'bin');
}

export function nodeDistributionUrl(
  archiveName,
  baseUrl = process.env.CLOUDCLI_NODE_DIST_BASE_URL || NODE_DIST_BASE_URL,
) {
  if (basename(archiveName) !== archiveName) {
    throw new Error(`Invalid bundled Node archive name: ${archiveName}.`);
  }
  let parsed;
  try {
    parsed = new URL(`${baseUrl.replace(/\/+$/u, '')}/`);
  } catch (error) {
    throw new Error('CLOUDCLI_NODE_DIST_BASE_URL must be a valid HTTPS URL.', { cause: error });
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('CLOUDCLI_NODE_DIST_BASE_URL must be an HTTPS URL without credentials, query, or fragment.');
  }
  return new URL(`v${NODE_VERSION}/${archiveName}`, parsed).href;
}

export function defaultClaudeTargetKeys(platform = process.platform, architecture = process.arch) {
  const key = `${platform}-${architecture}`;
  if (!CLAUDE_TARGETS.some((target) => target.key === key)) {
    throw new Error(`Desktop Claude bundling does not support ${key}.`);
  }
  return [key];
}

export function parseClaudeTargetKeys(value) {
  const requested = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (requested.length === 0) {
    throw new Error('At least one bundled Claude target is required.');
  }
  const unique = [...new Set(requested)];
  for (const key of unique) {
    if (!CLAUDE_TARGETS.some((target) => target.key === key)) {
      throw new Error(`Unsupported bundled Claude target: ${key}.`);
    }
  }
  return unique;
}

function selectedNodeTargets(targetKeys) {
  const selected = new Set(parseClaudeTargetKeys(targetKeys.join(',')));
  return NODE_TARGETS.filter((target) => selected.has(target.key));
}

function executableCommand(command) {
  return process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(executableCommand(command), args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'pipe',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}${details ? `:\n${details}` : '.'}`,
    );
  }
  return result;
}

function packageVersion(packageDirectory) {
  const packageJson = readJson(join(packageDirectory, 'package.json'));
  return packageJson.version;
}

function findLocalPlatformPackage(rootDirectory, target) {
  const localDirectory = join(rootDirectory, 'node_modules', ...target.packageName.split('/'));
  if (!existsSync(join(localDirectory, 'package.json'))) {
    return null;
  }
  if (packageVersion(localDirectory) !== target.version) {
    throw new Error(
      `Installed ${target.packageName} does not match the locked version ${target.version}.`,
    );
  }
  return localDirectory;
}

function packPlatformPackage(target, temporaryDirectory) {
  const result = runCommand('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporaryDirectory,
    `${target.packageName}@${target.version}`,
  ]);
  let packed;
  try {
    packed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON for ${target.packageName}.`, { cause: error });
  }
  const filename = packed?.[0]?.filename;
  if (typeof filename !== 'string' || !filename) {
    throw new Error(`npm pack did not return an archive for ${target.packageName}.`);
  }
  const archivePath = resolve(temporaryDirectory, basename(filename));
  verifyFileIntegrity(archivePath, target.integrity, `${target.packageName}@${target.version}`);

  const extractDirectory = join(temporaryDirectory, target.key);
  mkdirSync(extractDirectory, { recursive: true });
  runCommand('tar', ['-xzf', archivePath, '-C', extractDirectory]);
  const packageDirectory = join(extractDirectory, 'package');
  if (packageVersion(packageDirectory) !== target.version) {
    throw new Error(`Extracted ${target.packageName} has an unexpected version.`);
  }
  return packageDirectory;
}

function loadClaudeManifest(rootDirectory, sdkVersion) {
  const sdkDirectory = join(rootDirectory, 'node_modules', ...SDK_PACKAGE.split('/'));
  if (packageVersion(sdkDirectory) !== sdkVersion) {
    throw new Error(`Installed ${SDK_PACKAGE} does not match the locked version ${sdkVersion}.`);
  }
  const manifest = readJson(join(sdkDirectory, 'manifest.json'));
  requireObject(manifest.platforms, `${SDK_PACKAGE} manifest has no platforms map.`);
  return manifest;
}

function copyOptionalFile(sourceDirectory, destinationDirectory, filename) {
  const source = join(sourceDirectory, filename);
  if (existsSync(source)) {
    cpSync(source, join(destinationDirectory, filename));
  }
}

export function bundleClaudeExecutables({
  rootDirectory,
  runtimeDirectory,
  targetKeys = defaultClaudeTargetKeys(),
}) {
  const lock = readJson(join(rootDirectory, 'package-lock.json'));
  const locked = resolveLockedClaudePackages(lock);
  const sdkManifest = loadClaudeManifest(rootDirectory, locked.sdkVersion);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cloudcli-claude-packages-'));
  const bundledTargets = [];
  const selectedTargets = new Set(parseClaudeTargetKeys(targetKeys.join(',')));

  try {
    for (const target of locked.targets) {
      if (!selectedTargets.has(target.key)) {
        continue;
      }
      const platformManifest = requireObject(
        sdkManifest.platforms[target.key],
        `${SDK_PACKAGE} manifest has no ${target.key} entry.`,
      );
      if (platformManifest.binary !== target.executableName) {
        throw new Error(`${SDK_PACKAGE} manifest has an unexpected binary for ${target.key}.`);
      }

      const packageDirectory = findLocalPlatformPackage(rootDirectory, target)
        ?? packPlatformPackage(target, temporaryDirectory);
      const sourceExecutable = join(packageDirectory, target.executableName);
      if (!existsSync(sourceExecutable) || !statSync(sourceExecutable).isFile()) {
        throw new Error(`${target.packageName} does not contain ${target.executableName}.`);
      }
      const actualChecksum = sha256File(sourceExecutable);
      if (actualChecksum !== platformManifest.checksum) {
        throw new Error(`${target.packageName} failed the SDK manifest SHA-256 verification.`);
      }

      const destinationDirectory = join(runtimeDirectory, 'claude', target.key);
      mkdirSync(destinationDirectory, { recursive: true });
      const destinationExecutable = join(destinationDirectory, target.executableName);
      cpSync(sourceExecutable, destinationExecutable);
      if (target.key.startsWith('darwin-')) {
        chmodSync(destinationExecutable, 0o755);
      }
      copyOptionalFile(packageDirectory, destinationDirectory, 'LICENSE.md');
      copyOptionalFile(packageDirectory, destinationDirectory, 'README.md');
      bundledTargets.push({
        target: target.key,
        package: target.packageName,
        packageVersion: target.version,
        executable: claudeExecutableRelativePath(target.key),
        sha256: actualChecksum,
      });
    }
  } finally {
    rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }

  const manifest = {
    sdkPackage: SDK_PACKAGE,
    sdkVersion: locked.sdkVersion,
    claudeVersion: sdkManifest.version,
    availableTargets: locked.targets.map((target) => target.key),
    targets: bundledTargets,
  };
  writeFileSync(join(runtimeDirectory, 'claude', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function bundleNodeExecutables({ runtimeDirectory, targetKeys = defaultClaudeTargetKeys() }) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cloudcli-node-distribution-'));
  const bundledTargets = [];
  try {
    for (const target of selectedNodeTargets(targetKeys)) {
      const archivePath = join(temporaryDirectory, target.archiveName);
      const downloadUrl = nodeDistributionUrl(target.archiveName);
      runCommand('curl', [
        '--fail',
        '--location',
        '--retry',
        '3',
        '--output',
        archivePath,
        downloadUrl,
      ], { stdio: 'inherit' });
      const archiveChecksum = sha256File(archivePath);
      if (archiveChecksum !== target.archiveSha256) {
        throw new Error(`${target.archiveName} failed the official Node.js SHA-256 verification.`);
      }

      const extractDirectory = join(temporaryDirectory, `extract-${target.key}`);
      mkdirSync(extractDirectory, { recursive: true });
      runCommand(
        'tar',
        [target.archiveName.endsWith('.tar.gz') ? '-xzf' : '-xf', archivePath, '-C', extractDirectory],
        { stdio: 'inherit' },
      );
      const distributionDirectory = join(extractDirectory, target.archiveRoot);
      const sourceExecutable = join(distributionDirectory, ...target.executablePath);
      if (!existsSync(sourceExecutable) || !statSync(sourceExecutable).isFile()) {
        throw new Error(`${target.archiveName} does not contain ${target.executablePath.join('/')}.`);
      }

      const destinationDirectory = join(runtimeDirectory, 'node', target.key);
      mkdirSync(destinationDirectory, { recursive: true });
      const destinationExecutable = join(destinationDirectory, target.executableName);
      cpSync(sourceExecutable, destinationExecutable);
      if (target.key.startsWith('darwin-')) {
        chmodSync(destinationExecutable, 0o755);
      }
      copyOptionalFile(distributionDirectory, destinationDirectory, 'LICENSE');
      const sourceNpmDirectory = join(distributionDirectory, ...target.npmPath);
      const npmPackage = readJson(join(sourceNpmDirectory, 'package.json'));
      if (typeof npmPackage.version !== 'string' || !npmPackage.version) {
        throw new Error(`${target.archiveName} does not contain a valid npm distribution.`);
      }
      cpSync(sourceNpmDirectory, join(destinationDirectory, 'npm'), { recursive: true });
      createNodeToolchainShims(destinationDirectory, target.key);
      bundledTargets.push({
        target: target.key,
        version: NODE_VERSION,
        source: downloadUrl,
        archiveSha256: target.archiveSha256,
        executable: nodeExecutableRelativePath(target.key),
        executableSha256: sha256File(destinationExecutable),
        npmCli: join('node', target.key, 'npm', 'bin', 'npm-cli.js'),
        npxCli: join('node', target.key, 'npm', 'bin', 'npx-cli.js'),
        toolchainBin: nodeToolchainBinRelativePath(target.key),
        npmShim: join(nodeToolchainBinRelativePath(target.key), target.key === 'win32-x64' ? 'npm.cmd' : 'npm'),
        npxShim: join(nodeToolchainBinRelativePath(target.key), target.key === 'win32-x64' ? 'npx.cmd' : 'npx'),
        npmVersion: npmPackage.version,
      });
    }
  } finally {
    rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }

  const manifest = {
    version: NODE_VERSION,
    checksumSource: `${NODE_DIST_BASE_URL}/v${NODE_VERSION}/SHASUMS256.txt`,
    targets: bundledTargets,
  };
  writeFileSync(join(runtimeDirectory, 'node', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function unixNodeToolShim(executableName, cliName) {
  return [
    '#!/bin/sh',
    'basedir="${0%/*}"',
    `exec "$basedir/../${executableName}" "$basedir/../npm/bin/${cliName}" "$@"`,
    '',
  ].join('\n');
}

function windowsNodeToolCmdShim(cliName) {
  return [
    '@ECHO off',
    `"%~dp0..\\node.exe" "%~dp0..\\npm\\bin\\${cliName}" %*`,
    '',
  ].join('\r\n');
}

function windowsNodeToolPowerShellShim(cliName) {
  return [
    '#!/usr/bin/env pwsh',
    `$node = Join-Path $PSScriptRoot '..\\node.exe'`,
    `$cli = Join-Path $PSScriptRoot '..\\npm\\bin\\${cliName}'`,
    '& $node $cli @args',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

export function createNodeToolchainShims(targetDirectory, targetKey) {
  const target = NODE_TARGETS.find((candidate) => candidate.key === targetKey);
  if (!target) {
    throw new Error(`Unsupported bundled Node target: ${targetKey}.`);
  }
  const nodeExecutable = join(targetDirectory, target.executableName);
  const npmCli = join(targetDirectory, 'npm', 'bin', 'npm-cli.js');
  const npxCli = join(targetDirectory, 'npm', 'bin', 'npx-cli.js');
  for (const requiredFile of [nodeExecutable, npmCli, npxCli]) {
    if (!existsSync(requiredFile) || !statSync(requiredFile).isFile()) {
      throw new Error(`Bundled Node toolchain input is missing: ${requiredFile}.`);
    }
  }

  const binDirectory = join(targetDirectory, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  const tools = [
    ['npm', 'npm-cli.js'],
    ['npx', 'npx-cli.js'],
  ];
  for (const [toolName, cliName] of tools) {
    const shellShim = join(binDirectory, toolName);
    writeFileSync(shellShim, unixNodeToolShim(target.executableName, cliName), { mode: 0o755 });
    chmodSync(shellShim, 0o755);
    if (target.key === 'win32-x64') {
      writeFileSync(join(binDirectory, `${toolName}.cmd`), windowsNodeToolCmdShim(cliName));
      writeFileSync(
        join(binDirectory, `${toolName}.ps1`),
        windowsNodeToolPowerShellShim(cliName),
      );
    }
  }
  return binDirectory;
}

export function refreshBundledNodeToolchain(runtimeDirectory) {
  const manifestPath = join(runtimeDirectory, 'node', 'manifest.json');
  const manifest = readJson(manifestPath);
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    throw new Error('Bundled Node manifest has no targets to refresh.');
  }
  for (const entry of manifest.targets) {
    const target = NODE_TARGETS.find((candidate) => candidate.key === entry.target);
    if (!target) {
      throw new Error(`Bundled Node manifest contains an unsupported target: ${entry.target}.`);
    }
    const targetDirectory = join(runtimeDirectory, 'node', target.key);
    createNodeToolchainShims(targetDirectory, target.key);
    delete entry.npm;
    entry.npmCli = join('node', target.key, 'npm', 'bin', 'npm-cli.js');
    entry.npxCli = join('node', target.key, 'npm', 'bin', 'npx-cli.js');
    entry.toolchainBin = nodeToolchainBinRelativePath(target.key);
    entry.npmShim = join(
      entry.toolchainBin,
      target.key === 'win32-x64' ? 'npm.cmd' : 'npm',
    );
    entry.npxShim = join(
      entry.toolchainBin,
      target.key === 'win32-x64' ? 'npx.cmd' : 'npx',
    );
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const metadataPath = join(runtimeDirectory, '.prepared.json');
  if (existsSync(metadataPath)) {
    const metadata = readJson(metadataPath);
    metadata.node = manifest;
    writeRuntimeMetadata(runtimeDirectory, metadata);
  }
  return manifest;
}

const NODE_PTY_FORK_ORIGINAL = "var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);";
const NODE_PTY_FORK_DESKTOP = "var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()], { execPath: process.env.CLOUDCLI_NODE_EXECUTABLE || process.execPath });";

export function patchRuntimeNodePty(runtimeDirectory) {
  const agentPath = join(
    runtimeDirectory,
    'node_modules',
    'node-pty',
    'lib',
    'windowsPtyAgent.js',
  );
  if (!existsSync(agentPath)) {
    throw new Error(`Desktop runtime node-pty agent was not found: ${agentPath}.`);
  }
  const source = readFileSync(agentPath, 'utf8');
  const matches = source.split(NODE_PTY_FORK_ORIGINAL).length - 1;
  if (matches !== 1) {
    throw new Error(
      `Expected exactly one node-pty console-agent fork to patch, found ${matches}.`,
    );
  }
  const patched = source.replace(NODE_PTY_FORK_ORIGINAL, NODE_PTY_FORK_DESKTOP);
  writeFileSync(agentPath, patched);
  return agentPath;
}

export function verifyElectronNodeCompatibility(desktopDirectory) {
  const electronExecutable = process.platform === 'darwin'
    ? join(
      desktopDirectory,
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron',
    )
    : join(desktopDirectory, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!existsSync(electronExecutable)) {
    throw new Error(`Installed Electron executable was not found: ${electronExecutable}.`);
  }
  const result = runCommand(electronExecutable, ['-p', 'process.versions.node'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const electronNodeVersion = result.stdout.trim();
  if (electronNodeVersion !== NODE_VERSION) {
    throw new Error(
      `Bundled Node ${NODE_VERSION} does not match Electron's Node ${electronNodeVersion}.`,
    );
  }
  return electronNodeVersion;
}

export function assertRuntimeDirectory(desktopDirectory, runtimeDirectory) {
  const expected = resolve(desktopDirectory, '.runtime');
  if (resolve(runtimeDirectory) !== expected) {
    throw new Error(`Refusing to replace unexpected runtime directory: ${runtimeDirectory}.`);
  }
}

export function assembleRuntimeFiles({ rootDirectory, desktopDirectory, runtimeDirectory }) {
  assertRuntimeDirectory(desktopDirectory, runtimeDirectory);
  for (const relativePath of [...RUNTIME_DIRECTORIES, ...RUNTIME_FILES]) {
    if (!existsSync(join(rootDirectory, relativePath))) {
      throw new Error(`Required desktop runtime input is missing: ${relativePath}. Run the root build first.`);
    }
  }

  rmSync(runtimeDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  mkdirSync(runtimeDirectory, { recursive: true });
  for (const relativePath of RUNTIME_DIRECTORIES) {
    cpSync(join(rootDirectory, relativePath), join(runtimeDirectory, relativePath), {
      recursive: true,
    });
  }
  for (const relativePath of RUNTIME_FILES) {
    const destination = join(runtimeDirectory, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(rootDirectory, relativePath), destination);
  }
}

export function installProductionDependencies(runtimeDirectory) {
  runCommand('npm', [
    'ci',
    '--omit=dev',
    '--omit=optional',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], {
    cwd: runtimeDirectory,
    stdio: 'inherit',
  });
}

export function runtimeMetadata({ rootDirectory, claudeManifest, nodeManifest }) {
  const rootPackage = readJson(join(rootDirectory, 'package.json'));
  return {
    formatVersion: 1,
    application: rootPackage.name,
    applicationVersion: rootPackage.version,
    entrypoint: 'dist-server/server/index.js',
    claude: claudeManifest,
    node: nodeManifest,
  };
}

export function writeRuntimeMetadata(runtimeDirectory, metadata) {
  writeFileSync(
    join(runtimeDirectory, '.prepared.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

export function defaultPackagingPaths(moduleUrl) {
  const scriptsDirectory = dirname(fileURLToPath(moduleUrl));
  const desktopDirectory = resolve(scriptsDirectory, '..');
  return {
    desktopDirectory,
    rootDirectory: resolve(desktopDirectory, '..'),
    runtimeDirectory: resolve(desktopDirectory, '.runtime'),
  };
}
