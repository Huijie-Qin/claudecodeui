import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveScheduledTaskPrompts } from './scheduled-task-execution.js';

test('scheduled Claude tasks pass native skill invocations through without scanning or expansion', async () => {
  const prompt = '/dau-analysis\n第一行\n第二行\n\n```json\n{"sentinel":"FINAL_LINE"}\n```';

  const result = await resolveScheduledTaskPrompts({
    provider: 'claude',
    prompt,
    workspacePath: '/workspace/project',
  });

  assert.deepEqual(result, {
    displayPrompt: prompt,
    modelPrompt: prompt,
  });
});

test('scheduled non-Claude tasks keep their provider prompt unchanged', async () => {
  const prompt = '/dau-analysis analyze HarmonyOS NEXT DAU changes';

  const result = await resolveScheduledTaskPrompts({
    provider: 'gemini',
    prompt,
    workspacePath: '/workspace/project',
  });

  assert.deepEqual(result, {
    displayPrompt: prompt,
    modelPrompt: prompt,
  });
});
