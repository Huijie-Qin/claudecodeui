import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
import { buildSubagentTraces } from '../subagent/buildSubagentTraces';

import { buildExecutionTasks, normalizeExecutionStatus } from './buildExecutionTasks';

const time = (second: number) => `2026-09-22T01:00:${String(second).padStart(2, '0')}.000Z`;
const normalized = (id: string, second: number, values: Partial<NormalizedMessage>): NormalizedMessage => ({
  id, sessionId: 'session-p0', timestamp: time(second), provider: 'claude', kind: 'task_notification', ...values,
});
const execution = (messages: NormalizedMessage[]) => {
  const chat = normalizedToChatMessages(messages);
  return { chat, tasks: buildExecutionTasks(chat, buildSubagentTraces(chat)) };
};

test('background lifecycle merges once, retains command, real events and terminal outcome after late progress', () => {
  const { chat, tasks } = execution([
    normalized('bash', 0, { kind: 'tool_use', toolName: 'Bash', toolId: 'bash-call', toolInput: {
      command: 'node scripts/verify.mjs', description: 'Verify report', run_in_background: true,
    } }),
    normalized('started', 1, { taskId: 'job-a', toolUseId: 'bash-call', status: 'running', summary: 'Execute verification' }),
    normalized('progress', 2, { taskId: 'job-a', status: 'running', summary: 'Read 4 files', usage: { tool_uses: 4 } }),
    normalized('completed', 3, { taskId: 'job-a', status: 'completed', summary: 'Verified all files',
      result: '4 files passed', outputFile: '/tmp/verification.output', usage: { duration_ms: 2000 } }),
    normalized('late', 4, { taskId: 'job-a', status: 'running', summary: 'Delayed progress' }),
  ]);
  assert.equal(chat.filter((message) => message.isTaskNotification).length, 1);
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.equal(task.sourceMessageId, 'started');
  assert.equal(task.title, 'Verify report');
  assert.equal(task.command, 'node scripts/verify.mjs');
  assert.equal(task.status, 'completed');
  assert.equal(task.summary, 'Verified all files');
  assert.equal(task.result, '4 files passed');
  assert.equal(task.outputFile, '/tmp/verification.output');
  assert.equal(task.startedAt?.toISOString(), time(0));
  assert.equal(task.completedAt?.toISOString(), time(3));
  assert.deepEqual(task.events.map((event) => event.id), ['invocation:bash', 'started', 'progress', 'completed', 'late']);
  assert.deepEqual(task.usage, { tool_uses: 4, duration_ms: 2000 });
});

test('legacy XML completion coalesces with structured start even when the start has only a tool id', () => {
  const { tasks, chat } = execution([
    normalized('started', 1, { toolUseId: 'bash-call', status: 'running', summary: 'Execute verification' }),
    normalized('legacy', 2, { kind: 'text', role: 'user', content: '<task-notification><task-id>job-a</task-id>'
      + '<tool-use-id>bash-call</tool-use-id><status>failed</status><summary>Verification failed</summary>'
      + '<result>Expected 4 files, found 3</result><output-file>/tmp/job-a.output</output-file>'
      + '<usage><total_tokens>17</total_tokens></usage><retryable>true</retryable></task-notification>' }),
  ]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[0].sourceMessageId, 'started');
  assert.equal(tasks[0].taskId, 'job-a');
  assert.equal(tasks[0].result, 'Expected 4 files, found 3');
  assert.equal(tasks[0].usage?.total_tokens, 17);
  assert.equal(chat[0].taskNotification?.extraFields.retryable, 'true');
});

test('identity-free notifications never merge by title and absent or unfamiliar statuses remain unknown', () => {
  const { tasks } = execution([
    normalized('a', 1, { summary: 'Execute task' }),
    normalized('b', 2, { summary: 'Execute task', status: 'provider_new_status' }),
    normalized('c', 3, { kind: 'text', role: 'user', content: '<task-notification><summary>Execute task</summary></task-notification>' }),
  ]);
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 3);
  assert.ok(tasks.every((task) => task.status === 'unknown' && task.completedAt === undefined));
});

