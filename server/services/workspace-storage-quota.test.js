import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { calculateWorkspaceUsageBytes } from './workspace-storage-quota.js';

test('calculateWorkspaceUsageBytes is stable across concurrency limits', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-quota-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(root, 'nested'));
  await Promise.all([
    fs.writeFile(path.join(root, 'one.txt'), '12345'),
    fs.writeFile(path.join(root, 'nested', 'two.txt'), '1234567'),
  ]);

  const serial = await calculateWorkspaceUsageBytes(root, { concurrency: 1 });
  const concurrent = await calculateWorkspaceUsageBytes(root, { concurrency: 32 });

  assert.equal(serial, concurrent);
  assert.equal(serial, 12);
});

test('calculateWorkspaceUsageBytes rejects an aborted scan', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    calculateWorkspaceUsageBytes(process.cwd(), { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
});
