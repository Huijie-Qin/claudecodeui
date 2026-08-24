import assert from 'node:assert/strict';
import test from 'node:test';

import { isClaudeInternalUserContent } from './internalMessages';

test('identifies internal Hook recovery prompts', () => {
  assert.equal(isClaudeInternalUserContent([
    '<ccui-hook-recovery>',
    'Hook: Completion notification',
    '</ccui-hook-recovery>',
    '# Internal Skill body',
  ].join('\n')), true);
});

test('detects Claude skill details wrappers as internal user content', () => {
  assert.equal(
    isClaudeInternalUserContent([
      'Skill details:',
      'name: design-review',
      'parameters: {"focus":"visual polish"}',
      '',
      'Base directory for this skill: /Users/alex/.claude/skills/design-review',
      '',
      '# Design Review',
    ].join('\n')),
    true,
  );
});

test('does not treat ordinary user requests as internal content', () => {
  assert.equal(
    isClaudeInternalUserContent('Please review the visual polish on this page.'),
    false,
  );
});
