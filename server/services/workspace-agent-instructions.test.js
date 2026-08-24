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
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-agent-instructions-'));
  try {
    await run(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

test('uses Agent.md as the only platform-managed instruction source', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, 'Agent.md'), '# Agent\n', 'utf8');
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), '# User project instructions\n', 'utf8');

    const result = await readWorkspaceAgentInstructions(workspacePath);
    assert.equal(result.content, '# Agent\n');
    assert.equal(result.source, 'agent');
    assert.deepEqual(result.customInstructions.customInstructionFiles, ['CLAUDE.md']);
    assert.equal(result.customInstructions.hasCustomInstructions, true);
    assert.equal(result.customInstructions.legacyRootMirror, false);
    assert.match(result.revision, /^[a-f0-9]{64}$/);
  });
});

test('does not reinterpret user CLAUDE.md as Agent.md', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), '# User instructions\n', 'utf8');

    const result = await readWorkspaceAgentInstructions(workspacePath);
    assert.equal(result.content, '');
    assert.equal(result.source, 'empty');
    assert.deepEqual(result.customInstructions.customInstructionFiles, ['CLAUDE.md']);
  });
});

test('detects both supported user CLAUDE.md locations', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.mkdir(path.join(workspacePath, '.claude'));
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), '# Root\n', 'utf8');
    await fs.writeFile(path.join(workspacePath, '.claude', 'CLAUDE.md'), '# Dot Claude\n', 'utf8');

    const result = await readWorkspaceAgentInstructions(workspacePath);
    assert.deepEqual(
      result.customInstructions.customInstructionFiles,
      ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')],
    );
  });
});

test('writes only Agent.md and preserves user-authored CLAUDE.md files', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.mkdir(path.join(workspacePath, '.claude'));
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), '# Root custom\n', 'utf8');
    await fs.writeFile(path.join(workspacePath, '.claude', 'CLAUDE.md'), '# Dot custom\n', 'utf8');
    const content = '# Role\n\nYou are a market analyst.\n';

    const written = await writeWorkspaceAgentInstructions(workspacePath, content);

    assert.equal(await fs.readFile(path.join(workspacePath, 'Agent.md'), 'utf8'), content);
    assert.equal(await fs.readFile(path.join(workspacePath, 'CLAUDE.md'), 'utf8'), '# Root custom\n');
    assert.equal(await fs.readFile(path.join(workspacePath, '.claude', 'CLAUDE.md'), 'utf8'), '# Dot custom\n');
    assert.deepEqual(written.paths, [path.join(workspacePath, 'Agent.md')]);
    assert.equal(written.migration.removed, false);
  });
});

test('removes an unchanged legacy root CLAUDE.md mirror while saving Agent.md', async () => {
  await withWorkspace(async (workspacePath) => {
    const oldContent = '# Old Agent\n';
    await fs.writeFile(path.join(workspacePath, 'Agent.md'), oldContent, 'utf8');
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), oldContent, 'utf8');

    const written = await writeWorkspaceAgentInstructions(workspacePath, '# Updated Agent\n');

    assert.equal(written.migration.removed, true);
    await assert.rejects(
      fs.access(path.join(workspacePath, 'CLAUDE.md')),
      (error) => error?.code === 'ENOENT',
    );
    assert.equal(await fs.readFile(path.join(workspacePath, 'Agent.md'), 'utf8'), '# Updated Agent\n');
  });
});

test('runtime migration removes only an exact legacy mirror', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, 'Agent.md'), '# Agent\n', 'utf8');
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), '# Agent\n', 'utf8');

    const migration = await migrateLegacyWorkspaceAgentInstructions(workspacePath);

    assert.equal(migration.removed, true);
    await assert.rejects(
      fs.access(path.join(workspacePath, 'CLAUDE.md')),
      (error) => error?.code === 'ENOENT',
    );
  });
});

test('runtime migration preserves a customized root CLAUDE.md', async () => {
  await withWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, 'Agent.md'), '# Agent\n', 'utf8');
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), '# Custom\n', 'utf8');

    const migration = await migrateLegacyWorkspaceAgentInstructions(workspacePath);

    assert.equal(migration.removed, false);
    assert.equal(await fs.readFile(path.join(workspacePath, 'CLAUDE.md'), 'utf8'), '# Custom\n');
  });
});

test('rejects Agent.md symlinks without writing outside the workspace', async () => {
  await withWorkspace(async (workspacePath) => {
    const outsidePath = path.join(os.tmpdir(), `cloudcli-agent-outside-${Date.now()}.md`);
    try {
      await fs.writeFile(outsidePath, 'outside content', 'utf8');
      await fs.symlink(outsidePath, path.join(workspacePath, 'Agent.md'));

      await assert.rejects(
        writeWorkspaceAgentInstructions(workspacePath, '# Safe content\n'),
        (error) => error?.code === 'ELOOP',
      );

      assert.equal(await fs.readFile(outsidePath, 'utf8'), 'outside content');
      assert.equal((await fs.lstat(path.join(workspacePath, 'Agent.md'))).isSymbolicLink(), true);
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });
});

test('does not recreate a missing workspace directory', async () => {
  const missingPath = path.join(os.tmpdir(), `cloudcli-missing-workspace-${Date.now()}`);

  await assert.rejects(
    writeWorkspaceAgentInstructions(missingPath, '# Instructions\n'),
    (error) => error?.code === 'ENOENT',
  );
  await assert.rejects(fs.access(missingPath), (error) => error?.code === 'ENOENT');
});
