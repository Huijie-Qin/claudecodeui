import { createHash } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_TARGETS,
  NODE_TARGETS,
  NODE_VERSION,
  RUNTIME_DIRECTORIES,
  RUNTIME_FILES,
  assembleRuntimeFiles,
  claudeExecutableRelativePath,
  createNodeToolchainShims,
  defaultClaudeTargetKeys,
  nodeExecutableRelativePath,
  nodeToolchainBinRelativePath,
  patchRuntimeNodePty,
  refreshBundledNodeToolchain,
  parseClaudeTargetKeys,
  resolveLockedClaudePackages,
  verifyBufferIntegrity,
} from '../scripts/runtime-packaging.mjs';

const require = createRequire(import.meta.url);
const nativePackaging = require('../scripts/rebuild-runtime-native.cjs') as {
  NATIVE_MODULES: string[];
  archName: (arch: string | number) => string;
  packagedRuntimeDirectory: (context: {
    appOutDir: string;
    electronPlatformName: string;
    packager: { appInfo: { productFilename: string } };
  }) => string;
  pruneNativeBuildArtifacts: (
    runtimeDirectory: string,
    platform?: NodeJS.Platform,
    arch?: string,
  ) => void;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function lockedPackages(version = '0.2.116') {
  const packages: Record<string, unknown> = {
    'node_modules/@anthropic-ai/claude-agent-sdk': { version },
  };
  for (const target of CLAUDE_TARGETS) {
    packages[`node_modules/${target.packageName}`] = {
      version,
      integrity: 'sha512-Zml4dHVyZQ==',
      resolved: `https://registry.example/${target.key}.tgz`,
    };
  }
  return { packages };
}

describe('desktop runtime packaging', () => {
  it('locks every supported Claude platform package to the SDK version', () => {
    const locked = resolveLockedClaudePackages(lockedPackages());
    expect(locked.sdkVersion).toBe('0.2.116');
    expect(locked.targets.map((target: { key: string }) => target.key)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'win32-x64',
    ]);

    const mismatch = lockedPackages();
    (mismatch.packages['node_modules/@anthropic-ai/claude-agent-sdk-win32-x64'] as { version: string })
      .version = '0.2.115';
    expect(() => resolveLockedClaudePackages(mismatch)).toThrow(/does not match/u);
  });

  it('selects only the requested package target and maps its executable', () => {
    expect(defaultClaudeTargetKeys('darwin', 'arm64')).toEqual(['darwin-arm64']);
    expect(defaultClaudeTargetKeys('win32', 'x64')).toEqual(['win32-x64']);
    expect(parseClaudeTargetKeys('darwin-arm64,darwin-x64,darwin-arm64')).toEqual([
      'darwin-arm64',
      'darwin-x64',
    ]);
    expect(claudeExecutableRelativePath('win32-x64')).toBe(
      join('claude', 'win32-x64', 'claude.exe'),
    );
    expect(() => parseClaudeTargetKeys('linux-x64')).toThrow(/Unsupported/u);
  });

  it('pins official standalone Node archives for the same desktop targets', () => {
    expect(NODE_VERSION).toBe('24.18.1');
    expect(NODE_TARGETS.map((target) => target.key)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'win32-x64',
    ]);
    for (const target of NODE_TARGETS) {
      expect(target.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(target.npmPath.at(-1)).toBe('npm');
    }
    expect(nodeExecutableRelativePath('darwin-arm64'))
      .toBe(join('node', 'darwin-arm64', 'node'));
    expect(nodeExecutableRelativePath('win32-x64'))
      .toBe(join('node', 'win32-x64', 'node.exe'));
    expect(nodeToolchainBinRelativePath('darwin-x64'))
      .toBe(join('node', 'darwin-x64', 'bin'));
  });

  it('creates target-local npm and npx shims for Unix and Windows', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cloudcli-node-shim-test-'));
    temporaryDirectories.push(workspace);
    for (const [targetKey, executableName] of [
      ['darwin-arm64', 'node'],
      ['win32-x64', 'node.exe'],
    ] as const) {
      const targetDirectory = join(workspace, 'node', targetKey);
      mkdirSync(join(targetDirectory, 'npm', 'bin'), { recursive: true });
      writeFileSync(join(targetDirectory, executableName), 'node');
      writeFileSync(join(targetDirectory, 'npm', 'bin', 'npm-cli.js'), 'npm');
      writeFileSync(join(targetDirectory, 'npm', 'bin', 'npx-cli.js'), 'npx');

      createNodeToolchainShims(targetDirectory, targetKey);

      const npmShim = join(targetDirectory, 'bin', 'npm');
      const npxShim = join(targetDirectory, 'bin', 'npx');
      expect(readFileSync(npmShim, 'utf8')).toContain('../npm/bin/npm-cli.js');
      expect(readFileSync(npxShim, 'utf8')).toContain('../npm/bin/npx-cli.js');
      expect(statSync(npmShim).mode & 0o111).not.toBe(0);
      if (targetKey === 'win32-x64') {
        expect(readFileSync(join(targetDirectory, 'bin', 'npm.cmd'), 'utf8'))
          .toContain('..\\node.exe');
        expect(readFileSync(join(targetDirectory, 'bin', 'npx.ps1'), 'utf8'))
          .toContain('npx-cli.js');
      }
    }
    writeFileSync(join(workspace, 'node', 'manifest.json'), JSON.stringify({
      version: NODE_VERSION,
      targets: [
        { target: 'darwin-arm64', npm: 'legacy/npm-cli.js' },
        { target: 'win32-x64', npm: 'legacy/npm-cli.js' },
      ],
    }));

    const refreshed = refreshBundledNodeToolchain(workspace) as {
      targets: Array<Record<string, string>>;
    };
    expect(refreshed.targets[0]).toMatchObject({
      npmCli: join('node', 'darwin-arm64', 'npm', 'bin', 'npm-cli.js'),
      toolchainBin: join('node', 'darwin-arm64', 'bin'),
      npmShim: join('node', 'darwin-arm64', 'bin', 'npm'),
      npxShim: join('node', 'darwin-arm64', 'bin', 'npx'),
    });
    expect(refreshed.targets[0]?.npm).toBeUndefined();
  });

  it('patches exactly one runtime-only node-pty console-agent fork', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cloudcli-node-pty-patch-test-'));
    temporaryDirectories.push(workspace);
    const runtimeAgent = join(
      workspace,
      'node_modules',
      'node-pty',
      'lib',
      'windowsPtyAgent.js',
    );
    mkdirSync(dirname(runtimeAgent), { recursive: true });
    writeFileSync(
      runtimeAgent,
      "before\nvar agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);\nafter\n",
    );

    patchRuntimeNodePty(workspace);

    expect(readFileSync(runtimeAgent, 'utf8')).toContain(
      'execPath: process.env.CLOUDCLI_NODE_EXECUTABLE || process.execPath',
    );
    expect(() => patchRuntimeNodePty(workspace)).toThrow(/exactly one/u);
    writeFileSync(runtimeAgent, 'no matching fork');
    expect(() => patchRuntimeNodePty(workspace)).toThrow(/found 0/u);
    const originalFork = "var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);";
    writeFileSync(runtimeAgent, `${originalFork}\n${originalFork}\n`);
    expect(() => patchRuntimeNodePty(workspace)).toThrow(/found 2/u);
  });

  it('rejects package bytes that do not match the lock integrity', () => {
    const contents = Buffer.from('official package bytes');
    const integrity = `sha512-${createHash('sha512').update(contents).digest('base64')}`;
    expect(() => verifyBufferIntegrity(contents, integrity)).not.toThrow();
    expect(() => verifyBufferIntegrity(Buffer.from('tampered'), integrity)).toThrow(/verification/u);
  });

  it('assembles only the declared application runtime inputs', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cloudcli-runtime-test-'));
    temporaryDirectories.push(workspace);
    const rootDirectory = join(workspace, 'root');
    const desktopDirectory = join(rootDirectory, 'desktop');
    const runtimeDirectory = join(desktopDirectory, '.runtime');
    mkdirSync(desktopDirectory, { recursive: true });
    for (const directory of RUNTIME_DIRECTORIES) {
      mkdirSync(join(rootDirectory, directory), { recursive: true });
      writeFileSync(join(rootDirectory, directory, 'marker'), directory);
    }
    for (const file of RUNTIME_FILES) {
      mkdirSync(dirname(join(rootDirectory, file)), { recursive: true });
      writeFileSync(join(rootDirectory, file), file.endsWith('.json') ? '{}' : file);
    }

    assembleRuntimeFiles({ rootDirectory, desktopDirectory, runtimeDirectory });

    expect(existsSync(join(runtimeDirectory, 'dist', 'marker'))).toBe(true);
    expect(readFileSync(join(runtimeDirectory, 'default_files', 'marker'), 'utf8'))
      .toBe('default_files');
    expect(readFileSync(
      join(runtimeDirectory, 'server', 'services', 'hook-python-runner.py'),
      'utf8',
    )).toBe('server/services/hook-python-runner.py');
    expect(existsSync(join(runtimeDirectory, 'node_modules'))).toBe(false);
    expect(() => assembleRuntimeFiles({
      rootDirectory,
      desktopDirectory,
      runtimeDirectory: join(desktopDirectory, 'unexpected'),
    })).toThrow(/Refusing/u);
  });

  it('maps Electron Builder architecture and packaged resource locations', () => {
    expect(nativePackaging.NATIVE_MODULES).toEqual(['better-sqlite3', 'bcrypt', 'node-pty']);
    expect(nativePackaging.archName(1)).toBe('x64');
    expect(nativePackaging.archName(3)).toBe('arm64');
    expect(nativePackaging.packagedRuntimeDirectory({
      appOutDir: '/tmp/mac',
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'CloudCLI' } },
    })).toBe('/tmp/mac/CloudCLI.app/Contents/Resources/runtime');
    expect(nativePackaging.packagedRuntimeDirectory({
      appOutDir: 'C:\\build\\win-unpacked',
      electronPlatformName: 'win32',
      packager: { appInfo: { productFilename: 'CloudCLI' } },
    })).toBe(join('C:\\build\\win-unpacked', 'resources', 'runtime'));
  });

  it('prunes architecture-specific rebuild caches while preserving macOS PTY helpers', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cloudcli-native-prune-test-'));
    temporaryDirectories.push(workspace);
    for (const moduleName of nativePackaging.NATIVE_MODULES) {
      const moduleDirectory = join(workspace, 'node_modules', moduleName);
      mkdirSync(join(moduleDirectory, 'build', 'Release', 'obj.target'), { recursive: true });
      mkdirSync(join(moduleDirectory, 'bin', 'darwin-arm64-148'), { recursive: true });
      mkdirSync(join(moduleDirectory, 'prebuilds'), { recursive: true });
      mkdirSync(join(moduleDirectory, 'node-addon-api'), { recursive: true });
      writeFileSync(join(moduleDirectory, 'package.json'), '{}');
      writeFileSync(join(moduleDirectory, 'build', 'Makefile'), 'architecture-specific');
      writeFileSync(join(moduleDirectory, 'build', 'Release', `${moduleName}.node`), 'binding');
      writeFileSync(join(moduleDirectory, 'bin', 'darwin-arm64-148', `${moduleName}.node`), 'cache');
      writeFileSync(join(moduleDirectory, 'prebuilds', `${moduleName}.node`), 'official-prebuild');
      writeFileSync(
        join(moduleDirectory, 'node-addon-api', 'node_addon_api.target.mk'),
        'architecture-specific',
      );
    }
    const spawnHelper = join(
      workspace,
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'spawn-helper',
    );
    writeFileSync(spawnHelper, 'spawn-helper');
    chmodSync(spawnHelper, 0o755);

    nativePackaging.pruneNativeBuildArtifacts(workspace, 'darwin', 'arm64');

    expect(existsSync(join(
      workspace,
      'node_modules',
      'better-sqlite3',
      'build',
    ))).toBe(false);
    for (const moduleName of ['bcrypt', 'node-pty']) {
      const moduleDirectory = join(workspace, 'node_modules', moduleName);
      expect(readFileSync(
        join(moduleDirectory, 'build', 'Release', `${moduleName}.node`),
        'utf8',
      )).toBe('binding');
      expect(existsSync(join(moduleDirectory, 'build', 'Makefile'))).toBe(false);
      expect(existsSync(join(moduleDirectory, 'bin'))).toBe(false);
      expect(existsSync(join(moduleDirectory, 'node-addon-api'))).toBe(false);
      expect(readFileSync(join(moduleDirectory, 'prebuilds', `${moduleName}.node`), 'utf8'))
        .toBe('official-prebuild');
    }
    expect(readFileSync(spawnHelper, 'utf8')).toBe('spawn-helper');
    expect(statSync(spawnHelper).mode & 0o111).not.toBe(0);
  });

  it('preserves the Windows ConPTY bindings and helper binaries', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cloudcli-native-win-prune-test-'));
    temporaryDirectories.push(workspace);
    for (const moduleName of nativePackaging.NATIVE_MODULES) {
      const releaseDirectory = join(workspace, 'node_modules', moduleName, 'build', 'Release');
      mkdirSync(releaseDirectory, { recursive: true });
      writeFileSync(join(workspace, 'node_modules', moduleName, 'package.json'), '{}');
      if (moduleName === 'bcrypt') {
        writeFileSync(join(releaseDirectory, 'bcrypt_lib.node'), 'bcrypt');
      } else if (moduleName === 'node-pty') {
        writeFileSync(join(releaseDirectory, 'conpty.node'), 'conpty');
        writeFileSync(join(releaseDirectory, 'conpty_console_list.node'), 'console-list');
        const prebuiltConpty = join(
          workspace,
          'node_modules',
          moduleName,
          'prebuilds',
          'win32-x64',
          'conpty',
        );
        mkdirSync(prebuiltConpty, { recursive: true });
        writeFileSync(join(prebuiltConpty, 'conpty.dll'), 'dll');
        writeFileSync(join(prebuiltConpty, 'OpenConsole.exe'), 'console');
      }
      writeFileSync(join(workspace, 'node_modules', moduleName, 'build', 'Makefile'), 'build-only');
    }

    nativePackaging.pruneNativeBuildArtifacts(workspace, 'win32', 'x64');

    const releaseDirectory = join(workspace, 'node_modules', 'node-pty', 'build', 'Release');
    expect(readFileSync(join(releaseDirectory, 'conpty.node'), 'utf8')).toBe('conpty');
    expect(readFileSync(join(releaseDirectory, 'conpty_console_list.node'), 'utf8'))
      .toBe('console-list');
    expect(readFileSync(join(releaseDirectory, 'conpty', 'conpty.dll'), 'utf8')).toBe('dll');
    expect(readFileSync(join(releaseDirectory, 'conpty', 'OpenConsole.exe'), 'utf8'))
      .toBe('console');
    expect(existsSync(join(workspace, 'node_modules', 'node-pty', 'build', 'Makefile')))
      .toBe(false);
  });
});

