import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import express from 'express';

const execFileAsync = promisify(execFile);

test('user-created projects do not inherit tenant Skill presets', async (t) => {
  // Use a dedicated directory under the user root: /tmp is deliberately forbidden
  // by the real project-creation route on platforms where os.tmpdir() is /tmp.
  const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), '.cloudcli-preinstall-test-')));
  const previousRoot = process.env.WORKSPACES_ROOT;
  process.env.WORKSPACES_ROOT = workspaceRoot;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
    else process.env.WORKSPACES_ROOT = previousRoot;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  // Import after setting WORKSPACES_ROOT; production routes capture it at load time.
  const [
    { default: router },
    { multitenancyDb },
    { skillPresetService },
    { agentTemplateService },
  ] = await Promise.all([
    import('./projects.js'),
    import('../database/multitenancy-db.js'),
    import('../services/skill-presets.js'),
    import('../services/agent-templates.js'),
  ]);
  const tenant = { id: 13, code: 'test-tenant', name: 'Test Tenant' };
  const user = { id: 7, username: 'test-user' };
  const workspaces = [];
  const installed = [];
  const snapshots = [];
  const templateSkill = { id: 22, tenantId: tenant.id, name: 'template-selected' };
  t.mock.method(multitenancyDb.tenants, 'getTenantById', () => tenant);
  t.mock.method(multitenancyDb.memberships, 'getActiveMembership', () => ({ permission: 'edit' }));
  t.mock.method(multitenancyDb.workspaces, 'createWorkspace', (input) => {
    const workspace = {
      id: workspaces.length + 1,
      tenant_id: input.tenantId,
      owner_user_id: input.ownerUserId,
      slug: input.slug,
      display_name: input.displayName,
      path: input.path,
    };
    workspaces.push(workspace);
    return workspace;
  });
  t.mock.method(multitenancyDb.skillPresetInstalls, 'listInstallsForWorkspace', () => []);
  const preinstall = t.mock.method(skillPresetService, 'installPreinstalledSkillPresets', async ({ workspacePath }) => {
    // The marker makes any accidental preinstallation visible both in call counts
    // and on disk, even when a caller swallows an installation failure.
    const skillPath = path.join(workspacePath, '.claude', 'skills', 'tenant-default');
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), 'Tenant default Skill.\n');
    return { installed: [{ skillName: 'tenant-default' }], errors: [] };
  });
  t.mock.method(skillPresetService, 'installWorkspaceSkillPreset', async (input) => {
    installed.push(input);
    assert.equal(input.presetId, templateSkill.id);
    const skillPath = path.join(input.workspacePath, '.claude', 'skills', templateSkill.name);
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), 'Explicitly selected template Skill.\n');
    return { installed: { skillName: templateSkill.name } };
  });
  t.mock.method(agentTemplateService, 'resolveTemplateSnapshot', ({ templateId }) => ({
    template: { id: templateId, name: 'Test template', claudeMarkdown: 'Template memory.', guideText: 'Welcome.' },
    skills: [templateSkill],
    mcps: [],
    hooks: [],
  }));
  t.mock.method(agentTemplateService, 'saveWorkspaceSnapshot', (input) => snapshots.push(input));

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/api/projects', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
  const createProject = async (body) => {
    const response = await fetch(`${baseUrl}/create-workspace?tenantId=${tenant.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.success, true);
    assert.equal(preinstall.mock.callCount(), 0);
    return payload;
  };
  const skillNames = async (workspacePath) => fs.readdir(path.join(workspacePath, '.claude', 'skills'))
    .catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });

  // Clone entirely locally, preserving a repository's own Skill without adding
  // tenant defaults. No external repository, account, or network is needed.
  const repositoryPath = path.join(workspaceRoot, 'source-repository');
  await fs.mkdir(path.join(repositoryPath, '.claude', 'skills', 'repository-owned'), { recursive: true });
  await fs.writeFile(path.join(repositoryPath, '.claude', 'skills', 'repository-owned', 'SKILL.md'), 'Repository-owned Skill.\n');
  await execFileAsync('git', ['init', '--quiet', repositoryPath]);
  await execFileAsync('git', ['-C', repositoryPath, 'add', '.']);
  await execFileAsync('git', [
    '-C', repositoryPath, '-c', 'user.name=Skill regression test',
    '-c', 'user.email=skill-regression@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Local fixture',
  ]);

  await t.test('blank project remains free of preset Skills', async () => {
    const payload = await createProject({ workspaceType: 'new', path: 'blank-project' });
    assert.deepEqual(await skillNames(payload.project.path), []);
    assert.equal(payload.agentTemplate, null);
    assert.deepEqual(installed, []);
  });

  await t.test('import preserves existing Skills without adding tenant presets', async () => {
    const existingPath = path.join(workspaceRoot, 'existing-project');
    const existingSkillPath = path.join(existingPath, '.claude', 'skills', 'user-owned', 'SKILL.md');
    await fs.mkdir(path.dirname(existingSkillPath), { recursive: true });
    await fs.writeFile(existingSkillPath, 'Keep my instructions.\n');
    const payload = await createProject({ workspaceType: 'existing', path: existingPath });
    assert.deepEqual(await skillNames(payload.project.path), ['user-owned']);
    assert.equal(await fs.readFile(existingSkillPath, 'utf8'), 'Keep my instructions.\n');
  });

  await t.test('cloned project retains repository Skills only', async () => {
    const payload = await createProject({ workspaceType: 'new', path: 'cloned-project', githubUrl: repositoryPath });
    assert.deepEqual(await skillNames(payload.project.path), ['repository-owned']);
    assert.equal(payload.agentTemplate, null);
  });

  await t.test('streaming clone does not bypass the no-preinstallation rule', async () => {
    const query = new URLSearchParams({ tenantId: String(tenant.id), path: 'streamed-project', githubUrl: repositoryPath });
    const response = await fetch(`${baseUrl}/clone-progress?${query}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split('\n\n').filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    assert.equal(events.some((event) => event.type === 'error'), false, JSON.stringify(events));
    const completed = events.find((event) => event.type === 'complete');
    assert.ok(completed, JSON.stringify(events));
    assert.deepEqual(await skillNames(completed.project.path), ['repository-owned']);
    assert.equal(preinstall.mock.callCount(), 0);
  });

  await t.test('template project receives only the explicitly selected template Skill', async () => {
    const payload = await createProject({ workspaceType: 'new', path: 'template-project', templateId: 31 });
    assert.deepEqual(await skillNames(payload.project.path), ['template-selected']);
    assert.equal(payload.agentTemplate.id, 31);
    assert.deepEqual(snapshots.at(-1).snapshot.skills, [templateSkill]);
    assert.equal(await fs.readFile(path.join(payload.project.path, 'CLAUDE.md'), 'utf8'), 'Template memory.\n');
  });

  await t.test('template clone adds selected Skills but no tenant presets', async () => {
    const payload = await createProject({ workspaceType: 'new', path: 'template-clone', githubUrl: repositoryPath, templateId: 31 });
    assert.deepEqual((await skillNames(payload.project.path)).sort(), ['repository-owned', 'template-selected']);
    assert.equal(payload.agentTemplate.id, 31);
    assert.equal(preinstall.mock.callCount(), 0);
    assert.equal(installed.length, 2);
    assert.equal(snapshots.length, 2);
  });
});