test('child background tasks retain exact Agent ownership without generating standalone Agent tasks', () => {
  const { chat, tasks } = execution([
    normalized('agent-a', 0, { kind: 'tool_use', toolId: 'agent-call-a', toolName: 'Agent', toolInput: { description: 'Inspect A' },
      toolResult: { content: 'launched', isError: false, toolUseResult: { status: 'async_launched', agentId: 'child-a' } } }),
    normalized('agent-b', 0, { kind: 'tool_use', toolId: 'agent-call-b', toolName: 'Agent', toolInput: { description: 'Inspect B' },
      toolResult: { content: 'launched', isError: false, toolUseResult: { status: 'async_launched', agentId: 'child-b' } } }),
    normalized('bash-a', 1, { kind: 'tool_use', toolId: 'bash-call-a', parentToolUseId: 'agent-call-a',
      toolName: 'Bash', toolInput: { command: 'node a.mjs' } }),
    normalized('bash-b', 1, { kind: 'tool_use', toolId: 'bash-call-b', parentToolUseId: 'agent-call-b',
      toolName: 'Bash', toolInput: { command: 'node b.mjs' } }),
    normalized('background-a', 2, { taskId: 'job-a', toolUseId: 'bash-call-a', status: 'running', summary: 'Execute task' }),
    normalized('background-b', 2, { taskId: 'job-b', toolUseId: 'bash-call-b', status: 'stopped', summary: 'Execute task' }),
    normalized('agent-complete', 3, { taskId: 'child-b', toolUseId: 'agent-call-b', status: 'completed', summary: 'Finished B' }),
  ]);
  assert.equal(chat.length, 2, 'Child tasks are in the child transcript, not duplicated on the main timeline');
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.kind === 'background'));
  const a = tasks.find((task) => task.taskId === 'job-a');
  const b = tasks.find((task) => task.taskId === 'job-b');
  assert.equal(a?.parentAgentId, 'child-a');
  assert.equal(a?.parentToolUseId, 'agent-call-a');
  assert.equal(a?.command, 'node a.mjs');
  assert.equal(b?.parentAgentId, 'child-b');
  assert.equal(b?.command, 'node b.mjs');
  assert.equal(b?.status, 'stopped');
  assert.deepEqual(buildExecutionTasks(JSON.parse(JSON.stringify(chat)), buildSubagentTraces(JSON.parse(JSON.stringify(chat)))), tasks);
});

test('execution status distinguishes failure, stop, waiting and unknown explicitly', () => {
  assert.equal(normalizeExecutionStatus('timed-out'), 'failed');
  assert.equal(normalizeExecutionStatus('cancelled'), 'stopped');
  assert.equal(normalizeExecutionStatus('waiting_for_input'), 'waiting');
  assert.equal(normalizeExecutionStatus(undefined), 'unknown');
});

test('a real Bash backgroundTaskId creates inspectable running work even without task_started', () => {
  const { tasks } = execution([
    normalized('launch', 0, { kind: 'tool_use', toolName: 'Bash', toolId: 'bash-launch',
      toolInput: { command: 'node slow-check.mjs', description: 'Slow check', run_in_background: true } }),
    normalized('launched', 1, { kind: 'tool_result', toolId: 'bash-launch', isError: false,
      content: 'Command running in background with ID: b123. Output is being written to: /tmp/b123.output',
      toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b123' } }),
  ]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, 'b123');
  assert.equal(tasks[0].status, 'running');
  assert.equal(tasks[0].sourceMessageId, 'launch');
  assert.equal(tasks[0].command, 'node slow-check.mjs');
  assert.equal(tasks[0].events.length, 2);
});

test('TaskOutput XML supplies real stdout and exit code when notification only has summary and output file', () => {
  const { tasks } = execution([
    normalized('launch', 0, { kind: 'tool_use', toolName: 'Bash', toolId: 'bash-launch',
      toolInput: { command: 'node check.mjs', run_in_background: true },
      toolResult: { content: 'Launched', isError: false, toolUseResult: { backgroundTaskId: 'b123' } } }),
    normalized('finished', 3, { taskId: 'b123', status: 'completed', summary: 'Command completed', outputFile: '/tmp/b123.output' }),
    normalized('poll', 2, { kind: 'tool_use', toolName: 'TaskOutput', toolId: 'poll-1', toolInput: { task_id: 'b123', block: true } }),
    normalized('poll-result', 4, { kind: 'tool_result', toolId: 'poll-1', isError: false,
      content: '<retrieval_status>success</retrieval_status>\n<task_id>b123</task_id>\n<task_type>local_bash</task_type>\n'
        + '<status>completed</status>\n<exit_code>0</exit_code>\n<output>CHECK_OK\n4 files passed\n</output>' }),
    normalized('late-poll', 5, { kind: 'tool_use', toolName: 'TaskOutput', toolId: 'poll-2', toolInput: { task_id: 'b123', block: false },
      toolResult: { content: '<task_id>b123</task_id><status>running</status><output>Old partial output</output>', isError: false } }),
  ]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sourceMessageId, 'finished');
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].command, 'node check.mjs');
  assert.equal(tasks[0].result, 'CHECK_OK\n4 files passed\n');
  assert.equal(tasks[0].exitCode, 0);
  assert.equal(tasks[0].outputFile, '/tmp/b123.output');
  assert.equal(tasks[0].events.find((event) => event.id === 'task-output:poll')?.result, 'CHECK_OK\n4 files passed\n');
  assert.equal(tasks[0].events.find((event) => event.id === 'task-output:late-poll')?.result, 'Old partial output');
});

