// Read-only acceptance checker for the real twenty-minute browser/CLI fixture.
// node scripts/verify-subagent-loop-e2e.mjs --run loop20_browser --evidence /path/evidence.json
// Omit --evidence to fetch the isolated fixture at http://127.0.0.1:3912/evidence.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TWENTY_MINUTES_MS = 1_200_000;
const STATUS_TOOL_SUFFIX = '__get_task_status';
const EXECUTE_TOOL_SUFFIX = '__execute_task';

function taskResults(value) {
  if (typeof value === 'string') {
    // The real CLI may append its agent catalog reminder after a JSON MCP
    // result. Inspect only the result, never text inside the appended reminder.
    const reminderStart = value.search(/(?:\r?\n)+<system-reminder>/);
    const json = reminderStart === -1 ? value : value.slice(0, reminderStart);
    try { return taskResults(JSON.parse(json)); } catch { return []; }
  }
  if (!value || typeof value !== 'object') return [];
  if (typeof value.task_id === 'string' && ['running', 'success', 'failed'].includes(value.status)) return [value];
  return Object.values(value).flatMap(taskResults);
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

function timestamp(value, message) {
  const result = typeof value === 'number' ? value : Date.parse(value);
  assert.ok(Number.isFinite(result), message);
  return result;
}

export function verifySubagentLoopEvidence(evidence, { run, expectedStatus = 'success' } = {}) {
  assert.ok(typeof run === 'string' && run.startsWith('loop20'), 'A loop20 RUN identifier is required');
  assert.ok(['success', 'failed'].includes(expectedStatus), 'Expected terminal status must be success or failed');
  const requests = (evidence.modelRequests || []).filter((entry) => entry.run === run && entry.phase !== 'auxiliary');
  const childRequests = requests.filter((entry) => entry.actor === 'child-A');
  const parentRequests = requests.filter((entry) => entry.actor === 'main');
  assert.ok(childRequests.length > 0, 'Evidence must contain actual child model requests');
  assert.ok(!requests.some((entry) => entry.phase === 'loop-error'), 'Fixture must not report a loop error');
  const executeRequest = exactlyOne(childRequests.filter((entry) => emittedTools(entry).some((tool) => tool.name.endsWith(EXECUTE_TOOL_SUFFIX))), 'Child must emit exactly one execute_task call');
  const statusRequest = exactlyOne(childRequests.filter((entry) => emittedTools(entry).some((tool) => tool.name.endsWith(STATUS_TOOL_SUFFIX))), 'Child must emit exactly one get_task_status call');
  const statusTool = exactlyOne(emittedTools(statusRequest).filter((tool) => tool.name.endsWith(STATUS_TOOL_SUFFIX)), 'Status call must be a single tool invocation');
  const executeTool = exactlyOne(emittedTools(executeRequest).filter((tool) => tool.name.endsWith(EXECUTE_TOOL_SUFFIX)), 'Submission must be a single tool invocation');
  const taskId = statusTool.input?.task_id;
  assert.ok(typeof taskId === 'string' && taskId.length > 0, 'Child must pass a real task_id to get_task_status');
  assert.ok(!parentRequests.some((entry) => emittedTools(entry).some((tool) => tool.name.endsWith(STATUS_TOOL_SUFFIX) || tool.name.endsWith(EXECUTE_TOOL_SUFFIX))), 'Parent must not submit or poll the MCP task');
  const parentSpawn = exactlyOne(parentRequests.filter((entry) => entry.phase === 'loop-spawn-child'), 'Parent must start one child');
  const childComplete = exactlyOne(childRequests.filter((entry) => entry.phase === 'loop-complete'), 'Child must complete once after the loop');
  const parentComplete = exactlyOne(parentRequests.filter((entry) => entry.phase === 'loop-complete'), 'Parent must complete once after its child');
  const statusAt = timestamp(statusRequest.at, 'Status model request needs a real timestamp');
  const childCompleteAt = timestamp(childComplete.at, 'Child completion needs a real timestamp');
  const parentCompleteAt = timestamp(parentComplete.at, 'Parent completion needs a real timestamp');
  const parentStartedAt = timestamp(parentSpawn.at, 'Parent start needs a real timestamp');
  assert.ok(timestamp(executeRequest.at, 'Submission model request needs a timestamp') <= statusAt, 'Child must submit before querying status');
  assert.ok(statusAt < childCompleteAt && childCompleteAt <= parentCompleteAt, 'Parent must wait for child completion');
  assert.equal(childRequests.indexOf(childComplete), childRequests.indexOf(statusRequest) + 1, 'The next child model turn after status must be its final continuation');
  assert.equal(childRequests.filter((entry) => timestamp(entry.at) > statusAt && timestamp(entry.at) < childCompleteAt).length, 0, 'There must be no child model turn during the Hook wait');
  const submitted = taskResults(resultBlocks(statusRequest, executeTool.id));
  assert.ok(submitted.length > 0 && submitted.every((task) => task.task_id === taskId && task.status === 'running'), 'execute_task must return the same task_id in running state');

  const execution = exactlyOne((evidence.hookExecutions || []).filter((entry) => entry.tool_use_id === statusTool.id), 'Exactly one Hook execution must handle the child status call');
  assert.equal(execution.event_name, 'PostToolUse', 'The loop must run as a PostToolUse Hook');
  assert.equal(execution.status, 'succeeded', 'The Hook callback must complete successfully');
  assert.ok(execution.input?.agent_id, 'Hook input must identify the originating subagent');
  assert.equal(execution.input.tool_input?.task_id, taskId, 'Hook input must preserve the submitted task_id');
  const initialResults = taskResults(execution.input.tool_response);
  assert.ok(initialResults.length > 0 && initialResults.every((task) => task.task_id === taskId && task.status === 'running'), 'The original status result must be running before replacement');
  const initial = initialResults[0];
  const replacement = execution.response?.hookSpecificOutput?.updatedMCPToolOutput;
  assert.ok(typeof replacement === 'string' || Array.isArray(replacement), 'Native updatedMCPToolOutput must be a string or content-block array; raw objects crash the CLI result renderer');
  const replacedTasks = taskResults(replacement);
  assert.ok(replacedTasks.length > 0 && replacedTasks.every((task) => task.task_id === taskId && task.status === expectedStatus), 'Native updatedMCPToolOutput must contain only the final task status and same task_id');
  assert.equal(execution.response.hookSpecificOutput.hookEventName, 'PostToolUse');
  const action = exactlyOne(Object.values(execution.actions || {}).map((entry) => entry.output).filter((output) => output?.deliveredTo === 'subagent'), 'The loop result must be delivered inline to the subagent');
  assert.equal(action.scheduled, false, 'Child loop must not schedule a parent continuation');
  assert.equal(action.agentId, execution.input.agent_id, 'Loop result must stay with the originating subagent');
  assert.equal(action.status, expectedStatus === 'success' ? 'succeeded' : 'failed');
  assert.ok(action.attemptCount > 1, 'The Hook must perform repeated MCP polling');

  const jobs = evidence.mcpLoopJobs ?? evidence.loopDemo?.jobs;
  assert.ok(Array.isArray(jobs), 'Evidence must include persisted MCP loop jobs for isolation verification');
  assert.equal(jobs.filter((job) => job.session_id === execution.session_id || job.tool_use_id === statusTool.id).length, 0, 'Subagent loop must create no parent scheduled loop job');
  const demo = evidence.loopDemo;
  assert.ok(demo?.taskService && demo?.mcp, 'Evidence must include the independent task and MCP services');
  const task = exactlyOne(demo.taskService.tasks.filter((item) => item.id === taskId), 'The submitted task must exist in the task server');
  assert.equal(task.durationMs, TWENTY_MINUTES_MS, 'The task server must use an actual twenty-minute task duration');
  assert.equal(demo.taskService.durationMs, TWENTY_MINUTES_MS, 'The task server default duration must also be twenty minutes');
  const submissions = demo.mcp.calls.filter((call) => call.toolName === 'execute_task' && call.startedAtMs >= parentStartedAt && call.startedAtMs <= parentCompleteAt);
  const submission = exactlyOne(submissions, 'The MCP service must receive only one submission throughout this run');
  assert.equal(submission.output?.task_id, taskId, 'Real MCP submission must match the child task_id');
  const polls = demo.mcp.calls.filter((call) => call.toolName === 'get_task_status' && call.input?.task_id === taskId);
  assert.ok(polls.length > 2, 'The MCP service must receive the original query and multiple Hook polls');
  assert.equal(polls.length, action.attemptCount + 1, 'Each recorded Hook attempt must correspond to one actual MCP poll, in addition to the original call');
  assert.equal(polls[0].output?.status, 'running', 'Initial MCP status query must return running');
  assert.ok(polls.every((poll) => poll.input.task_id === taskId && poll.output?.task_id === taskId && !poll.error), 'Every actual MCP poll must use the same task and succeed');
  assert.ok(polls.slice(0, -1).every((poll) => poll.output.status === 'running'), 'All earlier polls must remain running');
  const lastPoll = polls.at(-1);
  assert.equal(lastPoll.output.status, expectedStatus, 'The final actual MCP result must be terminal');
  assert.ok(lastPoll.startedAtMs - task.createdAtMs >= TWENTY_MINUTES_MS, 'Actual service request timestamps must span at least twenty wall-clock minutes');
  assert.ok(lastPoll.output.observed_at_ms - task.createdAtMs >= TWENTY_MINUTES_MS, 'Task observation must independently confirm the twenty-minute interval');
  assert.equal(lastPoll.output.finished_at_ms, task.createdAtMs + TWENTY_MINUTES_MS, 'Task completion timestamp must reflect its configured duration');
  assert.ok(demo.taskService.observations.filter((item) => item.task_id === taskId && item.operation === 'get_task_status').length === polls.length, 'Every MCP query must reach the separate task service');

  const hookStart = timestamp(execution.started_at_ms, 'Hook needs start timestamp');
  const hookEnd = timestamp(execution.completed_at_ms, 'Hook needs completion timestamp');
  assert.ok(hookStart >= task.createdAtMs, 'Hook must begin after submission');
  assert.ok(hookEnd >= task.createdAtMs + TWENTY_MINUTES_MS, 'Hook must wait through the task completion deadline');
  assert.ok(hookEnd - hookStart >= TWENTY_MINUTES_MS - (hookStart - task.createdAtMs), 'Hook wall-clock duration must cover the remaining task lifetime');
  assert.ok(execution.duration_ms >= hookEnd - hookStart - 1, 'Stored Hook duration must agree with its real timestamps');
  assert.ok(childCompleteAt >= hookEnd, 'Child model must resume only after the Hook completed');

  const childStatusBlocks = resultBlocks(childComplete, statusTool.id);
  assert.equal(childStatusBlocks.length, 1, 'Child continuation must receive one replacement for its original status tool call');
  assert.notEqual(childStatusBlocks[0].is_error, true, 'The replaced child MCP result must not be a CLI tool error');
  const observedResults = taskResults(childStatusBlocks);
  assert.ok(observedResults.length > 0 && observedResults.every((result) => result.status === expectedStatus && result.task_id === taskId), 'Child model must see only the final status for get_task_status; original running must be replaced');
  assert.equal(childComplete.observedStatus, expectedStatus, 'Child must report the observed final task status');
  assert.equal(childComplete.taskId, taskId);
  assert.equal(parentComplete.observedStatus, expectedStatus, 'Parent final answer must reflect the child result');
  assert.equal(parentComplete.taskId, taskId);

  return {
    passed: true, run, expectedStatus, taskId, agentId: execution.input.agent_id,
    sessionId: execution.session_id, hookExecutionId: execution.id,
    submittedAt: new Date(task.createdAtMs).toISOString(),
    completedAt: new Date(lastPoll.output.observed_at_ms).toISOString(),
    taskObservedElapsedMs: lastPoll.output.observed_at_ms - task.createdAtMs,
    hookElapsedMs: hookEnd - hookStart,
    childModelWaitMs: childCompleteAt - statusAt,
    taskSubmissions: submissions.length, childModelStatusCalls: 1,
    actualMcpStatusCalls: polls.length, hookPollAttempts: action.attemptCount,
    childModelTurnsDuringWait: 0, parentMcpCalls: 0, parentScheduledLoopJobs: 0,
    originalStatus: initial.status, replacedStatus: expectedStatus,
    taskServiceInstanceId: demo.taskService.instanceId,
    mcpServiceInstanceId: demo.mcp.instanceId,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const source = option('--evidence', 'http://127.0.0.1:3912/evidence');
  const evidence = /^https?:\/\//.test(source)
    ? await fetch(source).then(async (response) => { assert.ok(response.ok, `Evidence HTTP ${response.status}`); return response.json(); })
    : JSON.parse(await readFile(source, 'utf8'));
  const report = verifySubagentLoopEvidence(evidence, { run: option('--run'), expectedStatus: option('--expected-status', 'success') });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const output = option('--output');
  if (output) await writeFile(output, text);
  process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Subagent loop verification failed: ${error.message}`); process.exitCode = 1; });
}
