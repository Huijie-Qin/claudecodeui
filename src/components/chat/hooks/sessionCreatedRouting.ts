interface CreatedSessionRoutingArgs {
  newSessionId?: string | null;
  currentSessionId: string | null;
  selectedSessionId: string | null;
  hasPendingViewSession: boolean;
}

const isTemporarySessionId = (sessionId: string | null | undefined) =>
  Boolean(sessionId && sessionId.startsWith('new-session-'));

export function shouldAdoptCreatedSession({
  newSessionId,
  currentSessionId,
  selectedSessionId,
  hasPendingViewSession,
}: CreatedSessionRoutingArgs): boolean {
  return Boolean(
    newSessionId &&
    hasPendingViewSession &&
    !selectedSessionId &&
    (!currentSessionId || isTemporarySessionId(currentSessionId)),
  );
}
