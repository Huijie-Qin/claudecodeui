import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Container IDs are captured before pausing. Pre-existing pauses are not owned
// by this migration and never appear here. Repeated recovery is idempotent.
export async function recoverAccountCopyRuntimes(scope, { run = exec, executable = process.env.CLOUDCLI_DOCKER_CLI_PATH || 'docker' } = {}) {
  for (const id of scope.pausedContainers || []) {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Invalid migration runtime container ID');
    try {
      const { stdout } = await run(executable, ['inspect', '-f', '{{json .State}}', id], { timeout: 10000 });
      if (JSON.parse(stdout.trim()).Paused) await run(executable, ['unpause', id], { timeout: 10000 });
    } catch (error) {
      if (!/No such (?:object|container)|is not paused/i.test(error.stderr || '')) throw error;
    }
  }
}
