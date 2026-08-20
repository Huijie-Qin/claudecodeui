import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  assembleRuntimeFiles,
  bundleClaudeExecutables,
  bundleNodeExecutables,
  defaultClaudeTargetKeys,
  defaultPackagingPaths,
  installProductionDependencies,
  patchRuntimeNodePty,
  parseClaudeTargetKeys,
  runtimeMetadata,
  verifyElectronNodeCompatibility,
  writeRuntimeMetadata,
} from './runtime-packaging.mjs';

export function prepareRuntime(
  paths = defaultPackagingPaths(import.meta.url),
  targetKeys = defaultClaudeTargetKeys(),
) {
  verifyElectronNodeCompatibility(paths.desktopDirectory);
  assembleRuntimeFiles(paths);
  installProductionDependencies(paths.runtimeDirectory);
  patchRuntimeNodePty(paths.runtimeDirectory);
  const claudeManifest = bundleClaudeExecutables({ ...paths, targetKeys });
  const nodeManifest = bundleNodeExecutables({ ...paths, targetKeys });
  writeRuntimeMetadata(
    paths.runtimeDirectory,
    runtimeMetadata({ rootDirectory: paths.rootDirectory, claudeManifest, nodeManifest }),
  );
  return paths.runtimeDirectory;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const targetsArgument = process.argv.slice(2).find((argument) => argument.startsWith('--targets='));
    const targetKeys = targetsArgument
      ? parseClaudeTargetKeys(targetsArgument.slice('--targets='.length))
      : defaultClaudeTargetKeys();
    const runtimeDirectory = prepareRuntime(defaultPackagingPaths(import.meta.url), targetKeys);
    console.log(`Prepared self-contained desktop runtime at ${runtimeDirectory}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
