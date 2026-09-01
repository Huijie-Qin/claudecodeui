import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canEditSkillDetailEntries,
  filterWorkspaceSkills,
  getSkillDetailDisplayVersions,
  getSkillKindLabelKey,
  getSkillStatusLabelKey,
  sortWorkspaceSkills,
  type WorkspaceSkill,
} from './skillFormatting';

const skills: WorkspaceSkill[] = [
  {
    name: 'unmanaged-one',
    displayName: 'Runtime Navigator',
    description: 'Runtime folder skill',
    kind: 'unmanaged',
    status: 'available',
    enabled: true,
    manageable: false,
    sourceType: 'workspace-runtime',
    origin: 'local',
    createUserId: 'alice',
  },
  {
    name: 'managed-one',
    description: 'CloudCLI managed skill',
    kind: 'managed',
    status: 'enabled',
    enabled: true,
    manageable: true,
    sourceType: 'github',
    origin: 'market',
    createUserId: 'Bob Builder',
  },
  {
    name: 'broken-one',
    description: '',
    kind: 'unmanaged',
    status: 'invalid',
    enabled: true,
    manageable: false,
    sourceType: 'workspace-runtime',
    parseError: 'Invalid front matter',
    files: [{ path: 'references/only-in-file.md', type: 'file' }],
  },
];

test('sortWorkspaceSkills keeps managed skills first and invalid skills visible', () => {
  assert.deepEqual(sortWorkspaceSkills(skills).map((skill) => skill.name), [
    'managed-one',
    'broken-one',
    'unmanaged-one',
  ]);
});

test('filterWorkspaceSkills searches every local skill by name, display name, description, or creator', () => {
  assert.deepEqual(filterWorkspaceSkills(skills, 'cloudcli').map((skill) => skill.name), ['managed-one']);
  assert.deepEqual(filterWorkspaceSkills(skills, '  BROKEN-ONE  ').map((skill) => skill.name), ['broken-one']);
  assert.deepEqual(filterWorkspaceSkills(skills, 'navigator').map((skill) => skill.name), ['unmanaged-one']);
  assert.deepEqual(filterWorkspaceSkills(skills, 'runtime folder').map((skill) => skill.name), ['unmanaged-one']);
  assert.deepEqual(filterWorkspaceSkills(skills, 'bob builder').map((skill) => skill.name), ['managed-one']);
});

test('filterWorkspaceSkills does not match status, source, parse errors, or other metadata', () => {
  assert.deepEqual(filterWorkspaceSkills(skills, 'available'), []);
  assert.deepEqual(filterWorkspaceSkills(skills, 'workspace-runtime'), []);
  assert.deepEqual(filterWorkspaceSkills(skills, 'front matter'), []);
  assert.deepEqual(filterWorkspaceSkills(skills, 'market'), []);
  assert.deepEqual(filterWorkspaceSkills(skills, 'only-in-file'), []);
  assert.deepEqual(filterWorkspaceSkills(skills, 'runtime navigator runtime folder'), []);
});

test('skill label helpers return translation keys for kind and status', () => {
  assert.equal(getSkillKindLabelKey(skills[0]), 'skillsMarket.kind.unmanaged');
  assert.equal(getSkillKindLabelKey(skills[1]), 'skillsMarket.kind.managed');
  assert.equal(getSkillStatusLabelKey(skills[1]), 'skillsMarket.status.enabled');
  assert.equal(getSkillStatusLabelKey(skills[2]), 'skillsMarket.status.invalid');
});

test('getSkillDetailDisplayVersions prefers normalized version fields', () => {
  assert.deepEqual(getSkillDetailDisplayVersions({
    version: 2,
    marketVersion: 3,
    importedVersion: 1,
    localVersion: 2,
  }), {
    marketVersion: 3,
    localVersion: 2,
  });
});

test('getSkillDetailDisplayVersions falls back to compatible version fields', () => {
  assert.deepEqual(getSkillDetailDisplayVersions({ version: 3, importedVersion: 2 }), {
    marketVersion: 3,
    localVersion: 2,
  });
  assert.deepEqual(getSkillDetailDisplayVersions({}), {
    marketVersion: undefined,
    localVersion: undefined,
  });
});

test('all manageable skills opened from My Skills allow local file tree edits', () => {
  assert.equal(canEditSkillDetailEntries('mine', true), true);
  assert.equal(canEditSkillDetailEntries('mine', false), false);
  assert.equal(canEditSkillDetailEntries('market', true), false);
});
