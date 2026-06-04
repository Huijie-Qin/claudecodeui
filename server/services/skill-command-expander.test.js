import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { expandLeadingSkillCommand } from './skill-command-expander.js';

async function makeWorkspaceSkill({ name = 'daily-check', content }) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-expander-'));
  const skillPath = path.join(workspacePath, '.claude', 'skills', name, 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, content, 'utf8');
  return { workspacePath, skillPath };
}

test('expandLeadingSkillCommand leaves normal prompts unchanged', async () => {
  const result = await expandLeadingSkillCommand({
    prompt: 'run a normal scheduled task',
    reconcile: false,
  });

  assert.equal(result.expanded, false);
  assert.equal(result.prompt, 'run a normal scheduled task');
});

test('expandLeadingSkillCommand expands a workspace skill with argument placeholders', async () => {
  const { workspacePath } = await makeWorkspaceSkill({
    content: [
      '---',
      'name: daily-check',
      'description: Daily check',
      '---',
      'Check $1 and then summarize $ARGUMENTS.',
      '',
    ].join('\n'),
  });

  const result = await expandLeadingSkillCommand({
    prompt: '/daily-check billing metrics',
    workspacePath,
    reconcile: false,
  });

  assert.equal(result.expanded, true);
  assert.equal(result.skillName, '/daily-check');
  assert.equal(result.prompt, 'Check billing and then summarize billing metrics.\n');
});

test('expandLeadingSkillCommand appends user request when a skill has no placeholders', async () => {
  const { workspacePath } = await makeWorkspaceSkill({
    content: [
      '---',
      'name: report-skill',
      '---',
      '# Report Skill',
      '',
      'Follow this reporting workflow.',
      '',
    ].join('\n'),
    name: 'report-skill',
  });

  const result = await expandLeadingSkillCommand({
    prompt: '/report-skill weekly status',
    workspacePath,
    reconcile: false,
  });

  assert.equal(result.expanded, true);
  assert.match(result.prompt, /Follow this reporting workflow\./);
  assert.match(result.prompt, /## User request\n\nweekly status\n$/);
});