describe('desktop build wiring', () => {
  it('packages the generated runtime as an external resource', () => {
    const builderConfig = readFileSync(
      join(import.meta.dirname, '..', 'electron-builder.config.ts'),
      'utf8',
    );
    expect(builderConfig).toContain("from: '.runtime'");
    expect(builderConfig).toContain("to: 'runtime'");
    expect(builderConfig).toContain("'!node{,/**/*}'");
    expect(builderConfig).toContain("'!node_modules{,/**/*}'");
    expect(builderConfig).toContain("from: '.runtime/node_modules'");
    expect(builderConfig).toContain("to: 'runtime/node_modules'");
    expect(builderConfig).toContain("from: '.runtime/node'");
    expect(builderConfig).toContain("to: 'runtime/node'");
    expect(builderConfig).toContain("afterPack: './scripts/after-pack.cjs'");
    expect(builderConfig).toContain(
      "x64ArchFiles: 'Contents/Resources/runtime/{claude/**,node/**,node_modules/**/prebuilds/**}'",
    );
  });

  it('builds the root application before target-specific runtime preparation', () => {
    const desktopPackage = JSON.parse(readFileSync(
      join(import.meta.dirname, '..', 'package.json'),
      'utf8',
    )) as { scripts: Record<string, string> };
    expect(desktopPackage.scripts['build:runtime:mac']).toMatch(
      /^node scripts\/build-root\.mjs .*--targets=darwin-arm64,darwin-x64$/u,
    );
    expect(desktopPackage.scripts['build:runtime:win']).toMatch(
      /^node scripts\/build-root\.mjs .*--targets=win32-x64$/u,
    );
    expect(readFileSync(join(import.meta.dirname, '..', 'scripts', 'build-root.mjs'), 'utf8'))
      .toContain("VITE_IS_PLATFORM: 'false'");
  });

  it('locks the N-API better-sqlite3 generation required by Electron 43', () => {
    const rootLock = JSON.parse(readFileSync(
      join(import.meta.dirname, '..', '..', 'package-lock.json'),
      'utf8',
    )) as { packages: Record<string, { version?: string }> };
    const version = rootLock.packages['node_modules/better-sqlite3']?.version;
    expect(version).toBeTruthy();
    expect(Number(version?.split('.')[0])).toBeGreaterThanOrEqual(13);
  });

  it('keeps npm out of the normal web dependency graph', () => {
    const rootLock = JSON.parse(readFileSync(
      join(import.meta.dirname, '..', '..', 'package-lock.json'),
      'utf8',
    )) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
    expect(rootLock.packages['']?.dependencies?.npm).toBeUndefined();
    expect(rootLock.packages['node_modules/npm']).toBeUndefined();
  });

  it('runs packaged native modules and standalone npm/npx in release CI', () => {
    const workflow = readFileSync(
      join(import.meta.dirname, '..', '..', '.github', 'workflows', 'desktop-release.yml'),
      'utf8',
    );
    expect(workflow).toContain('desktop/scripts/smoke-native-runtime.cjs');
    expect(workflow).toContain('CLOUDCLI_NODE_EXECUTABLE = $nodeExecutable');
    expect(workflow).toContain('$PTY_RELEASE/spawn-helper');
    expect(workflow).toContain('node-pty/build/Release/conpty_console_list.node');
    expect(workflow).toContain('npm --version');
    expect(workflow).toContain('npx --version');
  });
});
