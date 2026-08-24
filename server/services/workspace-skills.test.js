import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import JSZip from 'jszip';

import {
  createWorkspaceSkill,
  createWorkspaceSkillEntry,
  deleteLocalWorkspaceSkill,
  deleteWorkspaceSkillEntry,
  getWorkspaceSkillDetail,
  installGithubSkill,
  listWorkspaceSkills,
  parseGithubSkillUrl,
  parseSkillManifest,
  previewGithubSkillInstall,
  previewLocalSkillUpload,
  reconcileManagedSkills,
  reconcileWorkspaceSkillsForAgentTurn,
  readSkillsMetadata,
  readWorkspaceSkillFile,
  renameWorkspaceSkillEntry,
  setSkillEnabled,
  uninstallManagedSkill,
  updateWorkspaceSkillFile,
  writeSkillsMetadata,
} from './workspace-skills.js';

async function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-workspace-skills-'));
}

async function writeSkill(root, name, content) {
  const skillDirectory = path.join(root, name);
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), content, 'utf8');
  return skillDirectory;
}

async function makeZip(entries) {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('readSkillsMetadata returns an empty v1 document when metadata is absent', async () => {
  const workspacePath = await makeWorkspace();

  assert.deepEqual(await readSkillsMetadata(workspacePath), {
    version: 1,
    skills: {},
  });
});

test('writeSkillsMetadata persists metadata atomically under the workspace cloudcli skills directory', async () => {
  const workspacePath = await makeWorkspace();
  const metadata = {
    version: 1,
    skills: {
      'grill-me': {
        name: 'grill-me',
        enabled: true,
        sourceType: 'github',
      },
    },
  };

  await writeSkillsMetadata(workspacePath, metadata);

  assert.deepEqual(await readSkillsMetadata(workspacePath), metadata);
});

test('parseGithubSkillUrl accepts only public GitHub HTTPS repository, tree, and archive URLs', () => {
  assert.deepEqual(parseGithubSkillUrl('https://github.com/acme/skills'), {
    owner: 'acme',
    repo: 'skills',
    ref: 'HEAD',
    sourceSubdir: '',
    normalizedUrl: 'https://github.com/acme/skills',
  });
  assert.deepEqual(parseGithubSkillUrl('https://github.com/acme/skills/tree/main/tools/grill-me'), {
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    sourceSubdir: 'tools/grill-me',
    normalizedUrl: 'https://github.com/acme/skills/tree/main/tools/grill-me',
  });
  assert.deepEqual(parseGithubSkillUrl('https://github.com/acme/skills/archive/refs/heads/main.zip'), {
    owner: 'acme',
    repo: 'skills',
    ref: 'refs/heads/main',
    sourceSubdir: '',
    normalizedUrl: 'https://github.com/acme/skills/archive/refs/heads/main.zip',
  });

  assert.throws(() => parseGithubSkillUrl('git@github.com:acme/skills.git'), /invalid/);
  assert.throws(() => parseGithubSkillUrl('https://token@github.com/acme/skills'), /must not include credentials/);
  assert.throws(() => parseGithubSkillUrl('https://example.com/acme/skills'), /Only https:\/\/github.com/);
});

test('parseSkillManifest reads front matter and falls back to heading plus first paragraph', async () => {
  const workspacePath = await makeWorkspace();
  const frontMatterDir = await writeSkill(
    workspacePath,
    'front-matter',
    [
      '---',
      'name: front-matter',
      'description: Uses the manifest description.',
      '---',
      '',
      '# Ignored Heading',
    ].join('\n'),
  );
  const fallbackDir = await writeSkill(
    workspacePath,
    'fallback',
    ['# Fallback Skill', '', 'First useful paragraph.', '', 'Second paragraph.'].join('\n'),
  );

  assert.deepEqual(await parseSkillManifest(frontMatterDir), {
    name: 'front-matter',
    description: 'Uses the manifest description.',
    manifestPath: path.join(frontMatterDir, 'SKILL.md'),
    status: 'valid',
  });
  assert.deepEqual(await parseSkillManifest(fallbackDir), {
    name: 'Fallback Skill',
    description: 'First useful paragraph.',
    manifestPath: path.join(fallbackDir, 'SKILL.md'),
    status: 'valid',
  });
});

test('listWorkspaceSkills classifies managed, unmanaged, and system skills', async () => {
  const workspacePath = await makeWorkspace();
  const sourceRoot = path.join(workspacePath, '.cloudcli', 'skills', 'sources');
  const runtimeRoot = path.join(workspacePath, '.claude', 'skills');

  await writeSkill(sourceRoot, 'managed-one', [
    '---',
    'name: managed-one',
    'description: Managed by CloudCLI.',
    '---',
  ].join('\n'));
  await writeSkill(sourceRoot, 'disabled-one', [
    '# Disabled One',
    '',
    'Disabled by metadata.',
  ].join('\n'));
  await writeSkill(runtimeRoot, 'managed-one', '# Materialized copy');
  await writeSkill(runtimeRoot, 'unmanaged-one', [
    '# Unmanaged One',
    '',
    'Created directly in the runtime skills folder.',
  ].join('\n'));
  await writeSkillsMetadata(workspacePath, {
    version: 1,
    skills: {
      'managed-one': {
        name: 'managed-one',
        enabled: true,
        sourceType: 'github',
        sourceUrl: 'https://github.com/example/skills/tree/main/managed-one',
        resolvedCommit: '0123456789abcdef0123456789abcdef01234567',
        sourceSubdir: 'skills/managed-one',
        managedBy: 'cloudcli',
      },
      'disabled-one': {
        name: 'disabled-one',
        enabled: false,
        sourceType: 'github',
        managedBy: 'cloudcli',
      },
    },
  });

  const result = await listWorkspaceSkills(workspacePath, [
    {
      name: 'bundled-toolsmith',
      description: 'Bundled helper skill.',
      sourceType: 'bundled',
    },
  ]);

  assert.deepEqual(result.summary, {
    total: 4,
    managed: 2,
    unmanaged: 1,
    system: 1,
    enabled: 1,
    disabled: 1,
    invalid: 0,
    market: 0,
    local: 2,
  });
  assert.deepEqual(
    result.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      kind: skill.kind,
      status: skill.status,
      enabled: skill.enabled,
      manageable: skill.manageable,
      sourceType: skill.sourceType,
    })),
    [
      {
        name: 'disabled-one',
        description: 'Disabled by metadata.',
        kind: 'managed',
        status: 'disabled',
        enabled: false,
        manageable: true,
        sourceType: 'github',
      },
      {
        name: 'managed-one',
        description: 'Managed by CloudCLI.',
        kind: 'managed',
        status: 'enabled',
        enabled: true,
        manageable: true,
        sourceType: 'github',
      },
      {
        name: 'unmanaged-one',
        description: 'Created directly in the runtime skills folder.',
        kind: 'unmanaged',
        status: 'available',
        enabled: true,
        manageable: true,
        sourceType: 'workspace-runtime',
      },
      {
        name: 'bundled-toolsmith',
        description: 'Bundled helper skill.',
        kind: 'system',
        status: 'available',
        enabled: true,
        manageable: false,
        sourceType: 'bundled',
      },
    ],
  );
});

