export const SUBAGENT_HISTORY_SYNC_INTERVAL_MS = 3_000;

/**
 * Task progress carries usage, but does not guarantee child transcript events.
 * Read persisted child output while the panel is open, independently of parent
 * stream activity. A final delayed read covers the CLI's asynchronous writes.
 */
export function startSubagentHistorySync({
  refreshHistory,
  isRunning,
  onError,
}: {
  refreshHistory: () => Promise<void>;
  isRunning: boolean;
  onError: (error: unknown) => void;
}) {
  let stopped = false;
  let finalReadPending = !isRunning;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh() {
    if (stopped) return;
    try {
      await refreshHistory();
    } catch (error) {
      if (!stopped) onError(error);
    }
    if (!stopped && (isRunning || finalReadPending)) {
      finalReadPending = false;
      // Schedule after the response, so a slow history read cannot pile up.
      timer = setTimeout(() => { void refresh(); }, SUBAGENT_HISTORY_SYNC_INTERVAL_MS);
    }
  }

  void refresh();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
