import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { createClientMessageId } from '../../../utils/clientMessageId';
import type { Project, ProjectSession } from '../../../types/app';
import type { ChatMessage, ChatInterfaceProps } from '../types/types';
import { canForkMessage } from '../utils/sessionFork';

type ForkState = { viewKey: string; sourceMessageUuid: string; error?: string; pending: boolean };

export function useChatSessionFork({
  selectedProject,
  sessionId,
  provider,
  isProcessing,
  onNavigateToSession,
}: {
  selectedProject: Project | null;
  sessionId: string | null;
  provider: string;
  isProcessing: boolean;
  onNavigateToSession: ChatInterfaceProps['onNavigateToSession'];
}) {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<ForkState | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const requestIdsRef = useRef(new Map<string, string>());
  const viewKey = `${selectedProject?.tenantId}:${selectedProject?.workspaceId}:${sessionId}:${provider}`;
  const currentViewRef = useRef(viewKey);
  currentViewRef.current = viewKey;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const forkMessage = useCallback(async (message: ChatMessage) => {
    if (
      inFlightRef.current || isProcessing || !selectedProject || !sessionId
      || sessionId.startsWith('new-session-') || !onNavigateToSession
      || selectedProject.accessRole === 'view' || !canForkMessage(message, provider)
    ) return;

    const sourceMessageUuid = message.sourceMessageUuid!;
    const requestKey = `${viewKey}:${sourceMessageUuid}`;
    // A retry after a lost response must refer to the same server operation.
    const requestId = requestIdsRef.current.get(requestKey) || createClientMessageId();
    requestIdsRef.current.set(requestKey, requestId);
    inFlightRef.current = true;
    setState({ viewKey, sourceMessageUuid, pending: true });
    try {
      const response = await api.forkSession(sessionId, {
        sourceMessageUuid,
        requestId,
        workspaceId: selectedProject.workspaceId,
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(typeof result.error === 'string' ? result.error : t('fork.failed'));
      }
      if (!result.sessionId || !result.session || result.session.id !== result.sessionId) {
        throw new Error(t('fork.failed'));
      }
      const session: ProjectSession = {
        ...result.session,
        __provider: 'claude',
        __projectName: selectedProject.name,
        __workspaceId: selectedProject.workspaceId,
        parentSessionId: result.parentSessionId || sessionId,
        sourceMessageUuid,
      };
      // Finishing an older request must not pull the user out of another chat.
      requestIdsRef.current.delete(requestKey);
      if (mountedRef.current && currentViewRef.current === viewKey) {
        onNavigateToSession(result.sessionId, session);
      } else {
        void window.refreshProjects?.();
      }
      if (mountedRef.current) setState(null);
    } catch (error) {
      if (mountedRef.current) setState({
        viewKey,
        sourceMessageUuid,
        pending: false,
        error: error instanceof Error ? error.message : t('fork.failed'),
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [isProcessing, onNavigateToSession, provider, selectedProject, sessionId, t, viewKey]);

  const visibleState = state?.viewKey === viewKey ? state : null;
  return {
    forkMessage,
    forkingMessageUuid: visibleState?.pending ? visibleState.sourceMessageUuid : null,
    forkError: visibleState?.error || null,
    forkDisabled: isProcessing || Boolean(state?.pending) || selectedProject?.accessRole === 'view',
  };
}
