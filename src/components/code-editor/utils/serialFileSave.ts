type SerialFileSaveOptions = {
  getContent: () => string;
  isDirty: () => boolean;
  persist: (content: string) => Promise<boolean>;
  markClean: () => void;
};

/** Serializes saves for one editor and drains changes made while a save is in flight. */
export function createSerialFileSave({ getContent, isDirty, persist, markClean }: SerialFileSaveOptions) {
  let inFlight: Promise<boolean> | null = null;

  return async function flush(): Promise<boolean> {
    if (inFlight) return inFlight;
    if (!isDirty()) return true;

    const pending = (async () => {
      while (isDirty()) {
        const snapshot = getContent();
        if (!await persist(snapshot)) return false;
        if (getContent() === snapshot) markClean();
      }
      return true;
    })();
    inFlight = pending;
    try {
      return await pending;
    } finally {
      if (inFlight === pending) inFlight = null;
    }
  };
}
