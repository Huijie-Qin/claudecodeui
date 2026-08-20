export interface ClaudeTarget {
  key: string;
  packageName: string;
  executableName: string;
}

export interface PackagingPaths {
  rootDirectory: string;
  desktopDirectory: string;
  runtimeDirectory: string;
}

export const CLAUDE_TARGETS: readonly ClaudeTarget[];
export const NODE_VERSION: string;
export const NODE_DIST_BASE_URL: string;
export const NODE_TARGETS: readonly Array<{
  key: string;
  archiveName: string;
  archiveSha256: string;
  archiveRoot: string;
  executableName: string;
  executablePath: readonly string[];
  npmPath: readonly string[];
}>;
export const RUNTIME_DIRECTORIES: readonly string[];
export const RUNTIME_FILES: readonly string[];

export function resolveLockedClaudePackages(lock: unknown): {
  sdkVersion: string;
  targets: Array<ClaudeTarget & {
    version: string;
    integrity: string;
    resolved: string | null;
  }>;
};
export function verifyBufferIntegrity(buffer: Buffer, integrity: string, label?: string): void;
export function claudeExecutableRelativePath(targetKey: string): string;
export function nodeExecutableRelativePath(targetKey: string): string;
export function nodeToolchainBinRelativePath(targetKey: string): string;
export function nodeDistributionUrl(archiveName: string, baseUrl?: string): string;
export function nodeDistributionCachePath(desktopDirectory: string, archiveName: string): string;
export function defaultClaudeTargetKeys(platform?: string, architecture?: string): string[];
export function parseClaudeTargetKeys(value: string): string[];
export function resolveCommandInvocation(
  command: string,
  args: string[],
  options?: {
    platform?: NodeJS.Platform;
    nodeExecutable?: string;
    npmExecPath?: string;
  },
): { command: string; args: string[] };
export function assembleRuntimeFiles(paths: PackagingPaths): void;
export function createNodeToolchainShims(targetDirectory: string, targetKey: string): string;
export function refreshBundledNodeToolchain(runtimeDirectory: string): unknown;
export function patchRuntimeNodePty(runtimeDirectory: string): string;
