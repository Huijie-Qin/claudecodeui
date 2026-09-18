import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'ccui-fork-tests-'));
const databasePath = path.join(temp, 'test.db');
// Prevent the application's compatibility migration from copying a real DB.
await writeFile(databasePath, '');
const tests = [
  'server/database/multitenancy-db.test.js',
  'server/projects.runtime-history.test.js',
  'server/services/platform-analytics.test.js',
  'server/services/mcp-tool-usage.test.js',
  'server/services/claude-fork-checkpoint.test.js',
  'server/services/claude-fork-checkpoint-store.test.js',
  'server/services/claude-session-fork-files.test.js',
  'server/services/claude-session-fork-resume.test.js',
  'server/services/session-fork.test.js',
  'server/services/session-fork-lock.test.js',
  'server/services/session-fork.integration.test.js',
  'server/services/session-message-history.test.js',
  'server/services/workspace-projects.test.js',
  'server/modules/providers/list/claude/claude-sessions.provider.test.ts',
  'src/components/chat/utils/sessionFork.test.ts',
  'src/hooks/projectTenantUpdates.test.ts',
  'src/hooks/useProjectsState.test.ts',
  'src/components/chat/hooks/useChatMessages.test.ts',
];
try {
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_PATH: databasePath, TSX_TSCONFIG_PATH: path.join(root, 'server/tsconfig.json') },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
