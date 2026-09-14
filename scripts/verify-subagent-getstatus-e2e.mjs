// Read-only acceptance checker; this script never submits or polls an MCP task.
// node scripts/verify-subagent-getstatus-e2e.mjs --run getstatus20_browser --evidence evidence.json
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TWENTY_MINUTES_MS = 1_200_000;
const STATUS_TOOL_SUFFIX = '__getstatus';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function statusResults(value) {
  if (typeof value === 'string') {
    // Claude CLI can append its agent catalog after the actual JSON result.
    // Never accept status-shaped text from that reminder as tool output.
    const reminderStart = value.search(/(?:\r?\n)+<system-reminder>/);
    const json = reminderStart === -1 ? value : value.slice(0, reminderStart);
    try { return statusResults(JSON.parse(json)); } catch { return []; }
  }
  if (!value || typeof value !== 'object') return [];
  if (typeof value.id === 'string' && ['running', 'success', 'failed'].includes(value.status)) return [value];
  return Object.values(value).flatMap(statusResults);
}

function emittedTools(entry) {
  return (entry.content || []).filter((block) => block.type === 'tool_use');
}

function resultBlocks(entry, toolUseId) {
  return (entry.request?.messages || []).filter((message) => message.role === 'user')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'tool_result' && block.tool_use_id === toolUseId);
}

function exactlyOne(values, message) {
  assert.equal(values.length, 1, `${message}; observed ${values.length}`);
  return values[0];
}

function timestamp(value, message = 'A valid timestamp is required') {
  const result = typeof value === 'number' ? value : Date.parse(value);
  assert.ok(Number.isFinite(result), message);
  return result;
}