test('listWorkspaceSkills classifies runtime skills from market import records', async () => {
  const workspacePath = await makeWorkspace();
  const runtimeRoot = path.join(workspacePath, '.claude', 'skills');
  await writeSkill(runtimeRoot, 'market-skill', '---\nname: market-skill\ndescription: Market copy.\n---\n');
  await writeSkill(runtimeRoot, 'local-skill', '---\nname: local-skill\ndescription: Local copy.\n---\n');

  const inventory = await listWorkspaceSkills(workspacePath, [], [{
    name: 'market-skill',
    skillId: 'remote-one',
    version: 3,
    createUserId: 'alice',
  }]);

  assert.equal(inventory.summary.market, 1);
  assert.equal(inventory.summary.local, 1);
  assert.deepEqual(
    inventory.skills.map((skill) => ({ name: skill.name, origin: skill.origin, manageable: skill.manageable })),
    [
      { name: 'local-skill', origin: 'local', manageable: true },
      { name: 'market-skill', origin: 'market', manageable: false },
    ],
  );
  assert.equal(inventory.skills.find((skill) => skill.name === 'market-skill').localVersion, 3);
});

test('local workspace skill file operations preserve SKILL.md and revision safety', async () => {
  const workspacePath = await makeWorkspace();
  await createWorkspaceSkill({
    workspacePath,
    name: 'local-skill',
    displayName: 'Local Skill',
    description: 'Created in the workspace.',
  });
  await createWorkspaceSkillEntry({
    workspacePath,
    name: 'local-skill',
    entryPath: 'references',
    entryType: 'directory',
  });
  await createWorkspaceSkillEntry({
    workspacePath,
    name: 'local-skill',
    entryPath: 'references/notes.md',
    entryType: 'file',
    content: '# Notes\n',
  });

  const original = await readWorkspaceSkillFile({
    workspacePath,
    name: 'local-skill',
    filePath: 'references/notes.md',
  });
  const updated = await updateWorkspaceSkillFile({
    workspacePath,
    name: 'local-skill',
    filePath: 'references/notes.md',
    content: '# Updated\n',
    revision: original.revision,
  });
  assert.equal(updated.content, '# Updated\n');
  await assert.rejects(
    updateWorkspaceSkillFile({
      workspacePath,
      name: 'local-skill',
      filePath: 'references/notes.md',
      content: '# Stale\n',
      revision: original.revision,
    }),
    /changed on disk/,
  );

  await renameWorkspaceSkillEntry({
    workspacePath,
    name: 'local-skill',
    entryPath: 'references/notes.md',
    nextPath: 'references/guide.md',
  });
  await deleteWorkspaceSkillEntry({
    workspacePath,
    name: 'local-skill',
    entryPath: 'references/guide.md',
  });
  await assert.rejects(
    deleteWorkspaceSkillEntry({ workspacePath, name: 'local-skill', entryPath: 'SKILL.md' }),
    /cannot be deleted/,
  );

  const detail = await getWorkspaceSkillDetail({ workspacePath, name: 'local-skill' });
  assert.deepEqual(detail.files.map((entry) => entry.path), ['references', 'SKILL.md']);
  await deleteLocalWorkspaceSkill({ workspacePath, name: 'local-skill' });
  await assert.rejects(getWorkspaceSkillDetail({ workspacePath, name: 'local-skill' }), /was not found/);
});

