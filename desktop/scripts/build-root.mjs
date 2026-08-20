import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defaultPackagingPaths, runCommand } from './runtime-packaging.mjs';

export function buildRootApplication(paths = defaultPackagingPaths(import.meta.url)) {
  runCommand('npm', ['run', 'build'], {
    cwd: paths.rootDirectory,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_IS_PLATFORM: 'false',
    },
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    buildRootApplication();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
