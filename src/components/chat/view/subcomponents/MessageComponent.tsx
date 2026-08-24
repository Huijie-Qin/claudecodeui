import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock3, Loader2, Webhook, XCircle } from 'lucide-react';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type {
  ChatMessage,
  ClaudeProcessDiagnostics,
  ClaudePermissionSuggestion,
  PermissionGrantResult,
  Provider,
} from '../../types/types';
import { formatUsageLimitText } from '../../utils/chatFormatting';
import { getClaudePermissionSuggestion } from '../../utils/chatPermissions';
import { formatTaskNotificationUsageLabel } from '../../utils/taskNotifications';
import type { Project } from '../../../../types/app';
import { ToolRenderer, shouldHideToolResult } from '../../tools';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '../../../../shared/view/ui';

import { Markdown } from './Markdown';
import MessageCopyControl from './MessageCopyControl';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

type MessageComponentProps = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onOpenSubagent?: (toolId: string) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: Provider | string;
};

type InteractiveOption = {
  number: string;
  text: string;
  isSelected: boolean;
};

type PermissionGrantState = 'idle' | 'granted' | 'error';
type PreviewImage = { src: string; alt: string };
const COPY_HIDDEN_TOOL_NAMES = new Set(['Bash', 'Edit', 'Write', 'ApplyPatch']);

function redactVisibleSecretText(value: unknown): string {
  return String(value ?? '')
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|auth[_-]?token|private[_-]?token|user[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE)[A-Z0-9_]*\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]');
}

function diagnosticValue(value: unknown): string {
  if (Array.isArray(value)) {
    return redactVisibleSecretText(value.filter((entry) => entry != null && String(entry).trim()).join(' '));
  }
  if (value == null) {
    return '';
  }
  return redactVisibleSecretText(value);
}

function buildDiagnosticRows(diagnostics?: ClaudeProcessDiagnostics): Array<[string, string]> {
  if (!diagnostics) {
    return [];
  }

  const rows: Array<[string, string]> = [
    ['runtime', [diagnostics.runtimeMode, diagnostics.runtimeId].filter(Boolean).join(' / ')],
    ['container', diagnostics.containerName || ''],
    ['process', [diagnostics.command, ...(diagnostics.args || [])].filter(Boolean).join(' ')],
    ['executable', diagnostics.executable || ''],
    ['exit', [
      diagnostics.exitCode != null ? `code ${diagnostics.exitCode}` : '',
      diagnostics.signal ? `signal ${diagnostics.signal}` : '',
    ].filter(Boolean).join(', ')],
    ['cwd', diagnostics.cwd || ''],
    ['workspace', diagnostics.hostWorkspacePath || diagnostics.projectPath || ''],
  ];

  return rows.filter(([, value]) => Boolean(value));
}

function hasDiagnosticDetails(diagnostics?: ClaudeProcessDiagnostics): boolean {
  return Boolean(
    diagnostics &&
    (
      buildDiagnosticRows(diagnostics).length > 0 ||
      diagnostics.stderrTail ||
      diagnostics.stdoutTail ||
      diagnostics.spawnError ||
      diagnostics.errorMessage
    )
  );
}

function formatDiagnosticsForCopy(diagnostics?: ClaudeProcessDiagnostics): string {
  if (!diagnostics) {
    return '';
  }

  const rows = buildDiagnosticRows(diagnostics)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
  const sections = [
    rows,
    diagnostics.errorMessage ? `error: ${redactVisibleSecretText(diagnostics.errorMessage)}` : '',
    diagnostics.spawnError ? `spawn error:\n${redactVisibleSecretText(diagnostics.spawnError)}` : '',
    diagnostics.stderrTail ? `stderr:\n${redactVisibleSecretText(diagnostics.stderrTail)}` : '',
    diagnostics.stdoutTail ? `stdout:\n${redactVisibleSecretText(diagnostics.stdoutTail)}` : '',
  ].filter(Boolean);

  return sections.join('\n\n');
}