test('market-installed workspace skills reject local file mutations', async () => {
  const workspacePath = await makeWorkspace();
  await writeSkill(
    path.join(workspacePath, '.claude', 'skills'),
    'market-skill',
    '---\nname: market-skill\ndescription: Market copy.\n---\n',
  );
  const marketImports = [{ name: 'market-skill', skillId: 'remote-one', version: 1 }];

  await assert.rejects(
    updateWorkspaceSkillFile({
      workspacePath,
      name: 'market-skill',
      filePath: 'SKILL.md',
      content: 'changed',
      marketImports,
    }),
    (error) => error.statusCode === 403 && /read-only/.test(error.message),
  );
  await assert.rejects(
    deleteLocalWorkspaceSkill({ workspacePath, name: 'market-skill', marketImports }),
    (error) => error.statusCode === 403,
  );
});

test('listWorkspaceSkills keeps invalid runtime skills visible with a parse error', async () => {
  const workspacePath = await makeWorkspace();
  await writeSkill(path.join(workspacePath, '.claude', 'skills'), 'broken-skill', [
    '---',
    'name: [broken',
    '---',
    '',
    '# Broken',
  ].join('\n'));

  const result = await listWorkspaceSkills(workspacePath);

  assert.equal(result.summary.invalid, 1);
  assert.equal(result.skills[0].name, 'broken-skill');
  assert.equal(result.skills[0].status, 'invalid');
  assert.equal(result.skills[0].kind, 'unmanaged');
  assert.match(result.skills[0].parseError, /end of the stream|missed comma|bad indentation/i);
});

