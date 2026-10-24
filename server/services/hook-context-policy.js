// Keep control decisions effective without handing Hook payloads to the model.
export function filterHookContextResponse(hook, response) {
  if (hook.injectToContext !== false) return response;
  const result = { ...response };
  delete result.reason;
  delete result.stopReason;
  delete result.systemMessage;
  if (result.decision === 'block') {
    if (hook.eventName === 'Stop' || hook.eventName === 'SubagentStop') {
      // A Stop block without feedback would repeatedly ask the model to retry.
      result.continue = false;
      delete result.decision;
    } else {
      result.reason = 'Hook 已拒绝本次操作，详情见 Hook 执行记录。';
    }
  }
  if (result.hookSpecificOutput) {
    const specific = { ...result.hookSpecificOutput };
    for (const key of ['additionalContext', 'initialUserMessage', 'updatedMCPToolOutput', 'content']) {
      delete specific[key];
    }
    delete specific.permissionDecisionReason;
    if (specific.permissionDecision === 'deny') {
      specific.permissionDecisionReason = 'Hook 已拒绝本次工具调用，详情见 Hook 执行记录。';
    } else if (specific.permissionDecision === 'ask') {
      specific.permissionDecisionReason = '此工具调用需要用户确认。';
    }
    if (specific.decision && typeof specific.decision === 'object') {
      specific.decision = { ...specific.decision };
      delete specific.decision.message;
      if (specific.decision.behavior === 'deny') {
        specific.decision.message = 'Hook 已拒绝本次工具调用，详情见 Hook 执行记录。';
      }
    }
    if (Object.keys(specific).some((key) => key !== 'hookEventName')) result.hookSpecificOutput = specific;
    else delete result.hookSpecificOutput;
  }
  return result;
}
