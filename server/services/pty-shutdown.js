export const PTY_SHUTDOWN_POLICY = Object.freeze({
  DRAIN: 'drain',
  TERMINATE: 'terminate',
});

export function getPtyShutdownPolicy({ isPlainShell, initialCommand }) {
  return isPlainShell && typeof initialCommand === 'string' && initialCommand.trim()
    ? PTY_SHUTDOWN_POLICY.DRAIN
    : PTY_SHUTDOWN_POLICY.TERMINATE;
}

export function getBlockingPtySessionCount(sessions) {
  let count = 0;
  for (const session of sessions) {
    if (session?.shutdownPolicy === PTY_SHUTDOWN_POLICY.DRAIN) count += 1;
  }
  return count;
}

export function terminatePtySessions(sessionMap, {
  clearTimer = clearTimeout,
} = {}) {
  let terminated = 0;
  for (const [key, session] of sessionMap) {
    if (session?.timeoutId) clearTimer(session.timeoutId);
    try {
      session?.pty?.kill?.();
    } catch {
      // Continue terminating the remaining PTYs if one process already exited.
    }
    sessionMap.delete(key);
    terminated += 1;
  }
  return terminated;
}
