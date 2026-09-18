export function readSessionForkMetadata(session) {
  try {
    const metadata = typeof session?.metadata_json === 'string'
      ? JSON.parse(session.metadata_json) : session?.metadata;
    return metadata?.fork && typeof metadata.fork === 'object' ? metadata.fork : null;
  } catch {
    return null;
  }
}

export function sessionForkSummaryFields(session) {
  const fork = readSessionForkMetadata(session);
  return typeof fork?.parentSessionId === 'string' && typeof fork?.sourceMessageUuid === 'string'
    ? { parentSessionId: fork.parentSessionId, sourceMessageUuid: fork.sourceMessageUuid }
    : {};
}