test('listWorkspaceSkills keeps repeated invalid manifest reads invalid', async () => {
  const workspacePath = await makeWorkspace();
  await writeSkill(path.join(workspacePath, '.claude', 'skills'), 'broken-skill', [
    '---',
    'name: [broken',
    '---',
    '',
    '# Broken',
  ].join('\n'));

  const first = await listWorkspaceSkills(workspacePath);
  const second = await listWorkspaceSkills(workspacePath);

  assert.equal(first.summary.invalid, 1);
  assert.equal(second.summary.invalid, 1);
  assert.equal(second.skills[0].status, 'invalid');
  assert.match(second.skills[0].parseError, /end of the stream|missed comma|bad indentation/i);
});

test('previewGithubSkillInstall stores a pinned preview for one selected public GitHub skill', async () => {
  const workspacePath = await makeWorkspace();
  const archive = await makeZip({
    'repo-main/skills/grill-me/SKILL.md': [
      '---',
      'name: grill-me',
      'description: Stress-test a plan.',
      '---',
    ].join('\n'),
    'repo-main/skills/grill-me/references/checklist.md': 'Questions',
  });

  const preview = await previewGithubSkillInstall({
    url: 'https://github.com/acme/skills/tree/main/skills/grill-me',
    workspacePath,
    resolveCommit: async ({ owner, repo, ref }) => {
      assert.deepEqual({ owner, repo, ref }, { owner: 'acme', repo: 'skills', ref: 'main' });
      return '0123456789abcdef0123456789abcdef01234567';
    },
    downloadArchive: async () => archive,
    idFactory: () => 'preview-one',
    now: () => new Date('2026-05-05T00:00:00.000Z'),
  });

  assert.deepEqual(preview, {
    previewId: 'preview-one',
    name: 'grill-me',
    displayName: 'grill-me',
    description: 'Stress-test a plan.',
    files: ['SKILL.md', 'references/checklist.md'],
    sourceType: 'github',
    sourceUrl: 'https://github.com/acme/skills/tree/0123456789abcdef0123456789abcdef01234567/skills/grill-me',
    requestedUrl: 'https://github.com/acme/skills/tree/main/skills/grill-me',
    resolvedCommit: '0123456789abcdef0123456789abcdef01234567',
    sourceSubdir: 'skills/grill-me',
    conflict: { type: 'none', blocking: false },
    createdAt: '2026-05-05T00:00:00.000Z',
  });
  assert.equal(
    await fs.readFile(path.join(workspacePath, '.cloudcli', 'skills', 'previews', 'preview-one', 'skill', 'SKILL.md'), 'utf8'),
    ['---', 'name: grill-me', 'description: Stress-test a plan.', '---'].join('\n'),
  );
});

test('previewGithubSkillInstall rejects ambiguous repositories and unmanaged name conflicts', async () => {
  const workspacePath = await makeWorkspace();
  const ambiguousArchive = await makeZip({
    'repo-main/skills/one/SKILL.md': '# One',
    'repo-main/skills/two/SKILL.md': '# Two',
  });

  await assert.rejects(
    previewGithubSkillInstall({
      url: 'https://github.com/acme/skills',
      workspacePath,
      resolveCommit: async () => '0123456789abcdef0123456789abcdef01234567',
      downloadArchive: async () => ambiguousArchive,
    }),
    /exactly one skill directory/,
  );

  await writeSkill(path.join(workspacePath, '.claude', 'skills'), 'grill-me', '# Existing unmanaged');
  const conflictArchive = await makeZip({
    'repo-main/grill-me/SKILL.md': [
      '---',
      'name: grill-me',
      'description: New managed version.',
      '---',
    ].join('\n'),
  });
  const preview = await previewGithubSkillInstall({
    url: 'https://github.com/acme/skills/tree/main/grill-me',
    workspacePath,
    resolveCommit: async () => '0123456789abcdef0123456789abcdef01234567',
    downloadArchive: async () => conflictArchive,
    idFactory: () => 'preview-conflict',
  });

  assert.deepEqual(preview.conflict, { type: 'unmanaged', blocking: true });
});

