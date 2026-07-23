interface CreatedSessionRoutingArgs {
  newSessionId?: string | null;
  currentSessionId: string | null;
  selectedSessionId: string | null;
  hasPendingViewSession: boolean;
  isBackgroundSession?: boolean;
}

const isTemporarySessionId = (sessionId: string | null | undefined) =>
  Boolean(sessionId && sessionId.startsWith('new-session-'));

export function shouldAdoptCreatedSession({
  newSessionId,
  currentSessionId,
  selectedSessionId,
  hasPendingViewSession,
  isBackgroundSession = false,
}: CreatedSessionRoutingArgs): boolean {
  return Boolean(
    newSessionId &&
    !isBackgroundSession &&
    hasPendingViewSession &&
    !selectedSessionId &&
    (!currentSessionId || isTemporarySessionId(currentSessionId)),
  );
}
