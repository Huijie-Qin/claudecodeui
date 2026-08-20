import { delimiter, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertDesktopRuntimeExists,
  createDesktopBackendEnvironment,
  resolveBundledClaudeCliPath,
  resolveBundledNodeExecutablePath,
  resolveBundledNodeToolchainBinPath,
  resolveBundledNpmCliPath,
  resolveDesktopRuntimePaths,
  resolveDesktopRuntimeRoot,
} from '../src/main/runtime-paths';

describe('desktop runtime paths', () => {
  it('uses resources/runtime in packaged apps and desktop/.runtime in development', () => {
    expect(resolveDesktopRuntimeRoot({
      isPackaged: true,
      resourcesPath: '/Applications/CloudCLI.app/Contents/Resources',
      appPath: '/repo/desktop',
    })).toBe('/Applications/CloudCLI.app/Contents/Resources/runtime');
    expect(resolveDesktopRuntimeRoot({
      isPackaged: false,
      resourcesPath: '/ignored',
      appPath: '/repo/desktop',
    })).toBe('/repo/desktop/.runtime');
  });

  it('selects the standalone Node executable for every supported target', () => {
    expect(resolveBundledNodeExecutablePath('/runtime', 'darwin', 'arm64'))
      .toBe('/runtime/node/darwin-arm64/node');
    expect(resolveBundledNodeExecutablePath('/runtime', 'darwin', 'x64'))
      .toBe('/runtime/node/darwin-x64/node');
    expect(resolveBundledNodeExecutablePath('/runtime', 'win32', 'x64'))
      .toBe(join('/runtime', 'node', 'win32-x64', 'node.exe'));
    expect(() => resolveBundledNodeExecutablePath('/runtime', 'win32', 'arm64'))
      .toThrow(/Unsupported Windows/u);
    expect(resolveBundledNpmCliPath('/runtime', 'darwin', 'arm64'))
      .toBe('/runtime/node/darwin-arm64/npm/bin/npm-cli.js');
    expect(resolveBundledNpmCliPath('/runtime', 'win32', 'x64'))
      .toBe(join('/runtime', 'node', 'win32-x64', 'npm', 'bin', 'npm-cli.js'));
    expect(resolveBundledNodeToolchainBinPath('/runtime', 'darwin', 'arm64'))
      .toBe('/runtime/node/darwin-arm64/bin');
    expect(resolveBundledNodeToolchainBinPath('/runtime', 'win32', 'x64'))
      .toBe(join('/runtime', 'node', 'win32-x64', 'bin'));
  });

  it('selects the bundled Claude executable for every supported target', () => {
    expect(resolveBundledClaudeCliPath('/runtime', 'darwin', 'arm64'))
      .toBe('/runtime/claude/darwin-arm64/claude');
    expect(resolveBundledClaudeCliPath('/runtime', 'darwin', 'x64'))
      .toBe('/runtime/claude/darwin-x64/claude');
    expect(resolveBundledClaudeCliPath('/runtime', 'win32', 'x64'))
      .toBe(join('/runtime', 'claude', 'win32-x64', 'claude.exe'));
    expect(() => resolveBundledClaudeCliPath('/runtime', 'win32', 'arm64'))
      .toThrow(/Unsupported Windows/u);
  });

  it('forces loopback/local execution and prepends the bundled Claude directory', () => {
    const paths = resolveDesktopRuntimePaths({
      isPackaged: true,
      resourcesPath: '/Applications/CloudCLI.app/Contents/Resources',
      appPath: '/ignored',
      platform: 'darwin',
      arch: 'arm64',
    });
    const environment = createDesktopBackendEnvironment(paths, 45678, {
      PATH: '/usr/bin',
      HOST: '0.0.0.0',
      CLAUDE_EXECUTION_MODE: 'docker',
    });

    expect(environment).toMatchObject({
      CLOUDCLI_BACKEND_ENTRY: '/Applications/CloudCLI.app/Contents/Resources/runtime/dist-server/server/index.js',
      CLOUDCLI_DESKTOP_MODE: 'true',
      CLOUDCLI_NODE_EXECUTABLE: '/Applications/CloudCLI.app/Contents/Resources/runtime/node/darwin-arm64/node',
      CLOUDCLI_NPM_CLI_PATH: '/Applications/CloudCLI.app/Contents/Resources/runtime/node/darwin-arm64/npm/bin/npm-cli.js',
      CLAUDE_EXECUTION_MODE: 'local',
      CLAUDE_CLI_PATH: '/Applications/CloudCLI.app/Contents/Resources/runtime/claude/darwin-arm64/claude',
      GRACEFUL_SHUTDOWN_TIMEOUT_MS: '1740000',
      HOST: '127.0.0.1',
      SERVER_PORT: '45678',
      PATH: [
        '/Applications/CloudCLI.app/Contents/Resources/runtime/node/darwin-arm64/bin',
        '/Applications/CloudCLI.app/Contents/Resources/runtime/node/darwin-arm64',
        '/Applications/CloudCLI.app/Contents/Resources/runtime/claude/darwin-arm64',
        '/usr/bin',
      ].join(delimiter),
    });
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === 'path'))
      .toEqual(['PATH']);
  });

  it('requires backend, Claude, standalone Node, npm CLI, and npm/npx shims', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cloudcli-runtime-paths-test-'));
    try {
      const paths = resolveDesktopRuntimePaths({
        isPackaged: true,
        resourcesPath: workspace,
        appPath: '/ignored',
        platform: 'darwin',
        arch: 'arm64',
      });
      for (const file of [
        paths.backendEntry,
        paths.claudeCli,
        paths.nodeExecutable,
        paths.npmCli,
        join(workspace, 'runtime', 'node', 'darwin-arm64', 'bin', 'npm'),
        join(workspace, 'runtime', 'node', 'darwin-arm64', 'bin', 'npx'),
      ]) {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'fixture');
      }

      expect(() => assertDesktopRuntimeExists(paths)).not.toThrow();
      rmSync(join(workspace, 'runtime', 'node', 'darwin-arm64', 'bin', 'npx'));
      expect(() => assertDesktopRuntimeExists(paths)).toThrow(/npx shim/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