export function verifySubagentGetstatusEvidence(evidence, { run } = {}) {
  assert.ok(typeof run === 'string' && run.startsWith('getstatus20'), 'A getstatus20 RUN identifier is required');
  const requests = (evidence.modelRequests || []).filter((entry) => entry.run === run && entry.phase !== 'auxiliary');
  const childRequests = requests.filter((entry) => entry.actor === 'child-A');
  const parentRequests = requests.filter((entry) => entry.actor === 'main');
  assert.ok(requests.every((entry) => ['main', 'child-A'].includes(entry.actor)), 'The run must contain only the parent and its single child');
  assert.ok(!requests.some((entry) => /error/.test(entry.phase)), 'Fixture must not report a model protocol error');
  const statusRequest = exactlyOne(childRequests.filter((entry) => emittedTools(entry).some((tool) => tool.name.endsWith(STATUS_TOOL_SUFFIX))), 'Child must emit exactly one getstatus call');
  assert.equal(statusRequest.phase, 'getstatus-call');
  const statusTool = exactlyOne(childRequests.flatMap(emittedTools), 'The child must invoke only one tool, getstatus; no submission or model polling');
  assert.ok(statusTool.name.endsWith(STATUS_TOOL_SUFFIX));
  assert.equal(statusTool.id, `toolu_${run}_child-A_status`);
  const id = statusTool.input?.id;
  assert.ok(typeof id === 'string' && UUID_V4.test(id), 'Child must supply a randomly generated UUID as the initial id');
  assert.deepEqual(Object.keys(statusTool.input), ['id'], 'The first getstatus input must contain only the id');
  assert.ok(!parentRequests.flatMap(emittedTools).some((tool) => tool.name.startsWith('mcp__')), 'Parent must not invoke any MCP tool');

  const parentSpawn = exactlyOne(parentRequests.filter((entry) => entry.phase === 'getstatus-spawn-child'), 'Parent must start one child');
  const childComplete = exactlyOne(childRequests.filter((entry) => entry.phase === 'getstatus-complete'), 'Child must complete once after the Hook');
  const parentComplete = exactlyOne(parentRequests.filter((entry) => entry.phase === 'getstatus-complete'), 'Parent must complete once after its child');
  assert.equal(childRequests.length, 2, 'There must be no extra child model turn during the Hook wait');
  assert.equal(parentRequests.length, 2, 'There must be no extra parent model turn during the Hook wait');
  assert.equal(childRequests.indexOf(childComplete), childRequests.indexOf(statusRequest) + 1, 'The next child turn after getstatus must be its final continuation');
  const parentStartedAt = timestamp(parentSpawn.at);
  const statusAt = timestamp(statusRequest.at);
  const childCompleteAt = timestamp(childComplete.at);
  const parentCompleteAt = timestamp(parentComplete.at);
  assert.ok(parentStartedAt <= statusAt && statusAt < childCompleteAt && childCompleteAt <= parentCompleteAt, 'Parent must wait until its child finishes');

  const execution = exactlyOne((evidence.hookExecutions || []).filter((entry) => entry.tool_use_id === statusTool.id), 'Exactly one Hook must handle the child getstatus call');
  assert.equal(execution.event_name, 'PostToolUse');
  assert.equal(execution.status, 'succeeded', 'The Hook must complete successfully');
  assert.ok(execution.input?.agent_id, 'Hook input must identify the originating subagent');
  assert.deepEqual(execution.input.tool_input, { id }, 'Hook input must preserve the original id and arguments');
  const initialResults = statusResults(execution.input.tool_response);
  assert.ok(initialResults.length > 0 && initialResults.every((result) => result.id === id && result.status === 'running'), 'Original getstatus output must be running for the same id');
  const replacement = execution.response?.hookSpecificOutput?.updatedMCPToolOutput;
  assert.ok(typeof replacement === 'string' || Array.isArray(replacement), 'Native updatedMCPToolOutput must use a CLI-compatible string or content-block array');
  const replacementResults = statusResults(replacement);
  assert.ok(replacementResults.length > 0 && replacementResults.every((result) => result.id === id && result.status === 'success'), 'Native replacement must contain only success for the original id');
  assert.equal(execution.response.hookSpecificOutput.hookEventName, 'PostToolUse');
  const action = exactlyOne(Object.values(execution.actions || {}).map((entry) => entry.output).filter((output) => output?.deliveredTo === 'subagent'), 'Hook output must be delivered inline to the child');
  assert.equal(action.scheduled, true, 'Child Hook must use the shared persisted scheduler');
  assert.equal(action.agentId, execution.input.agent_id, 'Hook must deliver to the originating child');
  assert.equal(action.status, 'succeeded', 'Loop must exit successfully');
  assert.ok(Number.isInteger(action.attemptCount) && action.attemptCount > 1, 'Hook must perform repeated MCP polling');

  const demo = evidence.getstatusDemo;
  assert.ok(demo?.api && demo?.mcp, 'Evidence must include the separate getstatus API and MCP services');
  const jobs = evidence.mcpLoopJobs ?? demo.jobs;
  assert.ok(Array.isArray(jobs), 'Evidence must include persisted MCP loop jobs for isolation verification');
  const scheduledJob = exactlyOne(jobs.filter((job) => job.tool_use_id === statusTool.id), 'The subagent Hook must persist exactly one shared scheduler job');
  assert.equal(scheduledJob.id, action.jobId, 'Hook output must reference its persisted scheduler job');
  assert.equal(scheduledJob.session_id, execution.session_id, 'Persisted loop job must stay in the originating session');
  assert.equal(scheduledJob.status, 'succeeded');
  assert.equal(scheduledJob.attempt_count, action.attemptCount);
  assert.equal(jobs.filter((job) => job.session_id === execution.session_id).length, 1, 'The child run must not create an additional parent loop job');
  assert.ok(demo.api.instanceId && demo.mcp.instanceId && demo.api.instanceId !== demo.mcp.instanceId, 'API and MCP must have distinct service instances');
  assert.ok(demo.api.hostname && demo.mcp.hostname && demo.api.hostname !== demo.mcp.hostname, 'API and MCP must run in separate remote service containers');
  const record = exactlyOne((demo.api.records || []).filter((item) => item.id === id), 'API must keep one record for the original id');
  assert.equal(record.durationMs, TWENTY_MINUTES_MS, 'API record must require twenty real minutes');
  assert.equal(demo.api.durationMs, TWENTY_MINUTES_MS, 'API default duration must be twenty minutes');
  assert.ok(timestamp(demo.api.startedAtMs) <= record.createdAtMs && timestamp(demo.mcp.startedAtMs) <= record.createdAtMs, 'Both real services must start before the initial request');
  assert.ok(statusAt <= record.createdAtMs, 'API must create the id only after the child first invokes getstatus');
  const runCalls = (demo.mcp.calls || []).filter((call) => call.startedAtMs >= parentStartedAt && call.startedAtMs <= parentCompleteAt);
  assert.ok(runCalls.length > 2, 'MCP must record the original getstatus call and repeated Hook polls');
  assert.ok(runCalls.every((call) => call.toolName === 'getstatus'), 'There must be no execute_task or other MCP operation during this run');
  assert.ok(runCalls.every((call) => Object.keys(call.input || {}).length === 1 && call.input.id === id && call.output?.id === id && !call.error), 'Every real MCP call must preserve the same id and arguments without errors');
  assert.equal(runCalls.length, action.attemptCount + 1, 'Every Hook attempt must map to one MCP call in addition to the original call');
  const observations = (demo.api.observations || []).filter((item) => item.id === id);
  assert.equal(observations.length, runCalls.length, 'Every MCP call must reach the independent HTTP API exactly once');
  assert.equal(runCalls[0].output.status, 'running', 'The initial MCP response must be running');
  assert.equal(observations[0].firstSeen, true, 'The first HTTP request must create the id');
  assert.equal(observations[0].elapsed_ms, 0, 'The API clock must begin at its first request');
  assert.equal(observations[0].created_at_ms, record.createdAtMs, 'The API must start its timer on the first request');
  assert.ok(runCalls[0].startedAtMs <= record.createdAtMs && record.createdAtMs <= runCalls[0].completedAtMs, 'API timer creation must occur inside the first real MCP request');

  for (const [index, call] of runCalls.entries()) {
    const observation = observations[index];
    const { firstSeen, ...response } = observation;
    assert.equal(firstSeen, index === 0, 'Only the first HTTP request may create the id');
    assert.deepEqual(call.output, response, `MCP call ${index + 1} must return the actual HTTP API response`);
    assert.equal(observation.created_at_ms, record.createdAtMs, 'Repeated requests must never reset the original timer');
    assert.equal(observation.duration_ms, TWENTY_MINUTES_MS);
    assert.equal(observation.elapsed_ms, observation.observed_at_ms - record.createdAtMs, 'API elapsed time must match recorded wall-clock timestamps');
    assert.ok(call.startedAtMs <= observation.observed_at_ms && observation.observed_at_ms <= call.completedAtMs, 'API observation must happen during its corresponding MCP call');
    assert.ok(call.completedAtMs - call.startedAtMs < 15_000, 'getstatus must return promptly; the MCP tool itself must not sleep for twenty minutes');
    if (index > 0) assert.ok(runCalls[index - 1].completedAtMs <= call.startedAtMs, 'Hook polls must be sequential');
    if (index < runCalls.length - 1) {
      assert.equal(observation.status, 'running', 'All earlier API replies must be running');
      assert.ok(observation.elapsed_ms < TWENTY_MINUTES_MS, 'API must return success once twenty minutes have elapsed');
      assert.equal(observation.finished_at_ms, null, 'A running id must have no completion timestamp');
    } else {
      assert.equal(observation.status, 'success', 'The last actual API reply must be success');
      assert.ok(observation.elapsed_ms >= TWENTY_MINUTES_MS, 'API must not return success before twenty wall-clock minutes');
      assert.equal(observation.finished_at_ms, record.createdAtMs + TWENTY_MINUTES_MS, 'Success timestamp must follow the first-request deadline');
    }
  }

  const final = observations.at(-1);
  const hookStart = timestamp(execution.started_at_ms);
  const hookEnd = timestamp(execution.completed_at_ms);
  assert.ok(hookStart >= runCalls[0].completedAtMs, 'PostToolUse Hook must start after the initial MCP response');
  assert.ok(hookEnd >= runCalls.at(-1).completedAtMs, 'Hook must wait for the final real MCP success response');
  assert.ok(hookEnd >= record.createdAtMs + TWENTY_MINUTES_MS, 'Hook must not exit before the API deadline');
  assert.ok(execution.duration_ms >= hookEnd - hookStart - 1, 'Stored Hook duration must agree with actual timestamps');
  assert.ok(childCompleteAt >= hookEnd, 'Child model must resume only after Hook completion');
  const childStatusBlock = exactlyOne(resultBlocks(childComplete, statusTool.id), 'Child must receive one replacement for the original getstatus call');
  assert.notEqual(childStatusBlock.is_error, true, 'Child must receive a valid tool result, not a CLI error');
  const received = statusResults(childStatusBlock);
  assert.ok(received.length > 0 && received.every((result) => result.id === id && result.status === 'success'), 'Child must see only success for getstatus; original running must be replaced');
  for (const complete of [childComplete, parentComplete]) {
    assert.equal(complete.observedStatus, 'success', 'Child and parent must report the observed success');
    assert.equal(complete.taskId, id, 'Child and parent must preserve the original id');
  }

  return {
    passed: true, run, id, sessionId: execution.session_id, agentId: execution.input.agent_id,
    hookExecutionId: execution.id,
    firstApiRequestAt: new Date(record.createdAtMs).toISOString(),
    finalApiSuccessAt: new Date(final.observed_at_ms).toISOString(),
    apiObservedElapsedMs: final.elapsed_ms, hookElapsedMs: hookEnd - hookStart,
    childModelWaitMs: childCompleteAt - statusAt,
    childModelGetstatusCalls: 1, actualMcpGetstatusCalls: runCalls.length,
    actualApiRequests: observations.length, hookPollAttempts: action.attemptCount,
    longestMcpRequestMs: Math.max(...runCalls.map((call) => call.completedAtMs - call.startedAtMs)),
    childModelTurnsDuringWait: 0, parentModelTurnsDuringWait: 0, parentMcpCalls: 0,
    parentScheduledLoopJobs: 0, persistedChildLoopJobs: 1,
    originalStatus: 'running', replacedStatus: 'success',
    apiService: { instanceId: demo.api.instanceId, startedAtMs: demo.api.startedAtMs, pid: demo.api.pid, hostname: demo.api.hostname },
    mcpService: { instanceId: demo.mcp.instanceId, startedAtMs: demo.mcp.startedAtMs, pid: demo.mcp.pid, hostname: demo.mcp.hostname, apiUrl: demo.mcp.apiUrl },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const source = option('--evidence', 'http://127.0.0.1:3914/evidence');
  const evidence = /^https?:\/\//.test(source)
    ? await fetch(source).then(async (response) => { assert.ok(response.ok, `Evidence HTTP ${response.status}`); return response.json(); })
    : JSON.parse(await readFile(source, 'utf8'));
  const report = verifySubagentGetstatusEvidence(evidence, { run: option('--run') });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const output = option('--output');
  if (output) await writeFile(output, text);
  process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Subagent getstatus verification failed: ${error.message}`); process.exitCode = 1; });
}
