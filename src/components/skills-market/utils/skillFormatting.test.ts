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
    description: 'Runtime folder skill',
    kind: 'unmanaged',
    status: 'available',
    enabled: true,
    manageable: false,
    sourceType: 'workspace-runtime',
  },
  {
    name: 'managed-one',
    description: 'CloudCLI managed skill',
    kind: 'managed',
    status: 'enabled',
    enabled: true,
    manageable: true,
    sourceType: 'github',
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
  },
];

test('sortWorkspaceSkills keeps managed skills first and invalid skills visible', () => {
  assert.deepEqual(sortWorkspaceSkills(skills).map((skill) => skill.name), [
    'managed-one',
    'broken-one',
    'unmanaged-one',
  ]);
});

test('filterWorkspaceSkills matches name, description, kind, status, and parse errors', () => {
  assert.deepEqual(filterWorkspaceSkills(skills, 'cloudcli').map((skill) => skill.name), ['managed-one']);
  assert.deepEqual(filterWorkspaceSkills(skills, 'unmanaged').map((skill) => skill.name), [
    'unmanaged-one',
    'broken-one',
  ]);
  assert.deepEqual(filterWorkspaceSkills(skills, 'front matter').map((skill) => skill.name), ['broken-one']);
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
