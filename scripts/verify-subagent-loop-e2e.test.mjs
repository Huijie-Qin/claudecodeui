import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySubagentLoopEvidence } from './verify-subagent-loop-e2e.mjs';

// Synthetic evidence tests only the checker's ability to reject invalid runs.
// It is never used as browser acceptance evidence or to simulate elapsed time.
function sample() {
  const run = 'loop20_verifier_test';
  const created = 1_800_000_000_000;
  const taskId = 'real-service-task';
  const executeId = `toolu_${run}_child-A_execute`;
  const statusId = `toolu_${run}_child-A_status`;
  const task = (elapsed, status) => ({ task_id: taskId, status, created_at_ms: created, duration_ms: 1_200_000, observed_at_ms: created + elapsed, elapsed_ms: elapsed, finished_at_ms: status === 'running' ? null : created + 1_200_000 });
  const submitted = task(0, 'running');
  const initial = task(100, 'running');
  const final = task(1_200_001, 'success');
  const entry = (actor, phase, elapsed, content = [], request = {}, extra = {}) => ({ run, actor, phase, at: new Date(created + elapsed).toISOString(), content, request, ...extra });
  const resultRequest = (id, value) => ({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(value) }] }] }] });
  const calls = [
    { toolName: 'execute_task', input: {}, startedAtMs: created, completedAtMs: created + 1, output: submitted },
    ...[initial, task(10_100, 'running'), final].map((output) => ({ toolName: 'get_task_status', input: { task_id: taskId }, startedAtMs: output.observed_at_ms, completedAtMs: output.observed_at_ms + 1, output })),
  ];
  return {
    run,
    evidence: {
      modelRequests: [
        entry('main', 'loop-spawn-child', -100),
        entry('child-A', 'loop-execute-task', -50, [{ type: 'tool_use', id: executeId, name: 'mcp__qa__execute_task', input: {} }]),
        entry('child-A', 'loop-get-task-status', 50, [{ type: 'tool_use', id: statusId, name: 'mcp__qa__get_task_status', input: { task_id: taskId } }], resultRequest(executeId, submitted)),
        entry('child-A', 'loop-complete', 1_200_004, [], resultRequest(statusId, final), { taskId, observedStatus: 'success' }),
        entry('main', 'loop-complete', 1_200_005, [], {}, { taskId, observedStatus: 'success' }),
      ],
      hookExecutions: [{
        id: 'execution-1', session_id: 'session-1', tool_use_id: statusId, event_name: 'PostToolUse', status: 'succeeded',
        input: { agent_id: 'child-agent-1', tool_input: { task_id: taskId }, tool_response: initial },
        response: { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: [{ type: 'text', text: JSON.stringify(final) }] } },
        actions: { loop: { output: { deliveredTo: 'subagent', scheduled: true, jobId: 'child-loop-job-1', agentId: 'child-agent-1', status: 'succeeded', attemptCount: 2 } } },
        started_at_ms: created + 101, completed_at_ms: created + 1_200_003, duration_ms: 1_199_902,
      }],
      loopDemo: {
        jobs: [{
          id: 'child-loop-job-1', session_id: 'session-1', tool_use_id: statusId,
          status: 'succeeded', attempt_count: 2,
        }],
        taskService: {
          durationMs: 1_200_000, instanceId: 'task-server-1',
          tasks: [{ id: taskId, createdAtMs: created, durationMs: 1_200_000 }],
          observations: calls.map((call) => ({ operation: call.toolName, ...call.output })),
        },
        mcp: { instanceId: 'mcp-server-1', calls },
      },
    },
  };
}

test('accepts a real-timestamp evidence shape with Hook waiting for the remaining task lifetime', () => {
  const { evidence, run } = sample();
  const report = verifySubagentLoopEvidence(evidence, { run });
  assert.equal(report.passed, true);
  assert.equal(report.taskObservedElapsedMs, 1_200_001);
  assert.equal(report.hookElapsedMs, 1_199_902);
});

test('rejects a shortened task even if the configured duration says twenty minutes', () => {
  const { evidence, run } = sample();
  evidence.loopDemo.mcp.calls.at(-1).startedAtMs -= 60_000;
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /twenty wall-clock minutes/);
});

test('rejects a leaked original running status in the child continuation', () => {
  const { evidence, run } = sample();
  evidence.modelRequests[3].request.messages[0].content[0].content[0].text = JSON.stringify({ task_id: 'real-service-task', status: 'running' });
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /original running must be replaced/);
});

test('rejects a model turn while the Hook should be waiting', () => {
  const { evidence, run } = sample();
  evidence.modelRequests.splice(3, 0, { run, actor: 'child-A', phase: 'unexpected-poll', at: new Date(1_800_000_000_000 + 500_000).toISOString() });
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /next child model turn/);
});

test('rejects repeated remote submissions even when the model submitted only once', () => {
  const { evidence, run } = sample();
  evidence.loopDemo.mcp.calls.push({ ...evidence.loopDemo.mcp.calls[0], startedAtMs: 1_800_000_000_050 });
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /only one submission/);
});

test('rejects an additional parent loop job in the child session', () => {
  const { evidence, run } = sample();
  evidence.loopDemo.jobs.push({ id: 'parent-job', session_id: 'session-1', tool_use_id: 'parent-tool' });
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /additional parent loop job/);
});

test('rejects native replacement for a different task', () => {
  const { evidence, run } = sample();
  evidence.hookExecutions[0].response.hookSpecificOutput.updatedMCPToolOutput = [{ type: 'text', text: '{"task_id":"wrong-task","status":"success"}' }];
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /updatedMCPToolOutput/);
});

test('requires evidence of persisted jobs instead of assuming omitted means zero', () => {
  const { evidence, run } = sample();
  delete evidence.loopDemo.jobs;
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /include persisted MCP loop jobs/);
});

test('reads actual CLI JSON tool_result strings with appended system reminders', () => {
  const { evidence, run } = sample();
  // Observed in loop20_20260911_success: execute_task tool_result.content is a
  // JSON string followed by the CLI's available-agent-types reminder.
  const submission = evidence.modelRequests[2].request.messages[0].content[0];
  submission.content = `${submission.content[0].text}\n\n<system-reminder>\nAvailable agent types for the Agent tool:\n- general-purpose\n</system-reminder>`;
  const continuation = evidence.modelRequests[3].request.messages[0].content[0];
  continuation.content[0].text += '\n\n<system-reminder>\nAvailable agent types for the Agent tool:\n- general-purpose\n</system-reminder>';
  assert.equal(verifySubagentLoopEvidence(evidence, { run }).passed, true);
});

test('does not mistake a task-like reminder for the actual MCP result', () => {
  const { evidence, run } = sample();
  evidence.modelRequests[3].request.messages[0].content[0].content = 'unparseable tool result\n\n<system-reminder>{"task_id":"real-service-task","status":"success"}</system-reminder>';
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /original running must be replaced/);
});

test('rejects the v3 raw object replacement that crashes the actual CLI renderer', () => {
  const { evidence, run } = sample();
  const response = evidence.hookExecutions[0].response.hookSpecificOutput;
  response.updatedMCPToolOutput = JSON.parse(response.updatedMCPToolOutput[0].text);
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /raw objects crash the CLI/);
});

test('rejects CLI tool errors even if their content looks like a final task result', () => {
  const { evidence, run } = sample();
  evidence.modelRequests[3].request.messages[0].content[0].is_error = true;
  assert.throws(() => verifySubagentLoopEvidence(evidence, { run }), /must not be a CLI tool error/);
});
