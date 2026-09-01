import React from 'react';
import { PanelRightOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../../../../shared/view/ui';
import type { SubagentChildTool, TaskNotificationDetails, ToolResult } from '../../types/types';
import {
  formatTaskNotificationUsageLabel,
  isTaskNotificationError,
} from '../../utils/taskNotifications';

import { CollapsibleSection } from './CollapsibleSection';

interface SubagentContainerProps {
  toolId?: string;
  toolInput: unknown;
  toolResult?: ToolResult | null;
  completionTime?: React.ReactNode;
  taskNotification?: TaskNotificationDetails;
  onOpenSubagent?: (toolId: string) => void;
  subagentState: {
    agentId?: string;
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
    detailsOwnerToolId?: string;
  };
}

const getCompactToolDisplay = (toolName: string, toolInput: unknown): string => {
  const input = typeof toolInput === 'string' ? (() => {
    try { return JSON.parse(toolInput); } catch { return {}; }
  })() : (toolInput || {});

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'ApplyPatch':
      return input.file_path?.split('/').pop() || input.file_path || '';
    case 'Grep':
    case 'Glob':
      return input.pattern || '';
    case 'Bash':
      const cmd = input.command || '';
      return cmd.length > 40 ? `${cmd.slice(0, 40)}...` : cmd;
    case 'Task':
    case 'Agent':
      return input.description || input.subagent_type || '';
    case 'TaskOutput':
      return input.task_id || input.taskId || '';
    case 'WebFetch':
    case 'WebSearch':
      return input.url || input.query || '';
    default:
      return '';
  }
};