const MessageComponent = memo(({ message, prevMessage, createDiff, onFileOpen, onOpenSubagent, onShowSettings, onGrantToolPermission, autoExpandTools, showRawParameters, showThinking, selectedProject, provider }: MessageComponentProps) => {
  const { t } = useTranslation('chat');
  const isGrouped = prevMessage && prevMessage.type === message.type &&
    ((prevMessage.type === 'assistant') ||
      (prevMessage.type === 'user') ||
      (prevMessage.type === 'tool') ||
      (prevMessage.type === 'error'));
  const messageRef = useRef<HTMLDivElement | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const permissionSuggestion = getClaudePermissionSuggestion(message, provider);
  const [permissionGrantState, setPermissionGrantState] = useState<PermissionGrantState>('idle');
  const userCopyContent = String(message.content || '');
  const formattedMessageContent = useMemo(
    () => formatUsageLimitText(String(message.content || '')),
    [message.content]
  );
  const assistantCopyContent = message.isToolUse
    ? String(message.displayText || message.content || '')
    : formattedMessageContent;
  const isCommandOrFileEditToolResponse = Boolean(
    message.isToolUse && COPY_HIDDEN_TOOL_NAMES.has(String(message.toolName || ''))
  );
  const shouldShowUserCopyControl = message.type === 'user' && userCopyContent.trim().length > 0;
  const isQueuedUserMessage = message.type === 'user' && message.queueStatus === 'queued';
  const isFailedQueuedUserMessage = message.type === 'user' && message.queueStatus === 'failed';
  const shouldShowAssistantCopyControl = message.type === 'assistant' &&
    assistantCopyContent.trim().length > 0 &&
    !isCommandOrFileEditToolResponse &&
    !message.isThinking;


  useEffect(() => {
    setPermissionGrantState('idle');
  }, [permissionSuggestion?.entry, message.toolId]);

  useEffect(() => {
    if (!previewImage) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewImage(null);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewImage]);

  useEffect(() => {
    const node = messageRef.current;
    if (!autoExpandTools || !node || !message.isToolUse) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !isExpanded) {
            setIsExpanded(true);
            const details = node.querySelectorAll<HTMLDetailsElement>('details');
            details.forEach((detail) => {
              detail.open = true;
            });
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(node);

    return () => {
      observer.unobserve(node);
    };
  }, [autoExpandTools, isExpanded, message.isToolUse]);

  const formattedTime = useMemo(() => new Date(message.timestamp).toLocaleTimeString(), [message.timestamp]);
  const shouldHideThinkingMessage = Boolean(message.isThinking && !showThinking);
  const isPlainAssistantResponse = Boolean(
    message.type === 'assistant' &&
    !message.isToolUse &&
    !message.isThinking &&
    !message.isInteractivePrompt
  );
  const shouldShowAssistantTimestamp = isPlainAssistantResponse && !message.isStreaming;
  const shouldShowFooterTimestamp = !message.isStreaming && (shouldShowAssistantTimestamp || !isGrouped);
  const shouldShowAssistantFooter = shouldShowAssistantCopyControl || shouldShowFooterTimestamp;
  const errorDiagnostics = message.type === 'error' ? message.diagnostics : undefined;
  const diagnosticRows = useMemo(() => buildDiagnosticRows(errorDiagnostics), [errorDiagnostics]);
  const shouldShowErrorDiagnostics = message.type === 'error' && hasDiagnosticDetails(errorDiagnostics);
  const diagnosticCopyContent = useMemo(() => formatDiagnosticsForCopy(errorDiagnostics), [errorDiagnostics]);
  const hookActivity = message.hookActivity;
  const hookStatus = hookActivity?.status || 'running';
  const isHookExecution = hookActivity?.activityKind === 'execution';
  const hookActionLabels = {
    call_mcp_tool: t('hookActivity.actions.call_mcp_tool', { defaultValue: 'MCP call' }),
    write_record: t('hookActivity.actions.write_record', { defaultValue: 'Write record' }),
    invoke_skill: t('hookActivity.actions.invoke_skill', { defaultValue: 'Invoke Skill' }),
    send_agent_message: t('hookActivity.actions.send_agent_message', { defaultValue: 'Send to Agent' }),
  };
  const hookStatusLabel = {
    queued: t('hookActivity.status.queued', { defaultValue: 'Queued' }),
    running: t('hookActivity.status.running', { defaultValue: 'Running' }),
    succeeded: t('hookActivity.status.succeeded', { defaultValue: 'Completed' }),
    failed: t('hookActivity.status.failed', { defaultValue: 'Failed' }),
  }[hookStatus];

  if (shouldHideThinkingMessage) {
    return null;
  }

  return (
    <div
      ref={messageRef}
      data-message-timestamp={message.timestamp || undefined}
      data-queue-status={message.queueStatus || undefined}
      className={`chat-message ${message.type} ${isGrouped ? 'grouped' : ''} ${message.type === 'user' ? 'flex justify-end px-3 sm:px-0' : 'px-3 sm:px-0'}`}
    >
      {message.type === 'user' ? (
        /* User message bubble on the right */
        <div className="flex w-full items-end space-x-0 sm:w-auto sm:max-w-[85%] sm:space-x-3 md:max-w-md lg:max-w-lg xl:max-w-xl">
          <div className={`group flex-1 rounded-2xl rounded-br-md px-3 py-2 text-white shadow-sm sm:flex-initial sm:px-4 ${isQueuedUserMessage
            ? 'border border-dashed border-blue-300/80 bg-blue-600/75'
            : isFailedQueuedUserMessage
              ? 'border border-red-300/80 bg-red-600/85'
              : 'bg-blue-600'
            }`}>
            <div className="whitespace-pre-wrap break-words text-sm">
              {message.content}
            </div>
            {message.images && message.images.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {message.images.map((img, idx) => (
                  <img
                    key={img.name || idx}
                    src={img.data}
                    alt={img.name}
                    className="h-auto max-w-full cursor-pointer rounded-lg transition-opacity hover:opacity-90"
                    onClick={() => setPreviewImage({
                      src: img.data,
                      alt: img.name || t('imagePreview', { defaultValue: 'Attached image' }),
                    })}
                  />
                ))}
              </div>
            )}
            <div className="mt-1 flex items-center justify-end gap-1 text-xs text-blue-100">
              {isQueuedUserMessage && (
                <span className="mr-auto inline-flex items-center gap-1 font-medium" data-queued-message-indicator>
                  <Clock3 className="h-3 w-3" aria-hidden="true" />
                  {t('messageQueue.queued', { defaultValue: 'Queued' })}
                </span>
              )}
              {isFailedQueuedUserMessage && (
                <span className="mr-auto inline-flex items-center gap-1 font-medium text-red-100">
                  <XCircle className="h-3 w-3" aria-hidden="true" />
                  {t('messageQueue.failed', { defaultValue: 'Failed to queue' })}
                </span>
              )}
              {shouldShowUserCopyControl && (
                <MessageCopyControl content={userCopyContent} messageType="user" />
              )}
              <span>{formattedTime}</span>
            </div>
          </div>
          {!isGrouped && (
            <div className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm text-white sm:flex">
              U
            </div>
          )}
        </div>
      ) : message.isHookActivity && hookActivity ? (
        <div
          className="w-full rounded-lg border border-l-4 border-violet-200/80 border-l-violet-500 bg-violet-50/60 px-3 py-2.5 dark:border-violet-900/70 dark:border-l-violet-400 dark:bg-violet-950/20"
          data-hook-activity={hookActivity.jobId || hookActivity.hookId || 'hook'}
          data-hook-status={hookStatus}
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-200">
              <Webhook className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                  {isHookExecution
                    ? t('hookActivity.executionTitle', { defaultValue: 'Hook execution' })
                    : t('hookActivity.title', { defaultValue: 'Follow-up message' })}
                </span>
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {hookActivity.hookName || hookActivity.hookId || t('hookActivity.unnamed', { defaultValue: 'Unnamed Hook' })}
                </span>
                <span className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${hookStatus === 'failed'
                  ? 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                  : hookStatus === 'succeeded'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                    : 'bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-200'
                  }`}
                >
                  {hookStatus === 'failed' ? (
                    <XCircle className="h-3 w-3" aria-hidden="true" />
                  ) : hookStatus === 'succeeded' ? (
                    <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <Loader2 className={`h-3 w-3 ${hookStatus === 'running' ? 'animate-spin' : ''}`} aria-hidden="true" />
                  )}
                  {hookStatusLabel}
                </span>
              </div>

              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {isHookExecution ? (
                  <>
                    {hookActivity.eventName ? <span>{hookActivity.eventName}</span> : null}
                    {hookActivity.hasScript ? (
                      <span>{t('hookActivity.script', { defaultValue: 'Script' })}</span>
                    ) : null}
                    {hookActivity.actionTypes?.map((actionType) => (
                      <span key={actionType}>{hookActionLabels[actionType]}</span>
                    ))}
                  </>
                ) : hookActivity.skillName ? (
                  <span className="truncate">
                    {t('hookActivity.skill', { defaultValue: 'Skill' })}: <code>/{hookActivity.skillName}</code>
                  </span>
                ) : hookActivity.actionType === 'send_agent_message' ? (
                  <span>{t('hookActivity.directMessage', { defaultValue: 'Sent to Agent' })}</span>
                ) : null}
                {hookStatus === 'queued' && typeof hookActivity.queuePosition === 'number' && (
                  <span>
                    {t('hookActivity.queuePosition', {
                      defaultValue: 'Queue position {{position}}',
                      position: hookActivity.queuePosition,
                    })}
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground/70">{formattedTime}</span>
              </div>

              {!isHookExecution && hookActivity.summary && (
                <div className="mt-2 whitespace-pre-wrap break-words rounded-md border border-violet-100 bg-white/70 px-2.5 py-2 text-xs text-foreground/80 dark:border-violet-900/60 dark:bg-black/10">
                  {redactVisibleSecretText(hookActivity.summary)}
                </div>
              )}

              {hookActivity.error && (
                <div className="mt-2 whitespace-pre-wrap break-words rounded-md bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  {redactVisibleSecretText(hookActivity.error)}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : message.isTaskNotification ? (
        /* Compact task notification on the left */
        <div className="w-full">
          <div className="flex items-center gap-2 py-0.5">
            <span className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${message.taskStatus === 'completed' ? 'bg-green-400 dark:bg-green-500' : 'bg-amber-400 dark:bg-amber-500'}`} />
            <span className="text-xs text-gray-500 dark:text-gray-400">{message.content}</span>
          </div>
          {message.taskNotification?.result && (
            <details className="ml-3 mt-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
              <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
                Task result
              </summary>
              <Markdown className="prose prose-sm mt-2 max-w-none dark:prose-invert">
                {message.taskNotification.result}
              </Markdown>
            </details>
          )}
          {message.taskNotification && Object.keys(message.taskNotification.usage).length > 0 && (
            <div className="ml-3 mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground/80">
              {Object.entries(message.taskNotification.usage).map(([name, value]) => (
                <span key={name}>
                  {formatTaskNotificationUsageLabel(name)}: {String(value)}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Claude/Error/Tool messages on the left */
        <div className="w-full">
          {!isGrouped && (
            <div className="mb-2 flex items-center space-x-3">
              {message.type === 'error' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-sm text-white">
                  !
                </div>
              ) : message.type === 'tool' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-600 text-sm text-white dark:bg-gray-700">
                  🔧
                </div>
              ) : (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1 text-sm text-white">
                  <SessionProviderLogo provider={provider} className="h-full w-full" />
                </div>
              )}
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {message.type === 'error' ? t('messageTypes.error') : message.type === 'tool' ? t('messageTypes.tool') : (provider === 'cursor' ? t('messageTypes.cursor') : provider === 'codex' ? t('messageTypes.codex') : provider === 'gemini' ? t('messageTypes.gemini') : t('messageTypes.claude'))}
              </div>
            </div>
          )}

          <div className="w-full">

            {message.isToolUse ? (
              <div className={message.toolName === 'Bash'
                ? 'my-2 rounded-r-md border-l-2 border-green-500/50 bg-muted/20 py-1.5 pl-2.5 pr-1 dark:border-green-400/40 dark:bg-muted/10'
                : undefined}
              >
                <div className="flex flex-col">
                  <div className="flex flex-col">
                    <Markdown className="prose prose-sm max-w-none dark:prose-invert">
                      {String(message.displayText || '')}
                    </Markdown>
                  </div>
                </div>

                <ToolRenderer
                  toolName={message.toolName || 'UnknownTool'}
                  toolInput={message.toolInput ?? {}}
                  toolResult={message.toolResult}
                  toolId={message.toolId}
                  mode="input"
                  onFileOpen={onFileOpen}
                  onOpenSubagent={onOpenSubagent}
                  createDiff={createDiff}
                  selectedProject={selectedProject}
                  autoExpandTools={autoExpandTools}
                  showRawParameters={showRawParameters}
                  rawToolInput={typeof message.toolInput === 'string' ? message.toolInput : undefined}
                  toolCompletedAt={message.toolCompletedAt}
                  isSubagentContainer={message.isSubagentContainer}
                  subagentState={message.subagentState}
                  taskNotification={message.taskNotification}
                />

                {/* Tool Result Section */}
                {message.toolResult && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
                  message.toolResult.isError ? (
                    // Tool failures are part of the conversation trace, not top-level app errors.
                    <div
                      id={`tool-result-${message.toolId}`}
                      className="relative mt-2 scroll-mt-4 rounded-md border border-border/60 bg-muted/30 p-3 dark:bg-muted/10"
                    >
                      <div className="relative mb-2 flex items-center gap-1.5">
                        <svg className="h-3.5 w-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="text-xs font-medium text-muted-foreground">
                          {permissionSuggestion
                            ? t('toolResults.permissionDenied', { defaultValue: 'Tool permission denied' })
                            : t('toolResults.failed', { defaultValue: 'Tool call failed' })}
                        </span>
                      </div>
                      <div className="relative text-sm text-foreground/90">
                        <Markdown className="prose prose-sm prose-gray max-w-none dark:prose-invert">
                          {String(message.toolResult.content || '')}
                        </Markdown>
                        {permissionSuggestion && (
                          <div className="mt-3 rounded-md border border-amber-200/70 bg-amber-50/70 p-3 dark:border-amber-800/50 dark:bg-amber-950/20">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!onGrantToolPermission) return;
                                  const result = onGrantToolPermission(permissionSuggestion);
                                  if (result?.success) {
                                    setPermissionGrantState('granted');
                                  } else {
                                    setPermissionGrantState('error');
                                  }
                                }}
                                disabled={permissionSuggestion.isAllowed || permissionGrantState === 'granted'}
                                className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${permissionSuggestion.isAllowed || permissionGrantState === 'granted'
                                  ? 'cursor-default border-green-300/70 bg-green-100 text-green-800 dark:border-green-800/60 dark:bg-green-900/30 dark:text-green-200'
                                  : 'border-amber-300/70 bg-white/80 text-amber-800 hover:bg-white dark:border-amber-800/60 dark:bg-gray-900/40 dark:text-amber-200 dark:hover:bg-gray-900/70'
                                  }`}
                              >
                                {permissionSuggestion.isAllowed || permissionGrantState === 'granted'
                                  ? t('permissions.added')
                                  : t('permissions.grant', { tool: permissionSuggestion.toolName })}
                              </button>
                              {onShowSettings && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); onShowSettings(); }}
                                  className="text-xs text-amber-800 underline hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
                                >
                                  {t('permissions.openSettings')}
                                </button>
                              )}
                            </div>
                            <div className="mt-2 text-xs text-amber-800/90 dark:text-amber-200/80">
                              {t('permissions.addTo', { entry: permissionSuggestion.entry })}
                            </div>
                            {permissionGrantState === 'error' && (
                              <div className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                                {t('permissions.error')}
                              </div>
                            )}
                            {(permissionSuggestion.isAllowed || permissionGrantState === 'granted') && (
                              <div className="mt-2 text-xs text-green-700 dark:text-green-200">
                                {t('permissions.retry')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    // Non-error results - route through ToolRenderer (single source of truth)
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      <ToolRenderer
                        toolName={message.toolName || 'UnknownTool'}
                        toolInput={message.toolInput}
                        toolResult={message.toolResult}
                        toolId={message.toolId}
                        mode="result"
                        onFileOpen={onFileOpen}
                        onOpenSubagent={onOpenSubagent}
                        createDiff={createDiff}
                        selectedProject={selectedProject}
                        autoExpandTools={autoExpandTools}
                        taskNotification={message.taskNotification}
                      />
                    </div>
                  )
                )}
              </div>
            ) : message.isInteractivePrompt ? (
              // Special handling for interactive prompts
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-500">
                    <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h4 className="mb-3 text-base font-semibold text-amber-900 dark:text-amber-100">
                      {t('interactive.title')}
                    </h4>
                    {(() => {
                      const lines = (message.content || '').split('\n').filter((line) => line.trim());
                      const questionLine = lines.find((line) => line.includes('?')) || lines[0] || '';
                      const options: InteractiveOption[] = [];

                      // Parse the menu options
                      lines.forEach((line) => {
                        // Match lines like "❯ 1. Yes" or "  2. No"
                        const optionMatch = line.match(/[❯\s]*(\d+)\.\s+(.+)/);
                        if (optionMatch) {
                          const isSelected = line.includes('❯');
                          options.push({
                            number: optionMatch[1],
                            text: optionMatch[2].trim(),
                            isSelected
                          });
                        }
                      });

                      return (
                        <>
                          <p className="mb-4 text-sm text-amber-800 dark:text-amber-200">
                            {questionLine}
                          </p>

                          {/* Option buttons */}
                          <div className="mb-4 space-y-2">
                            {options.map((option) => (
                              <button
                                key={option.number}
                                className={`w-full rounded-lg border-2 px-4 py-3 text-left transition-all ${option.isSelected
                                  ? 'border-amber-600 bg-amber-600 text-white shadow-md dark:border-amber-700 dark:bg-amber-700'
                                  : 'border-amber-300 bg-white text-amber-900 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-100'
                                  } cursor-not-allowed opacity-75`}
                                disabled
                              >
                                <div className="flex items-center gap-3">
                                  <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${option.isSelected
                                    ? 'bg-white/20'
                                    : 'bg-amber-100 dark:bg-amber-800/50'
                                    }`}>
                                    {option.number}
                                  </span>
                                  <span className="flex-1 text-sm font-medium sm:text-base">
                                    {option.text}
                                  </span>
                                  {option.isSelected && (
                                    <span className="text-lg">❯</span>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>

                          <div className="rounded-lg bg-amber-100 p-3 dark:bg-amber-800/30">
                            <p className="mb-1 text-sm font-medium text-amber-900 dark:text-amber-100">
                              {t('interactive.waiting')}
                            </p>
                            <p className="text-xs text-amber-800 dark:text-amber-200">
                              {t('interactive.instruction')}
                            </p>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : message.isThinking ? (
              /* Thinking messages — Reasoning component (ai-elements pattern) */
              <Reasoning defaultOpen={false}>
                <ReasoningTrigger />
                <ReasoningContent>
                  <Markdown className="prose prose-sm prose-gray max-w-none dark:prose-invert">
                    {message.content}
                  </Markdown>
                  <div className="mt-3 flex items-center text-[11px]">
                    <MessageCopyControl content={String(message.content || '')} messageType="assistant" />
                  </div>
                </ReasoningContent>
              </Reasoning>
            ) : (
              <div className="text-sm text-gray-700 dark:text-gray-300">
                {/* Reasoning accordion */}
                {showThinking && message.reasoning && (
                  <Reasoning className="mb-3" defaultOpen={false}>
                    <ReasoningTrigger />
                    <ReasoningContent>
                      <div className="whitespace-pre-wrap">
                        {message.reasoning}
                      </div>
                    </ReasoningContent>
                  </Reasoning>
                )}

                {(() => {
                  const content = message.type === 'error'
                    ? redactVisibleSecretText(formattedMessageContent)
                    : formattedMessageContent;

                  // Detect if content is pure JSON (starts with { or [)
                  const trimmedContent = content.trim();
                  if ((trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) &&
                    (trimmedContent.endsWith('}') || trimmedContent.endsWith(']'))) {
                    try {
                      const parsed = JSON.parse(trimmedContent);
                      const formatted = JSON.stringify(parsed, null, 2);

                      return (
                        <div className="my-2">
                          <div className="mb-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <span className="font-medium">{t('json.response')}</span>
                          </div>
                          <div className="overflow-hidden rounded-lg border border-gray-600/30 bg-gray-800 dark:border-gray-700 dark:bg-gray-900">
                            <pre className="overflow-x-auto p-4">
                              <code className="block whitespace-pre font-mono text-sm text-gray-100 dark:text-gray-200">
                                {formatted}
                              </code>
                            </pre>
                          </div>
                        </div>
                      );
                    } catch {
                      // Not valid JSON, fall through to normal rendering
                    }
                  }

                  // Normal rendering for non-JSON content
                  return message.type === 'assistant' ? (
                    <Markdown className="prose prose-sm prose-gray max-w-none dark:prose-invert">
                      {content}
                    </Markdown>
                  ) : (
                    <div className="whitespace-pre-wrap">
                      {content}
                    </div>
                  );
                })()}

                {shouldShowErrorDiagnostics && (
                  <details className="mt-3 rounded-md border border-red-200/70 bg-red-50/60 text-xs dark:border-red-900/60 dark:bg-red-950/20">
                    <summary className="cursor-pointer select-none px-3 py-2 font-medium text-red-900 dark:text-red-100">
                      {t('diagnostics.title', { defaultValue: 'Process diagnostics' })}
                    </summary>
                    <div className="space-y-3 border-t border-red-200/70 px-3 py-3 dark:border-red-900/60">
                      {diagnosticRows.length > 0 && (
                        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
                          {diagnosticRows.map(([label, value]) => (
                            <div key={label} className="contents">
                              <dt className="font-medium text-red-900/80 dark:text-red-100/80">
                                {t(`diagnostics.${label}`, { defaultValue: label })}
                              </dt>
                              <dd className="break-words font-mono text-red-950 dark:text-red-50">
                                {diagnosticValue(value)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}

                      {errorDiagnostics?.errorMessage && (
                        <div>
                          <div className="mb-1 font-medium text-red-900/80 dark:text-red-100/80">
                            {t('diagnostics.errorMessage', { defaultValue: 'error' })}
                          </div>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white/80 p-2 font-mono text-[11px] text-red-950 dark:bg-black/20 dark:text-red-50">
                            {redactVisibleSecretText(errorDiagnostics.errorMessage)}
                          </pre>
                        </div>
                      )}

                      {errorDiagnostics?.spawnError && (
                        <div>
                          <div className="mb-1 font-medium text-red-900/80 dark:text-red-100/80">
                            {t('diagnostics.spawnError', { defaultValue: 'spawn error' })}
                          </div>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white/80 p-2 font-mono text-[11px] text-red-950 dark:bg-black/20 dark:text-red-50">
                            {redactVisibleSecretText(errorDiagnostics.spawnError)}
                          </pre>
                        </div>
                      )}

                      {errorDiagnostics?.stderrTail && (
                        <div>
                          <div className="mb-1 font-medium text-red-900/80 dark:text-red-100/80">
                            {t('diagnostics.stderr', { defaultValue: 'stderr tail' })}
                          </div>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white/80 p-2 font-mono text-[11px] text-red-950 dark:bg-black/20 dark:text-red-50">
                            {redactVisibleSecretText(errorDiagnostics.stderrTail)}
                          </pre>
                        </div>
                      )}

                      {errorDiagnostics?.stdoutTail && (
                        <div>
                          <div className="mb-1 font-medium text-red-900/80 dark:text-red-100/80">
                            {t('diagnostics.stdout', { defaultValue: 'stdout tail' })}
                          </div>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white/80 p-2 font-mono text-[11px] text-red-950 dark:bg-black/20 dark:text-red-50">
                            {redactVisibleSecretText(errorDiagnostics.stdoutTail)}
                          </pre>
                        </div>
                      )}

                      {diagnosticCopyContent && (
                        <div className="pt-1">
                          <MessageCopyControl content={diagnosticCopyContent} messageType="assistant" />
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </div>
            )}

            {shouldShowAssistantFooter && (
              <div className="mt-1 flex w-full items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
                {shouldShowAssistantCopyControl && (
                  <MessageCopyControl content={assistantCopyContent} messageType="assistant" />
                )}
                {shouldShowFooterTimestamp && <span>{formattedTime}</span>}
              </div>
            )}
          </div>
        </div>
      )}
      {previewImage && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('imagePreview', { defaultValue: 'Image preview' })}
          onClick={() => setPreviewImage(null)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/70 text-2xl text-white hover:bg-black"
            aria-label={t('closeImagePreview', { defaultValue: 'Close image preview' })}
            onClick={() => setPreviewImage(null)}
          >
            ×
          </button>
          <img
            src={previewImage.src}
            alt={previewImage.alt}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
});

export default MessageComponent;
