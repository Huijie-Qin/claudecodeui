import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSkillFileLink, resolveWorkspaceSkillFileLink } from './skillMarkdownLinks';

const files = [
  { path: 'SKILL.md', type: 'file' },
  { path: 'references/checklist.md', type: 'file' },
  { path: 'references/nested/notes.md', type: 'file' },
  { path: 'assets/example image.png', type: 'file' },
  { path: 'references', type: 'directory' },
];

test('resolves skill-root and current-directory Markdown links', () => {
  assert.equal(resolveSkillFileLink('references/checklist.md', 'SKILL.md', files), 'references/checklist.md');
  assert.equal(resolveSkillFileLink('./nested/notes.md', 'references/checklist.md', files), 'references/nested/notes.md');
  assert.equal(resolveSkillFileLink('../SKILL.md', 'references/checklist.md', files), 'SKILL.md');
  assert.equal(resolveSkillFileLink('/references/checklist.md', 'SKILL.md', files), 'references/checklist.md');
});

test('strips query, fragment, and URL encoding before matching a skill file', () => {
  assert.equal(resolveSkillFileLink('references/checklist.md#steps', 'SKILL.md', files), 'references/checklist.md');
  assert.equal(resolveSkillFileLink('assets/example%20image.png?raw=1', 'SKILL.md', files), 'assets/example image.png');
});

test('keeps external, fragment-only, missing, directory, and escaping links in the browser', () => {
  assert.equal(resolveSkillFileLink('https://example.com/docs', 'SKILL.md', files), null);
  assert.equal(resolveSkillFileLink('//example.com/docs', 'SKILL.md', files), null);
  assert.equal(resolveSkillFileLink('mailto:hello@example.com', 'SKILL.md', files), null);
  assert.equal(resolveSkillFileLink('#usage', 'SKILL.md', files), null);
  assert.equal(resolveSkillFileLink('missing.md', 'SKILL.md', files), null);
  assert.equal(resolveSkillFileLink('references', 'SKILL.md', files), null);
  assert.equal(resolveSkillFileLink('../../outside.md', 'references/checklist.md', files), null);
});

test('resolves generic editor links within the current workspace skill', () => {
  assert.equal(
    resolveWorkspaceSkillFileLink('references/checklist.md', '/workspace/.claude/skills/demo/SKILL.md'),
    '/workspace/.claude/skills/demo/references/checklist.md',
  );
  assert.equal(
    resolveWorkspaceSkillFileLink('../scripts/run.sh', '/workspace/.claude/skills/demo/references/checklist.md'),
    '/workspace/.claude/skills/demo/scripts/run.sh',
  );
  assert.equal(
    resolveWorkspaceSkillFileLink('references/demo1.md', '/workspace/.claude/skills/SKILL.md'),
    '/workspace/.claude/skills/references/demo1.md',
  );
});

test('generic editor links cannot leave the current skill or capture web links', () => {
  const currentPath = '/workspace/.claude/skills/demo/references/checklist.md';
  assert.equal(resolveWorkspaceSkillFileLink('../../other-skill/SKILL.md', currentPath), null);
  assert.equal(resolveWorkspaceSkillFileLink('https://example.com/docs', currentPath), null);
  assert.equal(resolveWorkspaceSkillFileLink('#usage', currentPath), null);
  assert.equal(resolveWorkspaceSkillFileLink('references/checklist.md', '/workspace/docs/README.md'), null);
});
