export function requestActiveWorkShutdown({
  closeAllClaudeSessions,
  listProviderCommands = () => [],
  listCursorSessions,
  abortCursorSession,
  listCodexSessions,
  abortCodexSession,
  listGeminiSessions,
  abortGeminiSession,
  abortAgentGraphRuns,
  abortTopSkillJobs,
}) {
  const pendingProviderCommands = listProviderCommands().filter((command) => (
    !command.registeredSessionId && typeof command.abortPending === 'function'
  ));
  const cursorSessionIds = listCursorSessions();
  const codexSessionIds = listCodexSessions().map((session) => session.id);
  const geminiSessionIds = listGeminiSessions();

  for (const command of pendingProviderCommands) command.abortPending();
  for (const sessionId of cursorSessionIds) abortCursorSession(sessionId);
  for (const sessionId of codexSessionIds) abortCodexSession(sessionId);
  for (const sessionId of geminiSessionIds) abortGeminiSession(sessionId);

  const agentGraphRuns = abortAgentGraphRuns();
  const topSkillJobs = abortTopSkillJobs();
  const claudeCompletion = Promise.resolve().then(() => closeAllClaudeSessions());

  return {
    summary: {
      pendingProviderCommands: pendingProviderCommands.length,
      cursor: cursorSessionIds.length,
      codex: codexSessionIds.length,
      gemini: geminiSessionIds.length,
      agentGraph: agentGraphRuns,
      topSkillJobs,
    },
    completion: Promise.allSettled([claudeCompletion]),
  };
}
