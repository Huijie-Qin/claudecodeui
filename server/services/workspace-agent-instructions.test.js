import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  migrateLegacyWorkspaceAgentInstructions,
  readWorkspaceAgentInstructions,
  writeWorkspaceAgentInstructions,
} from './workspace-agent-instructions.js';

async function withWorkspace(run) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-claude-memory-'));
  try {
    await run(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

test('uses root CLAUDE.md as project memory', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), '# Project memory\n', 'utf8');

    const result = await readWorkspaceAgentInstructions(workspacePath);

    assert.equal(result.content, '# Project memory\n');
    assert.equal(result.source, 'claude');
    assert.equal(result.customInstructions.hasCustomInstructions, false);
    assert.match(result.revision, /^[a-f0-9]{64}$/);
  });
});

test('migrates a legacy Agent.md to CLAUDE.md when project memory is absent', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, 'Agent.md'), '# Legacy memory\n', 'utf8');

    const result = await readWorkspaceAgentInstructions(workspacePath);

    assert.equal(result.content, '# Legacy memory\n');
    assert.equal(result.migration.migrated, true);
    assert.equal(await fs.readFile(path.join(workspacePath, 'CLAUDE.md'), 'utf8'), '# Legacy memory\n');
    await assert.rejects(fs.access(path.join(workspacePath, 'Agent.md')), (error) => error?.code === 'ENOENT');
  });
});

test('preserves a differing legacy Agent.md when CLAUDE.md already exists', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), '# Current memory\n', 'utf8');
    await fs.writeFile(path.join(workspacePath, 'Agent.md'), '# Legacy content\n', 'utf8');

    const result = await readWorkspaceAgentInstructions(workspacePath);

    assert.equal(result.content, '# Current memory\n');
    assert.equal(result.migration.legacyConflict, true);
    assert.deepEqual(result.customInstructions.customInstructionFiles, ['Agent.md']);
    assert.equal(await fs.readFile(path.join(workspacePath, 'Agent.md'), 'utf8'), '# Legacy content\n');
  });
});

test('removes an identical legacy Agent.md duplicate', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), '# Same memory\n', 'utf8');
    await fs.writeFile(path.join(workspacePath, 'Agent.md'), '# Same memory\n', 'utf8');

    const migration = await migrateLegacyWorkspaceAgentInstructions(workspacePath);

    assert.equal(migration.removed, true);
    await assert.rejects(fs.access(path.join(workspacePath, 'Agent.md')), (error) => error?.code === 'ENOENT');
  });
});

test('writes CLAUDE.md and preserves .claude/CLAUDE.md', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.mkdir(path.join(workspacePath, '.claude'));
    await fs.writeFile(path.join(workspacePath, '.claude', 'CLAUDE.md'), '# Additional memory\n', 'utf8');

    const written = await writeWorkspaceAgentInstructions(workspacePath, '# Updated memory\n');

    assert.equal(await fs.readFile(path.join(workspacePath, 'CLAUDE.md'), 'utf8'), '# Updated memory\n');
    assert.equal(await fs.readFile(path.join(workspacePath, '.claude', 'CLAUDE.md'), 'utf8'), '# Additional memory\n');
    assert.deepEqual(written.paths, [path.join(workspacePath, 'CLAUDE.md')]);
    assert.deepEqual(written.customInstructions.customInstructionFiles, [path.join('.claude', 'CLAUDE.md')]);
  });
});

test('file-page edits are reflected in the next settings read and revision', async () => {
  await withWorkspace(async (workspacePath) => {
    const claudePath = path.join(workspacePath, 'CLAUDE.md');
    await fs.writeFile(claudePath, '# First memory\n', 'utf8');
    const first = await readWorkspaceAgentInstructions(workspacePath);

    await fs.writeFile(claudePath, '# Edited from Files\n', 'utf8');
    const second = await readWorkspaceAgentInstructions(workspacePath);

    assert.equal(second.content, '# Edited from Files\n');
    assert.notEqual(second.revision, first.revision);
  });
});

test('rejects CLAUDE.md symlinks without writing outside the workspace', async () => {
  await withWorkspace(async (workspacePath) => {
    const outsidePath = path.join(os.tmpdir(), `cloudcli-claude-outside-${Date.now()}.md`);
    try {
      await fs.writeFile(outsidePath, 'outside content', 'utf8');
      await fs.symlink(outsidePath, path.join(workspacePath, 'CLAUDE.md'));

      await assert.rejects(
        writeWorkspaceAgentInstructions(workspacePath, '# Safe content\n'),
        (error) => error?.code === 'ELOOP',
      );

      assert.equal(await fs.readFile(outsidePath, 'utf8'), 'outside content');
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });
});

test('does not recreate a missing workspace directory', async () => {
  const missingPath = path.join(os.tmpdir(), `cloudcli-missing-workspace-${Date.now()}`);

  await assert.rejects(
    writeWorkspaceAgentInstructions(missingPath, '# Memory\n'),
    (error) => error?.code === 'ENOENT',
  );
  await assert.rejects(fs.access(missingPath), (error) => error?.code === 'ENOENT');
});
