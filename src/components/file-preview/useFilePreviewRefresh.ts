import { useContext, useEffect, useState } from 'react';

import WebSocketContext from '../../contexts/WebSocketContext';
import { subscribeProjectFilesChanged, type ProjectFilesChangedEvent } from '../file-tree/utils/fileTreeEvents';

import { shouldRefreshFilePreview, type FilePreviewRefreshTarget } from './filePreviewRefresh';

/** Invalidate only binary previews, leaving unsaved text editor contents untouched. */
export function useFilePreviewRefresh({ path, displayPath, projectPath, projectName, workspaceId }: FilePreviewRefreshTarget): number {
  // Standalone previews do not require an authenticated WebSocket provider.
  const subscribeMessage = useContext(WebSocketContext)?.subscribeMessage;
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFilesChanged = (event: ProjectFilesChangedEvent) => {
      if (!shouldRefreshFilePreview({ path, displayPath, projectPath, projectName, workspaceId }, event)) return;
      // An upload normally arrives once through the local bus and once over WebSocket.
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 100);
    };
    const unsubscribeLocal = subscribeProjectFilesChanged(onFilesChanged);
    const unsubscribeSocket = subscribeMessage?.((message: ProjectFilesChangedEvent & { type?: string } | null) => {
      if (message?.type === 'files_changed') onFilesChanged(message);
    });

    return () => {
      clearTimeout(timer);
      unsubscribeLocal();
      unsubscribeSocket?.();
    };
  }, [path, displayPath, projectPath, projectName, workspaceId, subscribeMessage]);

  return revision;
}
