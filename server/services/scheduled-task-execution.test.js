import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveScheduledTaskPrompts } from './scheduled-task-execution.js';

test('scheduled Claude tasks expand skills for the model and preserve the slash invocation for display', async () => {
  const prompt = '/dau-analysis analyze HarmonyOS NEXT DAU changes';
  let expansionInput = null;

  const result = await resolveScheduledTaskPrompts({
    provider: 'claude',
    prompt,
    workspacePath: '/workspace/project',
    expandSkillCommand: async (input) => {
      expansionInput = input;
      return {
        prompt: '# DAU analysis\n\nExpanded skill instructions.',
        expanded: true,
      };
    },
  });

  assert.deepEqual(expansionInput, {
    prompt,
    workspacePath: '/workspace/project',
  });
  assert.deepEqual(result, {
    displayPrompt: prompt,
    modelPrompt: '# DAU analysis\n\nExpanded skill instructions.',
  });
});

test('scheduled non-Claude tasks keep their provider prompt unchanged', async () => {
  const prompt = '/dau-analysis analyze HarmonyOS NEXT DAU changes';
  let expanded = false;

  const result = await resolveScheduledTaskPrompts({
    provider: 'gemini',
    prompt,
    workspacePath: '/workspace/project',
    expandSkillCommand: async () => {
      expanded = true;
      return { prompt: 'must not be used' };
    },
  });

  assert.equal(expanded, false);
  assert.deepEqual(result, {
    displayPrompt: prompt,
    modelPrompt: prompt,
  });
});
