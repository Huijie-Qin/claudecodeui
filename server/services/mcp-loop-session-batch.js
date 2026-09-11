import { buildMcpLoopReplacement } from './mcp-loop-service.js';

function readContentBlocks(message) {
  const content = message?.message?.content ?? message?.content;
  return Array.isArray(content) ? content : [];
}

export function createMcpLoopToolBatchTracker(toolNames = []) {
  const matchedToolNames = new Set(
    (Array.isArray(toolNames) ? toolNames : [])
      .map((name) => (typeof name === 'string' ? name.trim() : ''))
      .filter(Boolean),
  );
  const expectedToolUseIds = new Set();
  const completedToolUseIds = new Set();
  let readySignaled = false;

  const addExpected = (toolUseId) => {
    const normalized = typeof toolUseId === 'string' ? toolUseId.trim() : '';
    if (!normalized || expectedToolUseIds.has(normalized)) return false;
    expectedToolUseIds.add(normalized);
    readySignaled = false;
    return true;
  };

  const readReadySignal = () => {
    const ready = expectedToolUseIds.size > 0
      && [...expectedToolUseIds].every((toolUseId) => completedToolUseIds.has(toolUseId));
    if (!ready || readySignaled) return false;
    readySignaled = true;
    return true;
  };

  return {
    addExpected,
    observe(message) {
      if (message?.parent_tool_use_id) return false;
      const blocks = readContentBlocks(message);
      if (message?.type === 'assistant') {
        for (const block of blocks) {
          if (block?.type === 'tool_use' && matchedToolNames.has(block.name)) {
            addExpected(block.id);
          }
        }
      } else if (message?.type === 'user') {
        for (const block of blocks) {
          if (block?.type === 'tool_result' && expectedToolUseIds.has(block.tool_use_id)) {
            completedToolUseIds.add(block.tool_use_id);
          }
        }
      }
      return readReadySignal();
    },
    snapshot() {
      return {
        expectedToolUseIds: [...expectedToolUseIds],
        completedToolUseIds: [...completedToolUseIds],
      };
    },
  };
}

export function buildMcpLoopBatchModelContent(jobs = []) {
  const orderedJobs = [...jobs].sort((left, right) => (
    Number(left?.startedAtMs || 0) - Number(right?.startedAtMs || 0)
      || String(left?.id || '').localeCompare(String(right?.id || ''))
  ));
  const resultBlocks = orderedJobs.flatMap((job) => {
    const replacement = buildMcpLoopReplacement(job);
    return [
      `<ccui-mcp-loop-result job-id="${job.id}" tool-use-id="${job.toolUseId}" status="${job.status}">`,
      JSON.stringify(replacement.payload),
      '</ccui-mcp-loop-result>',
    ];
  });

  return [
    `<ccui-mcp-loop-results count="${orderedJobs.length}">`,
    ...resultBlocks,
    '</ccui-mcp-loop-results>',
    '',
    'Each payload above replaces the original MCP tool result for its referenced tool-use-id.',
    'Continue the original user request using all final results.',
    'Do not repeat the completed MCP loops or call the same status tools again unless the user explicitly asks.',
  ].join('\n');
}