export const SubagentContainer: React.FC<SubagentContainerProps> = ({
  toolId,
  toolInput,
  toolResult,
  completionTime,
  taskNotification,
  onOpenSubagent,
  subagentState,
}) => {
  const { t } = useTranslation('chat');
  const parsedInput = typeof toolInput === 'string' ? (() => {
    try { return JSON.parse(toolInput); } catch { return {}; }
  })() : (toolInput || {});

  const subagentType = parsedInput?.subagent_type || 'Agent';
  const description = parsedInput?.description || 'Running task';
  const prompt = parsedInput?.prompt || '';
  const { childTools, currentToolIndex, isComplete, detailsOwnerToolId } = subagentState;
  const canonicalToolId = detailsOwnerToolId ?? toolId;
  const handleOpenSubagent = canonicalToolId && onOpenSubagent
    ? () => onOpenSubagent(canonicalToolId)
    : undefined;
  const isDetailsAlias = Boolean(detailsOwnerToolId);
  const currentTool = currentToolIndex >= 0 ? childTools[currentToolIndex] : null;
  const hasTaskOutputHistory = childTools.some(
    (child) => child.toolName.trim().toLowerCase() === 'taskoutput',
  );
  const hasError = Boolean(
    toolResult?.isError ||
    (taskNotification && isTaskNotificationError(taskNotification.status)),
  );
  const completionLabel = taskNotification?.status
    ? taskNotification.status.replace(/[-_]/g, ' ')
    : 'Completed';

  const title = `Subagent / ${subagentType}: ${description}`;

  return (
    <div className="my-1 border-l-2 border-l-purple-500 py-0.5 pl-3 dark:border-l-purple-400">
      <CollapsibleSection
        title={title}
        toolName="Task"
        open={false}
        meta={completionTime}
        onTitleClick={handleOpenSubagent}
        action={handleOpenSubagent ? (
          <button
            type="button"
            aria-label={t('subagentPanel.open', { defaultValue: 'Open in side panel' })}
            title={t('subagentPanel.open', { defaultValue: 'Open in side panel' })}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
              handleOpenSubagent();
            }}
          >
            <PanelRightOpen aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : undefined}
      >
        {/* Prompt/request to the subagent */}
        {prompt && !isDetailsAlias && (
          <div className="mb-2 line-clamp-4 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {prompt}
          </div>
        )}

        {isDetailsAlias && (
          <div className="mt-1 text-xs text-muted-foreground">
            Execution details are shown in the corresponding Agent entry.
          </div>
        )}

        {/* Current tool indicator (while running) */}
        {currentTool && !isComplete && !isDetailsAlias && (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
            <span className="text-muted-foreground/60">Currently:</span>
            <span className="font-medium text-foreground">{currentTool.toolName}</span>
            {getCompactToolDisplay(currentTool.toolName, currentTool.toolInput) && (
              <>
                <span className="text-muted-foreground/40">/</span>
                <span className="truncate font-mono text-muted-foreground">
                  {getCompactToolDisplay(currentTool.toolName, currentTool.toolInput)}
                </span>
              </>
            )}
          </div>
        )}

        {/* Completion status */}
        {isComplete && !isDetailsAlias && (
          <div className={`mt-1 flex items-center gap-1.5 text-xs ${hasError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
            <svg className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>
              {completionLabel.charAt(0).toUpperCase() + completionLabel.slice(1)}
              {' '}({childTools.length} {childTools.length === 1 ? 'tool' : 'tools'})
            </span>
          </div>
        )}

        {/* Tool history (collapsed) */}
        {childTools.length > 0 && !isDetailsAlias && (
          <Collapsible className="mt-2" defaultOpen={hasTaskOutputHistory}>
            <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <svg
                className="h-2.5 w-2.5 flex-shrink-0 transition-transform duration-150 data-[state=open]:rotate-90"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span>View tool history ({childTools.length})</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 space-y-0.5 border-l border-border pl-3">
                {childTools.map((child, index) => {
                  const isTaskOutput = child.toolName.trim().toLowerCase() === 'taskoutput';
                  const taskOutputStatus = typeof child.toolResult?.taskOutputStatus === 'string'
                    ? child.toolResult.taskOutputStatus
                    : undefined;
                  const taskOutputContent = child.toolResult?.content;

                  return (
                    <div key={child.toolId} className="py-0.5 text-[11px] text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <span className="w-4 flex-shrink-0 text-right text-muted-foreground/60">{index + 1}.</span>
                        <span className="font-medium text-foreground">{child.toolName}</span>
                        {getCompactToolDisplay(child.toolName, child.toolInput) && (
                          <span className="truncate font-mono text-muted-foreground/70">
                            {getCompactToolDisplay(child.toolName, child.toolInput)}
                          </span>
                        )}
                        {taskOutputStatus && (
                          <span className="flex-shrink-0 text-muted-foreground/70">
                            ({taskOutputStatus.replace(/[-_]/g, ' ')})
                          </span>
                        )}
                        {child.toolResult?.isError && (
                          <span className="flex-shrink-0 text-red-500">(error)</span>
                        )}
                      </div>
                      {isTaskOutput && taskOutputContent != null && taskOutputContent !== '' && (
                        <div className="ml-5 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground/80">
                          {typeof taskOutputContent === 'string'
                            ? taskOutputContent
                            : JSON.stringify(taskOutputContent, null, 2)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Final result */}
        {isComplete && toolResult && !isDetailsAlias && (
          !hasTaskOutputHistory || toolResult.resultSource !== 'task_output'
        ) && (
          <div className="mt-2 text-xs text-muted-foreground">
            {(() => {
              let content = toolResult.content;

              // Handle JSON string that needs parsing
              if (typeof content === 'string') {
                try {
                  const parsed = JSON.parse(content);
                  if (Array.isArray(parsed)) {
                    // Extract text from array format like [{"type":"text","text":"..."}]
                    const textParts = parsed
                      .filter((p: any) => p.type === 'text' && p.text)
                      .map((p: any) => p.text);
                    if (textParts.length > 0) {
                      content = textParts.join('\n');
                    }
                  }
                } catch {
                  // Not JSON, use as-is
                }
              } else if (Array.isArray(content)) {
                // Direct array format
                const textParts = content
                  .filter((p: any) => p.type === 'text' && p.text)
                  .map((p: any) => p.text);
                if (textParts.length > 0) {
                  content = textParts.join('\n');
                }
              }

              return typeof content === 'string' ? (
                <div className="line-clamp-6 whitespace-pre-wrap break-words">
                  {content}
                </div>
              ) : content ? (
                <pre className="line-clamp-6 whitespace-pre-wrap break-words font-mono text-[11px]">
                  {JSON.stringify(content, null, 2)}
                </pre>
              ) : null;
            })()}
          </div>
        )}

        {taskNotification && !isDetailsAlias && Object.keys(taskNotification.usage).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground/80">
            {Object.entries(taskNotification.usage).map(([name, value]) => (
              <span key={name}>
                {formatTaskNotificationUsageLabel(name)}: {String(value)}
              </span>
            ))}
          </div>
        )}
      </CollapsibleSection>
    </div>
  );
};