test('TaskOutput structured command failures are visible without inventing a successful result', () => {
  const { tasks } = execution([
    normalized('launch', 0, { kind: 'tool_use', toolName: 'Bash', toolId: 'bash-launch',
      toolInput: { command: 'node fail.mjs', run_in_background: true },
      toolResult: { content: 'Launched', isError: false, toolUseResult: { backgroundTaskId: 'b123' } } }),
    normalized('poll', 2, { kind: 'tool_use', toolName: 'TaskOutput', toolId: 'poll-1', toolInput: { task_id: 'b123' } }),
    normalized('poll-result', 3, { kind: 'tool_result', toolId: 'poll-1', isError: false,
      content: JSON.stringify({ retrieval_status: 'success', task: {
        task_id: 'b123', status: 'completed', exit_code: 7, output: 'FAIL_EXPECTED\nSchema mismatch',
      } }) }),
    normalized('unrelated-poll', 4, { kind: 'tool_use', toolName: 'TaskOutput', toolId: 'poll-other', toolInput: { task_id: 'b456' },
      toolResult: { content: '<status>completed</status><exit_code>0</exit_code><output>Other task output</output>', isError: false } }),
  ]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[0].exitCode, 7);
  assert.equal(tasks[0].result, 'FAIL_EXPECTED\nSchema mismatch');
  assert.equal(tasks[0].completedAt?.toISOString(), time(3));
  assert.ok(tasks[0].events.every((event) => event.result !== 'Other task output'));
});

