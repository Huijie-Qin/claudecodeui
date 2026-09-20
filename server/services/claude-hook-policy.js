export function isRequiredHook(hook) {
  return hook?.eventName === 'PreToolUse' && (hook.extensionLogic?.failClosed === true
    || hook.postActions?.some((action) => action.type === 'request_confirmation') === true);
}

export function createRequiredHookError(cause) {
  const error = new Error('必需的 Hook 校验无法启动，已终止当前执行；请修复 Hook 配置后重试。', { cause });
  error.code = 'REQUIRED_HOOK_UNAVAILABLE';
  return error;
}

/** Optional legacy hooks may be removed for SDK compatibility; required checks may not. */
export function createClaudeQueryWithHookFallback({
  query, prompt, options, hasRequiredHook = false, onFallback = () => {},
}) {
  try {
    return query({ prompt, options });
  } catch (error) {
    if (hasRequiredHook) throw createRequiredHookError(error);
    onFallback(error);
    const fallbackOptions = { ...options };
    delete fallbackOptions.hooks;
    return query({ prompt, options: fallbackOptions });
  }
}
