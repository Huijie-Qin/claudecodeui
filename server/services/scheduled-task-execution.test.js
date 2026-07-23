import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveScheduledTaskProviderPrompt } from './scheduled-task-execution.js';

test('scheduled tasks pass slash skill invocations to the provider unchanged', () => {
  const prompt = '/dau-analysis analyze HarmonyOS NEXT DAU changes';

  assert.equal(resolveScheduledTaskProviderPrompt(prompt), prompt);
});