test('reaped background tasks expose successful exact-path Read output and explicit notification exit codes', () => {
  const successOutput = '     1→CCUI_P0_SUCCESS_START\n     2→CCUI_P0_SUCCESS_DONE\n';
  const failureOutput = '     1→CCUI_P0_FAILURE_START\n     2→CCUI_P0_EXPECTED_FAILURE\n';
  const { tasks } = execution([
    normalized('launch-success', 0, { kind: 'tool_use', toolName: 'Bash', toolId: 'bash-success',
      toolInput: { command: 'node success.mjs', run_in_background: true },
      toolResult: { content: 'Command running in background with ID: bg-ok.', isError: false,
        toolUseResult: { backgroundTaskId: 'bg-ok', stdout: '', stderr: '' } } }),
    normalized('launch-failure', 0, { kind: 'tool_use', toolName: 'Bash', toolId: 'bash-failure',
      toolInput: { command: 'node failure.mjs', run_in_background: true },
      toolResult: { content: 'Command running in background with ID: bg-fail.', isError: false,
        toolUseResult: { backgroundTaskId: 'bg-fail', stdout: '', stderr: '' } } }),
    normalized('success-notice', 2, { taskId: 'bg-ok', toolUseId: 'bash-success', status: 'completed',
      summary: 'Background command "Execute success sample" completed (exit code 0)', outputFile: '/tmp/bg-ok.output' }),
    normalized('failure-notice', 2, { taskId: 'bg-fail', toolUseId: 'bash-failure', status: 'failed',
      summary: 'Background command "Execute failure sample" failed with exit code 7.', outputFile: '/tmp/bg-fail.output' }),
    normalized('poll-success', 3, { kind: 'tool_use', toolName: 'TaskOutput', toolId: 'poll-ok',
      toolInput: { task_id: 'bg-ok' }, toolResult: { content: 'No task found with ID: bg-ok', isError: true } }),
    normalized('poll-failure', 3, { kind: 'tool_use', toolName: 'TaskOutput', toolId: 'poll-fail',
      toolInput: { task_id: 'bg-fail' }, toolResult: { content: 'No task found with ID: bg-fail', isError: true } }),
    normalized('read-success', 4, { kind: 'tool_use', toolName: 'Read', toolId: 'read-ok',
      toolInput: { file_path: '/tmp/bg-ok.output' }, toolResult: { content: successOutput, isError: false } }),
    normalized('read-failure', 4, { kind: 'tool_use', toolName: 'Read', toolId: 'read-fail',
      toolInput: { file_path: '/tmp/bg-fail.output' }, toolResult: { content: failureOutput, isError: false } }),
  ]);
  assert.equal(tasks.length, 2);
  const succeeded = tasks.find((task) => task.taskId === 'bg-ok')!;
  const failed = tasks.find((task) => task.taskId === 'bg-fail')!;
  assert.equal(succeeded.status, 'completed');
  assert.equal(succeeded.exitCode, 0);
  assert.equal(succeeded.result, successOutput, 'Preserve the actual Read text, including its line numbers');
  assert.equal(failed.status, 'failed', 'A successful log read must not turn the failed command into success');
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.result, failureOutput);
  assert.equal(failed.completedAt?.toISOString(), time(2), 'Log inspection does not change command completion time');
  assert.equal(failed.events.find((event) => event.id === 'output-read:read-failure')?.result, failureOutput);
  assert.ok(succeeded.events.every((event) => event.result !== failureOutput));
});

test('output recovery rejects failed, stale and merely similar Read paths and never guesses codes from numbers', () => {
  const { tasks } = execution([
    normalized('old-read', 0, { kind: 'tool_use', toolName: 'Read', toolId: 'old-read',
      toolInput: { file_path: '/tmp/bg.output' }, toolResult: { content: 'Old unrelated run', isError: false } }),
    normalized('notice', 2, { taskId: 'bg', status: 'failed', summary: 'Execute 7 failed checks after 2 attempts', outputFile: '/tmp/bg.output' }),
    normalized('same-title', 3, { kind: 'tool_use', toolName: 'Read', toolId: 'similar-read',
      toolInput: { file_path: '/tmp/bg.output.backup', description: 'Execute 7 failed checks after 2 attempts' },
      toolResult: { content: 'Wrong task output', isError: false } }),
    normalized('error-read', 4, { kind: 'tool_use', toolName: 'Read', toolId: 'failed-read',
      toolInput: { file_path: '/tmp/bg.output' }, toolResult: { content: 'File not found', isError: true } }),
  ]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].result, undefined);
  assert.equal(tasks[0].exitCode, undefined);
  assert.equal(tasks[0].events.filter((event) => event.id.startsWith('output-read:')).length, 0);
});

test('structured exit codes and final output take priority over summary fallback and later log inspection', () => {
  const { tasks } = execution([
    normalized('notice', 2, { taskId: 'bg', status: 'failed', summary: 'Background command failed with exit code 7',
      outputFile: '/tmp/bg.output' }),
    normalized('poll', 3, { kind: 'tool_use', toolName: 'TaskOutput', toolId: 'poll', toolInput: { task_id: 'bg' },
      toolResult: { content: '<task_id>bg</task_id><status>failed</status><exit_code>9</exit_code><output>Authoritative result</output>', isError: false } }),
    normalized('read', 4, { kind: 'tool_use', toolName: 'Read', toolId: 'read',
      toolInput: { file_path: '/tmp/bg.output' }, toolResult: { content: 'Partial log window', isError: false } }),
  ]);
  assert.equal(tasks[0].exitCode, 9);
  assert.equal(tasks[0].result, 'Authoritative result');
  assert.equal(tasks[0].events.find((event) => event.id === 'output-read:read')?.result, 'Partial log window');
});
