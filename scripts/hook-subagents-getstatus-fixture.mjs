import { randomUUID } from 'node:crypto';
import { readToolPayload } from './hook-subagents-fixture-payload.mjs';

export function findGetstatusResult(value) {
  if (typeof value === 'string') return findGetstatusResult(readToolPayload(value));
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id === 'string' && ['running', 'success', 'failed'].includes(value.status)) return value;
  for (const nested of Object.values(value)) {
    const task = findGetstatusResult(nested);
    if (task) return task;
  }
  return null;
}

export function nextGetstatusResponse({ tools, messages, child, actor, run, usedId, tool, statusToolName }) {
  const results = messages.filter((message) => message.role === 'user')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'tool_result');
  const resultFor = (suffix) => results.find((block) => block.tool_use_id === `toolu_${run}_${actor}_${suffix}`);
  const final = (phase, text, details = {}) => ({ actor, run, phase, correctionSeen: false, content: [{ type: 'text', text }], ...details });
  if (!child) {
    if (!usedId('spawn-A') && (tools.has('Agent') || tools.has('Task'))) {
      return { actor, run, phase: 'getstatus-spawn-child', correctionSeen: false, content: [tool('spawn-A', tools.has('Agent') ? 'Agent' : 'Task', {
        description: 'Poll an independent twenty-minute status service', subagent_type: 'general-purpose', run_in_background: false,
        prompt: `FIXTURE_CHILD_ROLE=A RUN=${run}. Generate one random UUID and call the real ${statusToolName} MCP tool exactly once with {id: that UUID}. The independent HTTP service starts tracking the ID on its first request and reports running until twenty real minutes have elapsed. A PostToolUse hook will poll the same tool with that same ID until success and replace the initial tool result. Report the status and id you actually observed in the final getstatus result. Do not use execute_task, Bash, a simulated status, or repeat getstatus yourself.`,
      })] };
    }
    const childResult = JSON.stringify(resultFor('spawn-A') || {});
    const taskId = childResult.match(/TASK_ID=([a-zA-Z0-9_-]+)/)?.[1] || 'unknown';
    const observedStatus = childResult.match(/STATUS=(success|running|failed)/)?.[1] || 'unknown';
    return final('getstatus-complete', `HOOK_SUBAGENTS_GETSTATUS_DONE RUN=${run} ACTOR=main TASK_ID=${taskId} STATUS=${observedStatus}`, { taskId, observedStatus });
  }
  const statusName = [...tools].find((name) => name === statusToolName);
  if (!statusName && tools.has('ToolSearch') && !usedId('discover')) {
    return { actor, run, phase: 'getstatus-discover-tools', correctionSeen: false, content: [tool('discover', 'ToolSearch', { query: `select:${statusToolName}`, max_results: 1 })] };
  }
  if (!usedId('status')) {
    if (!statusName) return final('getstatus-error', `FIXTURE_ERROR RUN=${run} missing real MCP getstatus tool`);
    const taskId = randomUUID();
    return { actor, run, phase: 'getstatus-call', correctionSeen: false, taskId, content: [tool('status', statusName, { id: taskId })] };
  }
  const observed = findGetstatusResult(resultFor('status'));
  const originalCall = messages.filter((message) => message.role === 'assistant')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => block.type === 'tool_use' && block.id === `toolu_${run}_${actor}_status`);
  if (!observed || observed.id !== originalCall?.input?.id) {
    return final('getstatus-error', `FIXTURE_ERROR RUN=${run} getstatus did not return the original id and a valid status`);
  }
  return final('getstatus-complete', `HOOK_SUBAGENTS_GETSTATUS_DONE RUN=${run} ACTOR=${actor} TASK_ID=${observed.id} STATUS=${observed.status}`, { taskId: observed.id, observedStatus: observed.status });
}