test('previewLocalSkillUpload extracts a single uploaded skill archive into a reusable preview', async () => {
  const workspacePath = await makeWorkspace();
  const archiveBuffer = await makeZip({
    'local-skill/SKILL.md': [
      '---',
      'name: local-skill',
      'description: Uploaded from a local zip.',
      '---',
    ].join('\n'),
    'local-skill/scripts/run.sh': 'echo ok\n',
  });

  const preview = await previewLocalSkillUpload({
    workspacePath,
    archiveBuffer,
    originalName: 'local-skill.zip',
    now: () => new Date('2026-05-05T12:00:00.000Z'),
    idFactory: () => 'local-preview-one',
  });

  assert.deepEqual(preview, {
    previewId: 'local-preview-one',
    name: 'local-skill',
    displayName: 'local-skill',
    description: 'Uploaded from a local zip.',
    files: ['SKILL.md', 'scripts/run.sh'],
    sourceType: 'local-upload',
    sourceFileName: 'local-skill.zip',
    conflict: { type: 'none', blocking: false },
    createdAt: '2026-05-05T12:00:00.000Z',
  });
});

test('previewLocalSkillUpload accepts relaxed skill names', async () => {
  const workspacePath = await makeWorkspace();
  const archiveBuffer = await makeZip({
    'relaxed-name/SKILL.md': [
      '---',
      'name: 1 local.skill_',
      'description: Uses a relaxed skill name.',
      '---',
    ].join('\n'),
  });

  const preview = await previewLocalSkillUpload({
    workspacePath,
    archiveBuffer,
    originalName: 'relaxed-name.zip',
    idFactory: () => 'relaxed-preview',
  });

  assert.equal(preview.name, '1 local.skill_');
  assert.equal(preview.displayName, '1 local.skill_');

  await installGithubSkill({
    workspacePath,
    previewId: 'relaxed-preview',
  });
  assert.equal(
    await fs.readFile(path.join(workspacePath, '.claude', 'skills', '1 local.skill_', 'SKILL.md'), 'utf8'),
    ['---', 'name: 1 local.skill_', 'description: Uses a relaxed skill name.', '---'].join('\n'),
  );
});

test('installGithubSkill copies source, writes metadata, and materializes enabled skills', async () => {
  const workspacePath = await makeWorkspace();
  const archive = await makeZip({
    'repo-main/grill-me/SKILL.md': [
      '---',
      'name: grill-me',
      'description: Stress-test a plan.',
      '---',
    ].join('\n'),
    'repo-main/grill-me/references/checklist.md': 'Questions',
  });

  await previewGithubSkillInstall({
    url: 'https://github.com/acme/skills/tree/main/grill-me',
    workspacePath,
    resolveCommit: async () => '0123456789abcdef0123456789abcdef01234567',
    downloadArchive: async () => archive,
    idFactory: () => 'preview-install',
    now: () => new Date('2026-05-05T00:00:00.000Z'),
  });
  const skill = await installGithubSkill({
    workspacePath,
    previewId: 'preview-install',
    enable: true,
    now: () => new Date('2026-05-05T00:10:00.000Z'),
  });

  assert.equal(skill.name, 'grill-me');
  assert.equal(skill.status, 'enabled');
  assert.equal(await fs.readFile(path.join(workspacePath, '.cloudcli', 'skills', 'sources', 'grill-me', 'references', 'checklist.md'), 'utf8'), 'Questions');
  assert.equal(await fs.readFile(path.join(workspacePath, '.claude', 'skills', 'grill-me', 'references', 'checklist.md'), 'utf8'), 'Questions');
  assert.deepEqual(await readSkillsMetadata(workspacePath), {
    version: 1,
    skills: {
      'grill-me': {
        name: 'grill-me',
        description: 'Stress-test a plan.',
        enabled: true,
        sourceType: 'github',
        sourceUrl: 'https://github.com/acme/skills/tree/0123456789abcdef0123456789abcdef01234567/grill-me',
        resolvedCommit: '0123456789abcdef0123456789abcdef01234567',
        sourceSubdir: 'grill-me',
        installedAt: '2026-05-05T00:10:00.000Z',
        updatedAt: '2026-05-05T00:10:00.000Z',
        managedBy: 'cloudcli',
      },
    },
  });
});

