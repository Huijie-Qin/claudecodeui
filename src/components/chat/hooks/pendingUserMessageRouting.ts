interface PendingUserMessageFlushArgs {
  activeSessionId: string | null;
  previousActiveSessionId: string | null;
  selectedSessionId: string | null;
  hasPendingUserMessage: boolean;
}

interface PendingUserMessageViewArgs {
  selectedSessionId: string | null;
  storeMessageCount: number;
  hasPendingUserMessage: boolean;
}

export function shouldFlushPendingUserMessageToSession({
  activeSessionId,
  previousActiveSessionId,
  selectedSessionId,
  hasPendingUserMessage,
}: PendingUserMessageFlushArgs): boolean {
  return Boolean(
    hasPendingUserMessage &&
    activeSessionId &&
    activeSessionId !== previousActiveSessionId &&
    !selectedSessionId,
  );
}

export function shouldShowPendingUserMessageInView({
  selectedSessionId,
  storeMessageCount,
  hasPendingUserMessage,
}: PendingUserMessageViewArgs): boolean {
  return Boolean(hasPendingUserMessage && !selectedSessionId && storeMessageCount === 0);
}
