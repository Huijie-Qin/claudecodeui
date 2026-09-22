import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { executionTaskForMessage, indexExecutionTaskMessages } from './messageTasks';
import type { ExecutionTask } from './types';

const launch: ChatMessage = { id: 'launch', type: 'assistant', content: '', timestamp: '', isToolUse: true, toolName: 'Bash' };
const task: ExecutionTask = { id: 'background:one', kind: 'background', title: 'Background check', status: 'running', sourceMessageId: 'launch', taskId: 'one', events: [] };

test('a Bash-only background task remains inspectable without an overview or notification', () => {
  const index = indexExecutionTaskMessages([task]);
  assert.equal(executionTaskForMessage(index, launch), task);
  assert.equal(executionTaskForMessage(index, { ...launch, id: 'other-command' }), undefined);
});

test('a delivered notification owns the entry without adding a duplicate to its Bash row', () => {
  const notified = { ...task, sourceMessageId: 'notification' };
  const index = indexExecutionTaskMessages([notified]);
  assert.equal(executionTaskForMessage(index, launch), undefined);
  assert.equal(executionTaskForMessage(index, { id: 'notification', type: 'assistant', content: '', timestamp: '', isTaskNotification: true }), notified);
});