test('installGithubSkill installs local-upload previews with local source metadata', async () => {
  const workspacePath = await makeWorkspace();
  const archiveBuffer = await makeZip({
    'local-skill/SKILL.md': [
      '---',
      'name: local-skill',
      'description: Uploaded from a local zip.',
      '---',
    ].join('\n'),
  });

  await previewLocalSkillUpload({
    workspacePath,
    archiveBuffer,
    originalName: 'local-skill.zip',
    idFactory: () => 'local-preview-one',
  });

  const installed = await installGithubSkill({
    workspacePath,
    previewId: 'local-preview-one',
    enable: true,
    now: () => new Date('2026-05-05T12:00:00.000Z'),
  });

  assert.equal(installed.name, 'local-skill');
  assert.equal(installed.status, 'enabled');
  assert.equal(installed.sourceType, 'local-upload');
  assert.equal(installed.sourceFileName, 'local-skill.zip');

  const metadata = await readSkillsMetadata(workspacePath);
  assert.equal(metadata.skills['local-skill'].sourceType, 'local-upload');
  assert.equal(metadata.skills['local-skill'].sourceFileName, 'local-skill.zip');
  assert.equal(
    await fs.readFile(path.join(workspacePath, '.claude', 'skills', 'local-skill', 'SKILL.md'), 'utf8'),
    ['---', 'name: local-skill', 'description: Uploaded from a local zip.', '---'].join('\n'),
  );
});

test('installGithubSkill blocks unmanaged conflicts before writing runtime config', async () => {
  const workspacePath = await makeWorkspace();
  const archive = await makeZip({
    'repo-main/grill-me/SKILL.md': [
      '---',
      'name: grill-me',
      'description: Stress-test a plan.',
      '---',
    ].join('\n'),
  });

  await previewGithubSkillInstall({
    url: 'https://github.com/acme/skills/tree/main/grill-me',
    workspacePath,
    resolveCommit: async () => '0123456789abcdef0123456789abcdef01234567',
    downloadArchive: async () => archive,
    idFactory: () => 'preview-blocked',
  });
  await writeSkill(path.join(workspacePath, '.claude', 'skills'), 'grill-me', '# Existing unmanaged');

  await assert.rejects(
    installGithubSkill({ workspacePath, previewId: 'preview-blocked' }),
    /already exists as an unmanaged runtime skill/,
  );
  assert.deepEqual(await readSkillsMetadata(workspacePath), { version: 1, skills: {} });
});

test('setSkillEnabled materializes and removes only managed runtime copies', async () => {
  const workspacePath = await makeWorkspace();
  const sourceRoot = path.join(workspacePath, '.cloudcli', 'skills', 'sources');
  const runtimeRoot = path.join(workspacePath, '.claude', 'skills');
  await writeSkill(sourceRoot, 'grill-me', [
    '---',
    'name: grill-me',
    'description: Stress-test a plan.',
    '---',
  ].join('\n'));
  await writeSkillsMetadata(workspacePath, {
    version: 1,
    skills: {
      'grill-me': {
        name: 'grill-me',
        enabled: false,
        sourceType: 'github',
        sourceUrl: 'https://github.com/acme/skills/tree/main/grill-me',
        resolvedCommit: '0123456789abcdef0123456789abcdef01234567',
        managedBy: 'cloudcli',
      },
    },
  });

  const enabled = await setSkillEnabled({
    workspacePath,
    name: 'grill-me',
    enabled: true,
    now: () => new Date('2026-05-05T01:00:00.000Z'),
  });
  assert.equal(enabled.status, 'enabled');
  assert.equal(await fs.readFile(path.join(runtimeRoot, 'grill-me', 'SKILL.md'), 'utf8'), [
    '---',
    'name: grill-me',
    'description: Stress-test a plan.',
    '---',
  ].join('\n'));

  const disabled = await setSkillEnabled({
    workspacePath,
    name: 'grill-me',
    enabled: false,
    now: () => new Date('2026-05-05T01:10:00.000Z'),
  });
  assert.equal(disabled.status, 'disabled');
  await assert.rejects(fs.access(path.join(runtimeRoot, 'grill-me')), /ENOENT/);
  assert.equal((await readSkillsMetadata(workspacePath)).skills['grill-me'].enabled, false);
});

