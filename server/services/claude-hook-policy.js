export function isRequiredStopHook(hook) {
  return hook?.eventName === 'Stop' && hook.extensionLogic?.failClosed === true;
}

export function createRequiredStopHookError(cause) {
  const error = new Error('必需的 Stop 校验无法启动，已终止当前执行；请修复 Hook 配置后重试。', { cause });
  error.code = 'REQUIRED_STOP_HOOK_UNAVAILABLE';
  return error;
}

/** Optional legacy hooks may be removed for SDK compatibility; required checks may not. */
export function createClaudeQueryWithHookFallback({
  query, prompt, options, hasRequiredStopHook = false, onFallback = () => {},
}) {
  try {
    return query({ prompt, options });
  } catch (error) {
    if (hasRequiredStopHook) throw createRequiredStopHookError(error);
    onFallback(error);
    const fallbackOptions = { ...options };
    delete fallbackOptions.hooks;
    return query({ prompt, options: fallbackOptions });
  }
}
