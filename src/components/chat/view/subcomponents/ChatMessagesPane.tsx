import { memo, useMemo } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '../../types/types';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import type { ExecutionTask } from '../../execution/types';
import { executionTaskForMessage, indexExecutionTaskMessages } from '../../execution/messageTasks';

import MessageComponent from './MessageComponent';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';

interface ChatMessagesPaneProps {
  creationMode?: boolean;
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessages: ChatMessage[];
  allMessagesLoaded: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onOpenSubagent?: (toolId: string) => void;
  executionTasks?: ExecutionTask[];
  onOpenExecutionTask?: (taskId: string) => void;
  locatedExecutionSource?: { messageId?: string; toolUseId?: string } | null;
  onForkMessage?: (message: ChatMessage) => void;
  forkingMessageUuid?: string | null;
  forkDisabled?: boolean;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  autoExpandTools?: boolean;
  hideToolMessages?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
}

function ChatMessagesPane({
  creationMode = false,
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  geminiModel,
  setGeminiModel,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessages,
  allMessagesLoaded,
  createDiff,
  onFileOpen,
  onOpenSubagent,
  executionTasks,
  onOpenExecutionTask,
  locatedExecutionSource,
  onForkMessage,
  forkingMessageUuid,
  forkDisabled,
  onShowSettings,
  onGrantToolPermission,
  autoExpandTools,
  hideToolMessages,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const executionTaskIndex = useMemo(() => indexExecutionTaskMessages(executionTasks || []), [executionTasks]);
  const keyedVisibleMessages = useMemo(() => {
    const occurrenceCounts = new Map<string, number>();

    return visibleMessages.filter((message) => !(hideToolMessages && message.isToolUse)
      || Boolean(executionTaskForMessage(executionTaskIndex, message))
      || (Boolean(locatedExecutionSource?.messageId) && message.id === locatedExecutionSource?.messageId)
      || (Boolean(locatedExecutionSource?.toolUseId) && message.toolId === locatedExecutionSource?.toolUseId)).map((message, index) => {
      const baseKey = getIntrinsicMessageKey(message) || `message-fallback-${index}`;
      const occurrenceIndex = occurrenceCounts.get(baseKey) || 0;
      occurrenceCounts.set(baseKey, occurrenceIndex + 1);

      return {
        message,
        key: occurrenceIndex === 0 ? baseKey : `${baseKey}-duplicate-${occurrenceIndex}`,
      };
    });
  }, [executionTaskIndex, hideToolMessages, locatedExecutionSource, visibleMessages]);

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="relative min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-0 py-3 sm:space-y-4 sm:p-4"
    >
      {isLoadingSessionMessages && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 && creationMode ? (
        <div className="flex h-full flex-col items-center justify-center px-6 text-center">
          <h2 className="text-xl font-semibold">{t('skillCreation.emptyTitle', { ns: 'common' })}</h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">{t('skillCreation.emptyDescription', { ns: 'common' })}</p>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          geminiModel={geminiModel}
          setGeminiModel={setGeminiModel}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          agentTemplate={selectedProject.agentTemplate}
        />
      ) : (
        <>
          {/* Loading indicator for older messages */}
          {isLoadingMoreMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-gray-500 dark:text-gray-400">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </div>
          )}

          {keyedVisibleMessages.map(({ message, key }, index) => {
            const prevMessage = index > 0 ? keyedVisibleMessages[index - 1].message : null;
            return (
              <MessageComponent
                key={key}
                message={message}
                prevMessage={prevMessage}
                createDiff={createDiff}
                onFileOpen={onFileOpen}
                onOpenSubagent={onOpenSubagent}
                executionTask={executionTaskForMessage(executionTaskIndex, message)}
                onOpenExecutionTask={onOpenExecutionTask}
                onForkMessage={onForkMessage}
                isForking={Boolean(forkingMessageUuid && forkingMessageUuid === message.sourceMessageUuid)}
                forkDisabled={forkDisabled}
                onShowSettings={onShowSettings}
                onGrantToolPermission={onGrantToolPermission}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                selectedProject={selectedProject}
                provider={provider}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

export default memo(ChatMessagesPane);
