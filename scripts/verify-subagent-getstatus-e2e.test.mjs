import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySubagentGetstatusEvidence } from './verify-subagent-getstatus-e2e.mjs';

// Synthetic data exercises acceptance checks only. It is never browser evidence
// and does not replace the required actual twenty-minute service run.
function sample() {
  const run = 'getstatus20_verifier_test';
  const created = 1_800_000_000_000;
  const id = 'ac67b56b-5fba-4c45-979d-4b78746949fd';
  const statusId = `toolu_${run}_child-A_status`;
  const result = (elapsed, status) => ({ id, status, created_at_ms: created, duration_ms: 1_200_000, observed_at_ms: created + elapsed, elapsed_ms: elapsed, finished_at_ms: status === 'running' ? null : created + 1_200_000 });
  const initial = result(0, 'running');
  const final = result(1_200_001, 'success');
  const entry = (actor, phase, elapsed, content = [], request = {}, extra = {}) => ({ run, actor, phase, at: new Date(created + elapsed).toISOString(), content, request, ...extra });
  const calls = [initial, result(10_000, 'running'), final].map((output) => ({ toolName: 'getstatus', input: { id }, startedAtMs: output.observed_at_ms - 1, completedAtMs: output.observed_at_ms + 1, output }));
  return {
    run,
    evidence: {
      modelRequests: [
        entry('main', 'getstatus-spawn-child', -100, [{ type: 'tool_use', name: 'Agent', id: `toolu_${run}_main_spawn-A`, input: { prompt: 'Invoke getstatus once.' } }]),
        entry('child-A', 'getstatus-call', -50, [{ type: 'tool_use', id: statusId, name: 'mcp__qa__getstatus', input: { id } }]),
        entry('child-A', 'getstatus-complete', 1_200_004, [], { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: statusId, content: [{ type: 'text', text: JSON.stringify(final) }] }] }] }, { taskId: id, observedStatus: 'success' }),
        entry('main', 'getstatus-complete', 1_200_005, [], {}, { taskId: id, observedStatus: 'success' }),
      ],
      hookExecutions: [{
        id: 'execution-1', session_id: 'session-1', tool_use_id: statusId, event_name: 'PostToolUse', status: 'succeeded',
        input: { agent_id: 'child-agent-1', tool_input: { id }, tool_response: JSON.stringify(initial) },
        response: { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: [{ type: 'text', text: JSON.stringify(final) }] } },
        actions: { loop: { output: { deliveredTo: 'subagent', scheduled: true, jobId: 'child-loop-job-1', agentId: 'child-agent-1', status: 'succeeded', attemptCount: 2 } } },
        started_at_ms: created + 2, completed_at_ms: created + 1_200_003, duration_ms: 1_200_001,
      }],
      getstatusDemo: {
        jobs: [{
          id: 'child-loop-job-1', session_id: 'session-1', tool_use_id: statusId,
          status: 'succeeded', attempt_count: 2,
        }],
        api: {
          durationMs: 1_200_000, instanceId: 'api-server-1', startedAtMs: created - 1000, pid: 10, hostname: 'remote-getstatus-api',
          records: [{ id, createdAtMs: created, durationMs: 1_200_000 }],
          observations: calls.map((call, index) => ({ firstSeen: index === 0, ...call.output })),
        },
        mcp: { instanceId: 'mcp-server-1', startedAtMs: created - 1000, pid: 11, hostname: 'remote-getstatus-mcp', apiUrl: 'http://remote-getstatus-api:40150', calls },
      },
    },
  };
}

test('accepts a first-request timer, real repeated API calls, and native child result replacement', () => {
  const { evidence, run } = sample();
  const report = verifySubagentGetstatusEvidence(evidence, { run });
  assert.equal(report.passed, true);
  assert.equal(report.apiObservedElapsedMs, 1_200_001);
  assert.equal(report.actualApiRequests, 3);
  assert.equal(report.actualMcpGetstatusCalls, 3);
  assert.equal(report.longestMcpRequestMs, 2);
  assert.equal(report.childModelGetstatusCalls, 1);
});

test('accepts the actual CLI trailing system reminder without reading status from it', () => {
  const { evidence, run } = sample();
  const block = evidence.modelRequests[2].request.messages[0].content[0];
  block.content = `${block.content[0].text}\n\n<system-reminder>Agent catalog {"id":"wrong-id","status":"failed"}</system-reminder>`;
  assert.equal(verifySubagentGetstatusEvidence(evidence, { run }).passed, true);
});

