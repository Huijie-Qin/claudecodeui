import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeWorkspaceTemplateFolders } from '../services/agent-template-folders.js';

import { applyAgentTemplateToWorkspace } from './projects.js';

test('folder installation conflicts remove failed new workspaces while preserving pre-existing directories', async () => {
  for (const removeDirectoryOnFailure of [true, false]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-template-rollback-'));
    try {
      const workspacePath = path.join(root, 'workspace');
      await fs.mkdir(path.join(workspacePath, '.claude/rules'), { recursive: true });
      await fs.writeFile(path.join(workspacePath, '.claude/rules/existing.md'), 'keep');
      const deleted = [];
      await assert.rejects(applyAgentTemplateToWorkspace({
        templateId: 1,
        tenant: { id: 2 },
        workspace: { id: 3, path: workspacePath },
        user: { id: 4 },
        removeDirectoryOnFailure,
        workspaceStore: { markDeleted: (input) => deleted.push(input.workspaceId) },
        applyTemplate: ({ workspace }) => writeWorkspaceTemplateFolders(workspace.path, [{
          name: 'rules', directories: [], files: [{ path: 'existing.md', contentBase64: 'aGVsbG8=' }],
        }]),
      }), { statusCode: 409 });
      assert.deepEqual(deleted, [3]);
      if (removeDirectoryOnFailure) {
        await assert.rejects(fs.access(workspacePath), { code: 'ENOENT' });
      } else {
        assert.equal(await fs.readFile(path.join(workspacePath, '.claude/rules/existing.md'), 'utf8'), 'keep');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('successful templates and no-template workspaces do not invoke failure cleanup', async () => {
  const calls = [];
  const options = {
    templateId: 1, tenant: { id: 2 }, workspace: { id: 3 }, user: { id: 4 },
    workspaceStore: { markDeleted: () => { throw new Error('unexpected cleanup'); } },
    applyTemplate: async (input) => { calls.push(input.templateId); return { id: 1, name: 'Template' }; },
  };
  assert.deepEqual(await applyAgentTemplateToWorkspace(options), { id: 1, name: 'Template' });
  assert.equal(await applyAgentTemplateToWorkspace({ ...options, templateId: null }), null);
  assert.deepEqual(calls, [1]);
});
