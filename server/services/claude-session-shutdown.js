export async function closeClaudeSessionForShutdown({
  sessionId,
  session,
  abortProcessing,
}) {
  if (session.idleCloseTimer) {
    clearTimeout(session.idleCloseTimer);
    session.idleCloseTimer = null;
  }

  let abortError = null;
  if (session.status === 'processing') {
    try {
      const aborted = await abortProcessing(sessionId);
      if (aborted === true) {
        return { abortError, closeError: null };
      }
    } catch (error) {
      abortError = error;
    }
  }

  // Idle streams still own a reusable Claude child. A failed processing abort
  // also falls back to close, but never races close against interrupt.
  session.inputQueue?.close();
  let closeError = null;
  try {
    await Promise.resolve(session.instance?.close?.());
  } catch (error) {
    closeError = error;
  }
  return { abortError, closeError };
}