test('uninstallManagedSkill deletes metadata, source, and materialized runtime copy', async () => {
  const workspacePath = await makeWorkspace();
  const sourceRoot = path.join(workspacePath, '.cloudcli', 'skills', 'sources');
  const runtimeRoot = path.join(workspacePath, '.claude', 'skills');
  await writeSkill(sourceRoot, 'grill-me', '# Grill Me');
  await writeSkill(runtimeRoot, 'grill-me', '# Grill Me');
  await writeSkillsMetadata(workspacePath, {
    version: 1,
    skills: {
      'grill-me': {
        name: 'grill-me',
        enabled: true,
        sourceType: 'github',
        managedBy: 'cloudcli',
      },
    },
  });

  await uninstallManagedSkill({ workspacePath, name: 'grill-me' });

  assert.deepEqual(await readSkillsMetadata(workspacePath), { version: 1, skills: {} });
  await assert.rejects(fs.access(path.join(sourceRoot, 'grill-me')), /ENOENT/);
  await assert.rejects(fs.access(path.join(runtimeRoot, 'grill-me')), /ENOENT/);
});

test('reconcileManagedSkills is idempotent and never deletes unmanaged runtime skills', async () => {
  const workspacePath = await makeWorkspace();
  const sourceRoot = path.join(workspacePath, '.cloudcli', 'skills', 'sources');
  const runtimeRoot = path.join(workspacePath, '.claude', 'skills');
  await writeSkill(sourceRoot, 'enabled-one', '# Enabled One');
  await writeSkill(sourceRoot, 'disabled-one', '# Disabled One');
  await writeSkill(runtimeRoot, 'disabled-one', '# Stale managed copy');
  await writeSkill(runtimeRoot, 'unmanaged-one', '# Unmanaged One');
  await writeSkillsMetadata(workspacePath, {
    version: 1,
    skills: {
      'enabled-one': {
        name: 'enabled-one',
        enabled: true,
        sourceType: 'github',
        managedBy: 'cloudcli',
      },
      'disabled-one': {
        name: 'disabled-one',
        enabled: false,
        sourceType: 'github',
        managedBy: 'cloudcli',
      },
    },
  });

  const first = await reconcileManagedSkills(workspacePath);
  const second = await reconcileManagedSkills(workspacePath);

  assert.deepEqual(first, {
    materialized: ['enabled-one'],
    removed: ['disabled-one'],
    failures: [],
  });
  assert.deepEqual(second, {
    materialized: ['enabled-one'],
    removed: ['disabled-one'],
    failures: [],
  });
  assert.equal(await fs.readFile(path.join(runtimeRoot, 'enabled-one', 'SKILL.md'), 'utf8'), '# Enabled One');
  await assert.rejects(fs.access(path.join(runtimeRoot, 'disabled-one')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(runtimeRoot, 'unmanaged-one', 'SKILL.md'), 'utf8'), '# Unmanaged One');
});

test('reconcileWorkspaceSkillsForAgentTurn fails closed when reconcile reports failures', async () => {
  const logged = [];

  await assert.rejects(
    reconcileWorkspaceSkillsForAgentTurn({
      workspacePath: '/tmp/workspace',
      reconcile: async () => ({
        materialized: ['ok-skill'],
        removed: [],
        failures: [{ name: 'broken-skill', error: 'source missing' }],
      }),
      logger: {
        error: (...args) => logged.push(args),
      },
    }),
    (error) => {
      assert.equal(error.code, 'WORKSPACE_SKILLS_RECONCILE_FAILED');
      assert.deepEqual(error.failures, [{ name: 'broken-skill', error: 'source missing' }]);
      return true;
    },
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1].workspacePath, '/tmp/workspace');
  assert.equal(logged[0][1].skillName, 'broken-skill');
});