test('rejects a service that returns success before twenty real minutes', () => {
  const { evidence, run } = sample();
  for (const final of [evidence.getstatusDemo.mcp.calls.at(-1).output, evidence.getstatusDemo.api.observations.at(-1)]) {
    final.elapsed_ms -= 60_000;
    final.observed_at_ms -= 60_000;
  }
  evidence.getstatusDemo.mcp.calls.at(-1).startedAtMs -= 60_000;
  evidence.getstatusDemo.mcp.calls.at(-1).completedAtMs -= 60_000;
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /before twenty wall-clock minutes/);
});

test('rejects tool-level waiting that disguises a single long request as a loop', () => {
  const { evidence, run } = sample();
  evidence.getstatusDemo.mcp.calls[1].completedAtMs += 20_000;
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /must return promptly/);
});

test('rejects creating the id before the first getstatus invocation', () => {
  const { evidence, run } = sample();
  evidence.getstatusDemo.api.records[0].createdAtMs -= 100;
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /only after the child first invokes/);
});

test('rejects a timer reset on a repeated request', () => {
  const { evidence, run } = sample();
  evidence.getstatusDemo.api.observations[1].created_at_ms += 10_000;
  evidence.getstatusDemo.mcp.calls[1].output.created_at_ms += 10_000;
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /never reset/);
});

test('rejects an MCP response with no corresponding real API request', () => {
  const { evidence, run } = sample();
  evidence.getstatusDemo.api.observations.splice(1, 1);
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /HTTP API exactly once/);
});

test('rejects an MCP that invents a different response from the API', () => {
  const { evidence, run } = sample();
  evidence.getstatusDemo.mcp.calls[1].output.status = 'success';
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /actual HTTP API response/);
});

test('rejects changing the id between Hook polls', () => {
  const { evidence, run } = sample();
  evidence.getstatusDemo.mcp.calls[1].input.id = 'a-new-id';
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /preserve the same id/);
});

test('rejects using the old execute_task design', () => {
  const { evidence, run } = sample();
  evidence.getstatusDemo.mcp.calls[0].toolName = 'execute_task';
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /no execute_task/);
});

test('rejects a second model-generated status call instead of Hook polling', () => {
  const { evidence, run } = sample();
  evidence.modelRequests.splice(2, 0, structuredClone(evidence.modelRequests[1]));
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /exactly one getstatus call/);
});

test('rejects a model turn while the child Hook is waiting', () => {
  const { evidence, run } = sample();
  evidence.modelRequests.splice(2, 0, { run, actor: 'child-A', phase: 'unexpected-turn', at: new Date(1_800_000_050_000).toISOString() });
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /no extra child model turn/);
});

test('rejects parent MCP calls', () => {
  const { evidence, run } = sample();
  evidence.modelRequests[0].content.push({ type: 'tool_use', name: 'mcp__qa__getstatus', input: { id: 'wrong' } });
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /Parent must not invoke/);
});

test('rejects an additional parent loop job in the child session', () => {
  const { evidence, run } = sample();
  evidence.getstatusDemo.jobs.push({ id: 'parent-job', session_id: 'session-1', tool_use_id: 'parent-tool' });
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /additional parent loop job/);
});

test('requires evidence of persisted jobs instead of treating missing data as zero', () => {
  const { evidence, run } = sample();
  delete evidence.getstatusDemo.jobs;
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /include persisted MCP loop jobs/);
});

test('rejects original running leaking into the child continuation', () => {
  const { evidence, run } = sample();
  evidence.modelRequests[2].request.messages[0].content[0].content[0].text = evidence.hookExecutions[0].input.tool_response;
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /original running must be replaced/);
});

test('rejects final-looking text located only inside a system reminder', () => {
  const { evidence, run } = sample();
  const block = evidence.modelRequests[2].request.messages[0].content[0];
  block.content = `Unparseable result\n\n<system-reminder>${block.content[0].text}</system-reminder>`;
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /original running must be replaced/);
});

test('rejects native raw object replacements that the CLI cannot render', () => {
  const { evidence, run } = sample();
  const output = evidence.hookExecutions[0].response.hookSpecificOutput;
  output.updatedMCPToolOutput = JSON.parse(output.updatedMCPToolOutput[0].text);
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /CLI-compatible string/);
});

test('rejects a CLI error even if it contains the expected final status', () => {
  const { evidence, run } = sample();
  evidence.modelRequests[2].request.messages[0].content[0].is_error = true;
  assert.throws(() => verifySubagentGetstatusEvidence(evidence, { run }), /not a CLI error/);
});
