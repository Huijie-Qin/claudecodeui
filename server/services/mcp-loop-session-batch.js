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
    if (typeof job.resultFile !== 'string' || !job.resultFile) {
      throw new Error('MCP loop result file must be saved before resuming the conversation');
    }
    return [
      `<ccui-mcp-loop-result job-id="${job.id}" tool-use-id="${job.toolUseId}">`,
      JSON.stringify({ resultFile: job.resultFile }),
      '</ccui-mcp-loop-result>',
    ];
  });

  return [
    `<ccui-mcp-loop-results count="${orderedJobs.length}">`,
    ...resultBlocks,
    '</ccui-mcp-loop-results>',
    '',
    'Final MCP loop results are saved in the files above; only file paths are included here.',
    'Read the files as needed to continue the original user request. Each file corresponds to its referenced tool-use-id.',
    'Do not repeat the completed MCP loops or call the same status tools again unless the user explicitly asks.',
  ].join('\n');
}
