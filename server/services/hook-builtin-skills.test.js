import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deleteManagedBuiltinHookSkill,
  listBuiltinHookSkills,
  loadBuiltinHookSkill,
  saveManagedBuiltinHookSkill,
} from './hook-builtin-skills.js';

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-skills-'));
  const skillsRoot = path.join(root, 'legacy-packaged');
  const managedSkillsRoot = path.join(root, 'managed');
  const legacyDirectory = path.join(skillsRoot, 'hook-notification');
  await fs.mkdir(legacyDirectory, { recursive: true });
  await fs.writeFile(
    path.join(legacyDirectory, 'SKILL.md'),
    '---\nname: hook-notification\ndescription: Legacy packaged notification\n---\n\nNotify the user.\n',
    'utf8',
  );
  return { root, skillsRoot, managedSkillsRoot };
}

test('admin-uploaded Hook Skills are the only catalog source and load by built-in id', async () => {
  const fixture = await createFixture();
  try {
    const uploaded = await saveManagedBuiltinHookSkill({
      fileName: 'custom.md',
      fileBuffer: Buffer.from(
        '---\nname: audit-response\ndescription: Audit a Hook response\n---\n\nRecord the payload: $ARGUMENTS\n',
      ),
      managedSkillsRoot: fixture.managedSkillsRoot,
    });
    assert.equal(uploaded.skillId, 'builtin:audit-response');
    assert.equal(uploaded.source, 'uploaded');

    const listed = await listBuiltinHookSkills(fixture);
    assert.deepEqual(listed.map((skill) => [skill.skillId, skill.source]), [
      ['builtin:audit-response', 'uploaded'],
    ]);

    const loaded = await loadBuiltinHookSkill({
      skillId: 'builtin:audit-response',
      skillName: 'audit-response',
      ...fixture,
    });
    assert.equal(loaded.content, 'Record the payload: $ARGUMENTS\n');
    assert.equal(loaded.source, 'uploaded');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('admin uploads accept unrestricted Skill contents, names, and updates', async () => {
  const fixture = await createFixture();
  try {
    const unrestricted = await saveManagedBuiltinHookSkill({
      fileName: 'anything.bin',
      fileBuffer: Buffer.from('---\nname: Invalid_Name / 管理员\ndescription: 7\nversion: 9\ncustom: accepted\n---\nBody\n'),
      managedSkillsRoot: fixture.managedSkillsRoot,
    });
    assert.equal(unrestricted.skillId, 'builtin:Invalid_Name / 管理员');
    assert.equal(unrestricted.version, 9);

    const empty = await saveManagedBuiltinHookSkill({
      fileName: 'free form.txt',
      fileBuffer: Buffer.alloc(0),
      managedSkillsRoot: fixture.managedSkillsRoot,
    });
    assert.equal(empty.skillId, 'builtin:free form');
    assert.equal(empty.content, '');

    await saveManagedBuiltinHookSkill({
      fileName: 'notification.data',
      fileBuffer: Buffer.from('---\nname: hook-notification\n---\nAdmin override.\n'),
      managedSkillsRoot: fixture.managedSkillsRoot,
    });
    const listed = await listBuiltinHookSkills(fixture);
    const overridden = listed.find((skill) => skill.skillId === 'builtin:hook-notification');
    assert.equal(overridden.source, 'uploaded');
    assert.equal(overridden.content, 'Admin override.\n');

    const loaded = await loadBuiltinHookSkill({
      skillId: unrestricted.skillId,
      skillName: unrestricted.name,
      ...fixture,
    });
    assert.equal(loaded.content, 'Body\n');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('admin can delete every Hook Skill and deleted Skills have no packaged fallback', async () => {
  const fixture = await createFixture();
  try {
    await saveManagedBuiltinHookSkill({
      fileName: 'temporary.md',
      fileBuffer: Buffer.from('---\nname: temporary-notifier\n---\nTemporary.\n'),
      managedSkillsRoot: fixture.managedSkillsRoot,
    });
    await saveManagedBuiltinHookSkill({
      fileName: 'override.md',
      fileBuffer: Buffer.from('---\nname: hook-notification\n---\nOverride.\n'),
      managedSkillsRoot: fixture.managedSkillsRoot,
    });

    const deletedTemporary = await deleteManagedBuiltinHookSkill({
      skillId: 'builtin:temporary-notifier',
      managedSkillsRoot: fixture.managedSkillsRoot,
    });
    assert.equal(deletedTemporary.source, 'uploaded');
    assert.equal((await listBuiltinHookSkills(fixture)).some((skill) => (
      skill.skillId === 'builtin:temporary-notifier'
    )), false);

    await deleteManagedBuiltinHookSkill({
      skillId: 'builtin:hook-notification',
      managedSkillsRoot: fixture.managedSkillsRoot,
    });
    const packagedFallback = (await listBuiltinHookSkills(fixture)).find((skill) => (
      skill.skillId === 'builtin:hook-notification'
    ));
    assert.equal(packagedFallback, undefined);

    await assert.rejects(
      deleteManagedBuiltinHookSkill({
        skillId: 'builtin:hook-notification',
        managedSkillsRoot: fixture.managedSkillsRoot,
      }),
      /Uploaded Hook Skill not found/,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
