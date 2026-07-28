type RealtimeRefreshMessage = {
  type?: string;
  kind?: string;
  newSessionId?: string;
  sessionId?: string | null;
  actualSessionId?: string | null;
  exitCode?: number;
  aborted?: boolean;
  isProcessing?: boolean;
};

export function shouldRefreshProjectsForRealtimeMessage(message: RealtimeRefreshMessage): boolean {
  if (message.kind === 'session_created') {
    return Boolean(message.newSessionId || message.sessionId);
  }

  if (message.kind === 'complete') {
    return message.exitCode === 0
      && !message.aborted
      && Boolean(message.sessionId || message.actualSessionId);
  }

  return false;
}

export function shouldRefreshSessionHistoryForRealtimeMessage(message: RealtimeRefreshMessage): boolean {
  if (
    message.type === 'session-status' &&
    message.isProcessing === false
  ) {
    return Boolean(message.sessionId);
  }

  if (message.kind === 'complete') {
    return message.exitCode === 0
      && !message.aborted
      && Boolean(message.sessionId || message.actualSessionId);
  }

  return false;
}

export function scheduleProjectsRefresh(delayMs: number) {
  if (typeof window === 'undefined' || !window.refreshProjects) return;
  window.setTimeout(() => {
    void window.refreshProjects?.();
  }, delayMs);
}
