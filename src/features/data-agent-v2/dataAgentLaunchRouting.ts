import type { LLMProvider } from '../../types/app';

type LaunchMessage = {
  kind?: string;
  provider?: string;
  sessionId?: unknown;
  newSessionId?: unknown;
  scheduledTaskId?: unknown;
  failed?: boolean;
  content?: unknown;
};

export type DataAgentLaunchOutcome =
  | { type: 'ignore' }
  | { type: 'await-error'; sessionId: string }
  | { type: 'created'; sessionId: string }
  | { type: 'failed'; message: string };

export function isProvisionalDataAgentSessionId(sessionId?: string | null) {
  return Boolean(sessionId?.startsWith('pending:'));
}

export function resolveDataAgentLaunchMessage(
  message: LaunchMessage,
  pendingProvider: LLMProvider,
  failureSessionId?: string | null,
): DataAgentLaunchOutcome {
  if (message.scheduledTaskId != null || (message.provider && message.provider !== pendingProvider)) {
    return { type: 'ignore' };
  }

  if (message.kind === 'session_created') {
    const sessionId = String(message.newSessionId || message.sessionId || '');
    if (!sessionId) return { type: 'ignore' };
    if (message.failed || isProvisionalDataAgentSessionId(sessionId)) {
      return { type: 'await-error', sessionId };
    }
    return { type: 'created', sessionId };
  }

  if (message.kind === 'error') {
    const sessionId = String(message.sessionId || '');
    const matchesFailedLaunch = failureSessionId
      ? sessionId === failureSessionId
      : isProvisionalDataAgentSessionId(sessionId);
    if (!matchesFailedLaunch) return { type: 'ignore' };

    const content = typeof message.content === 'string' ? message.content.trim() : '';
    return {
      type: 'failed',
      message: content || '任务启动失败，未能建立有效会话。',
    };
  }

  return { type: 'ignore' };
}
