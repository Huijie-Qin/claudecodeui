import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { CalendarClock, ChevronDown, ChevronRight, Edit2, Loader2, MessageSquare, Pause, Play, Save, Trash2, X } from 'lucide-react';

import { api } from '../../../../utils/api';
import type { LLMProvider, Project } from '../../../../types/app';
import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { type SlashCommand, useSlashCommands } from '../../hooks/useSlashCommands';

import CommandMenu from './CommandMenu';

type ScheduledTask = {
  id: number;
  provider: LLMProvider;
  name: string;
  prompt: string;
  intervalMinutes: number;
  nextRunAt: string;
  enabled: boolean;
  model?: string | null;
  permissionMode?: string | null;
  lastRunAt?: string | null;
  lastSessionId?: string | null;
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type TaskEditForm = {
  name: string;
  prompt: string;
  intervalMinutes: number;
  nextRunAt: string;
  enabled: boolean;
};

type ScheduledTasksDialogProps = {
  open: boolean;
  selectedProject: Project;
  provider: LLMProvider;
  model?: string;
  permissionMode?: string;
  initialPrompt?: string;
  initialTaskId?: number | null;
  selectedSessionId?: string | null;
  selectedSessionName?: string | null;
  onClose: () => void;
};

type ErrorPayload = {
  error?: string;
  message?: string;
};

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function toLocalInputValue(value?: string | null) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60_000);
  if (Number.isNaN(date.getTime())) {
    return toLocalInputValue(null);
  }
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildTaskEditForm(task: ScheduledTask): TaskEditForm {
  return {
    name: task.name || '',
    prompt: task.prompt || '',
    intervalMinutes: Math.max(1, Number(task.intervalMinutes) || 1),
    nextRunAt: toLocalInputValue(task.nextRunAt),
    enabled: task.enabled,
  };
}

function formatDateTime(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function DetailRow({ label, value, tone = 'default' }: { label: string; value?: string | null; tone?: 'default' | 'error' }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 break-words text-xs ${tone === 'error' ? 'text-destructive' : 'text-foreground'}`}>
        {value || '-'}
      </dd>
    </div>
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as ErrorPayload));
  return payload.error || payload.message || fallback;
}

function getDefaultToolsSettings(provider: LLMProvider) {
  const key =
    provider === 'cursor'
      ? 'cursor-tools-settings'
      : provider === 'codex'
        ? 'codex-settings'
        : provider === 'gemini'
          ? 'gemini-settings'
          : 'claude-settings';

  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function ScheduledTasksDialog({
  open,
  selectedProject,
  provider,
  model,
  permissionMode,
  initialPrompt = '',
  initialTaskId = null,
  selectedSessionId = null,
  selectedSessionName = null,
  onClose,
}: ScheduledTasksDialogProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [nextRunAt, setNextRunAt] = useState(() => toLocalInputValue());
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [taskEditForm, setTaskEditForm] = useState<TaskEditForm | null>(null);
  const [isUpdatingTask, setIsUpdatingTask] = useState(false);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const initialEditStartedRef = useRef<number | null>(null);
  const isTaskDetailMode = initialTaskId !== null && initialTaskId !== undefined;

  const canSave = useMemo(
    () => Boolean(name.trim() && prompt.trim() && intervalMinutes >= 1 && selectedProject.workspaceId && !isSaving),
    [intervalMinutes, isSaving, name, prompt, selectedProject.workspaceId],
  );

  const canSaveTaskEdit = useMemo(
    () => Boolean(
      taskEditForm?.name.trim()
        && taskEditForm.prompt.trim()
        && taskEditForm.intervalMinutes >= 1
        && taskEditForm.nextRunAt
        && !isUpdatingTask,
    ),
    [isUpdatingTask, taskEditForm],
  );

  const visibleTasks = useMemo(
    () => isTaskDetailMode ? tasks.filter((task) => task.id === initialTaskId) : tasks,
    [initialTaskId, isTaskDetailMode, tasks],
  );

  const isScheduledPromptCommand = useCallback((command: SlashCommand) => {
    const namespace = String(command.namespace || '');
    return command.metadata?.type === 'skill' || namespace.includes('skill');
  }, []);

  const {
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    input: prompt,
    setInput: setPrompt,
    textareaRef: promptTextareaRef,
    commandFilter: isScheduledPromptCommand,
  });

  const promptTextareaRect = promptTextareaRef.current?.getBoundingClientRect();
  const commandMenuPosition = {
    top: promptTextareaRect ? Math.max(16, promptTextareaRect.top - 316) : 0,
    left: promptTextareaRect ? promptTextareaRect.left : 16,
    bottom: promptTextareaRect ? window.innerHeight - promptTextareaRect.top + 8 : 90,
  };

  const resetForm = useCallback(() => {
    setName('');
    setPrompt(initialPrompt.trim());
    setIntervalMinutes(60);
    setNextRunAt(toLocalInputValue());
    setEnabled(true);
    setError(null);
    resetCommandMenuState();
  }, [initialPrompt, resetCommandMenuState]);

  const loadTasks = useCallback(async () => {
    if (!selectedProject.workspaceId) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.scheduledTasks.list(selectedProject.workspaceId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to load scheduled tasks'));
        return;
      }
      const payload = await response.json();
      const loadedTasks: ScheduledTask[] = payload.tasks || [];
      setTasks(loadedTasks);

      if (isTaskDetailMode && initialEditStartedRef.current !== initialTaskId) {
        const targetTask = loadedTasks.find((task) => task.id === initialTaskId);
        if (targetTask) {
          setExpandedTaskId(targetTask.id);
          setEditingTaskId(targetTask.id);
          setTaskEditForm(buildTaskEditForm(targetTask));
          initialEditStartedRef.current = targetTask.id;
        }
      }
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to load tasks:', caughtError);
      setError('Failed to load scheduled tasks');
    } finally {
      setIsLoading(false);
    }
  }, [initialTaskId, isTaskDetailMode, selectedProject.workspaceId]);

  useEffect(() => {
    if (expandedTaskId && tasks.length > 0 && !tasks.some((task) => task.id === expandedTaskId)) {
      setExpandedTaskId(null);
    }
    if (editingTaskId && tasks.length > 0 && !tasks.some((task) => task.id === editingTaskId)) {
      setEditingTaskId(null);
      setTaskEditForm(null);
    }
  }, [editingTaskId, expandedTaskId, tasks]);

  useEffect(() => {
    if (!open) {
      initialEditStartedRef.current = null;
      return;
    }

    initialEditStartedRef.current = null;
    setEditingTaskId(null);
    setTaskEditForm(null);
    resetForm();
    void loadTasks();
  }, [initialTaskId, loadTasks, open, resetForm]);

  const createTask = async () => {
    if (!selectedProject.workspaceId) {
      setError('Workspace is required');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const response = await api.scheduledTasks.create({
        workspaceId: selectedProject.workspaceId,
        provider,
        name: name.trim(),
        prompt: prompt.trim(),
        intervalMinutes,
        nextRunAt: new Date(nextRunAt).toISOString(),
        enabled,
        model: model || null,
        permissionMode: permissionMode || null,
        toolsSettings: getDefaultToolsSettings(provider),
        sessionId: selectedSessionId || null,
      });

      if (!response.ok) {
        setError(await readError(response, 'Failed to create scheduled task'));
        return;
      }

      const payload = await response.json().catch(() => ({}));
      resetForm();
      await loadTasks();
      if (payload.task?.id) {
        setExpandedTaskId(payload.task.id);
      }
      await (window as any).refreshProjects?.();
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to create task:', caughtError);
      setError('Failed to create scheduled task');
    } finally {
      setIsSaving(false);
    }
  };

  const startEditingTask = (task: ScheduledTask) => {
    setError(null);
    setExpandedTaskId(task.id);
    setEditingTaskId(task.id);
    setTaskEditForm(buildTaskEditForm(task));
  };

  const cancelTaskEdit = () => {
    setEditingTaskId(null);
    setTaskEditForm(null);
  };

  const saveTaskEdit = async (task: ScheduledTask) => {
    if (!taskEditForm) {
      return;
    }

    const nextRunDate = new Date(taskEditForm.nextRunAt);
    if (Number.isNaN(nextRunDate.getTime())) {
      setError('Next run must be a valid date/time');
      return;
    }

    setIsUpdatingTask(true);
    setError(null);
    try {
      const response = await api.scheduledTasks.update(task.id, {
        name: taskEditForm.name.trim(),
        prompt: taskEditForm.prompt.trim(),
        intervalMinutes: taskEditForm.intervalMinutes,
        nextRunAt: nextRunDate.toISOString(),
        enabled: taskEditForm.enabled,
      });

      if (!response.ok) {
        setError(await readError(response, 'Failed to update scheduled task'));
        return;
      }

      await loadTasks();
      setExpandedTaskId(task.id);
      setEditingTaskId(null);
      setTaskEditForm(null);
      await (window as any).refreshProjects?.();
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to update task:', caughtError);
      setError('Failed to update scheduled task');
    } finally {
      setIsUpdatingTask(false);
    }
  };

  const toggleTask = async (task: ScheduledTask) => {
    setError(null);
    try {
      const response = await api.scheduledTasks.update(task.id, { enabled: !task.enabled });
      if (!response.ok) {
        setError(await readError(response, 'Failed to update scheduled task'));
        return;
      }
      await loadTasks();
      await (window as any).refreshProjects?.();
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to update task:', caughtError);
      setError('Failed to update scheduled task');
    }
  };

  const deleteTask = async (taskId: number) => {
    setError(null);
    try {
      const response = await api.scheduledTasks.remove(taskId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to delete scheduled task'));
        return;
      }
      if (expandedTaskId === taskId) {
        setExpandedTaskId(null);
      }
      if (editingTaskId === taskId) {
        setEditingTaskId(null);
        setTaskEditForm(null);
      }
      await loadTasks();
      await (window as any).refreshProjects?.();
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to delete task:', caughtError);
      setError('Failed to delete scheduled task');
    }
  };

  const toggleTaskDetails = (taskId: number) => {
    const nextTaskId = expandedTaskId === taskId ? null : taskId;
    setExpandedTaskId(nextTaskId);
    if (nextTaskId === null && editingTaskId === taskId) {
      setEditingTaskId(null);
      setTaskEditForm(null);
    }
  };

  const handlePromptChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextPrompt = event.target.value;
    setPrompt(nextPrompt);
    handleCommandInputChange(nextPrompt, event.target.selectionStart);
  }, [handleCommandInputChange]);

  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    handleCommandMenuKeyDown(event);
  }, [handleCommandMenuKeyDown]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) { resetCommandMenuState(); onClose(); } }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden p-0">
        <DialogTitle>{isTaskDetailMode ? 'Scheduled task details' : 'Scheduled session tasks'}</DialogTitle>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <CalendarClock className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {isTaskDetailMode ? 'Scheduled task details' : 'Scheduled session tasks'}
              </h2>
              <p className="truncate text-xs text-muted-foreground">
                {selectedProject.displayName || selectedProject.name}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="max-h-[calc(90vh-132px)] overflow-y-auto px-5 py-4">
          <div className={isTaskDetailMode ? 'hidden' : 'grid gap-3'}>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Task name</span>
              <input
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Daily workspace check"
              />
            </label>
          </div>

          <div className={isTaskDetailMode ? 'hidden' : 'mt-3 space-y-1'}>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs text-muted-foreground" htmlFor="scheduled-task-message">
                Message
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="relative h-7 gap-1.5 px-2 text-xs"
                onClick={handleToggleCommandMenu}
                disabled={slashCommandsCount === 0}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Skills
                {slashCommandsCount > 0 ? (
                  <span className="ml-0.5 rounded-sm bg-primary/10 px-1 text-[10px] text-primary">
                    {slashCommandsCount}
                  </span>
                ) : null}
              </Button>
            </div>
            <div className="relative">
              <CommandMenu
                commands={filteredCommands}
                selectedIndex={selectedCommandIndex}
                onSelect={handleCommandSelect}
                onClose={resetCommandMenuState}
                position={commandMenuPosition}
                isOpen={showCommandMenu}
                frequentCommands={frequentCommands}
              />
              <textarea
                id="scheduled-task-message"
                ref={promptTextareaRef}
                className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={prompt}
                onChange={handlePromptChange}
                onKeyDown={handlePromptKeyDown}
                placeholder="Ask the agent what to do when the task runs"
              />
            </div>
          </div>

          <div className={isTaskDetailMode ? 'hidden' : 'mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground'}>
            {selectedSessionId
              ? `Bound session: ${selectedSessionName || selectedSessionId}`
              : 'No session selected. The first run will create a session, then future runs will reuse it.'}
          </div>

          <div className={isTaskDetailMode ? 'hidden' : 'mt-3 grid gap-3 md:grid-cols-[160px_1fr_120px]'}>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Every minutes</span>
              <input
                type="number"
                min={1}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">First run</span>
              <input
                type="datetime-local"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={nextRunAt}
                onChange={(event) => setNextRunAt(event.target.value)}
              />
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enabled
            </label>
          </div>

          {error ? (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className={isTaskDetailMode ? 'hidden' : 'mt-4 flex justify-end'}>
            <Button onClick={() => void createTask()} disabled={!canSave}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
              Create task
            </Button>
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground">
                {isTaskDetailMode ? 'Task details' : 'Existing tasks'}
              </h3>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>

            {visibleTasks.length === 0 && !isLoading ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                {isTaskDetailMode ? 'Scheduled task not found.' : 'No scheduled tasks yet.'}
              </div>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {visibleTasks.map((task) => {
                  const isExpanded = expandedTaskId === task.id;
                  const taskEditValues = editingTaskId === task.id ? taskEditForm : null;
                  return (
                    <div key={task.id} className="px-3 py-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={() => toggleTaskDetails(task.id)}
                          aria-expanded={isExpanded}
                        >
                          <span className="mt-0.5 shrink-0 text-muted-foreground">
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">{task.name}</span>
                              <span className={`rounded-sm px-1.5 py-0.5 text-[11px] ${
                                task.enabled
                                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                  : 'bg-muted text-muted-foreground'
                              }`}>
                                {task.enabled ? 'Enabled' : 'Paused'}
                              </span>
                            </span>
                            <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{task.prompt}</span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              Every {task.intervalMinutes} min. Next: {formatDateTime(task.nextRunAt)}. Last: {formatDateTime(task.lastRunAt)}
                            </span>
                            {task.lastError ? (
                              <span className="mt-1 block text-xs text-destructive">{task.lastError}</span>
                            ) : null}
                          </span>
                        </button>
                        <div className="flex shrink-0 gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => startEditingTask(task)}
                            disabled={Boolean(taskEditValues)}
                          >
                            <Edit2 className="h-4 w-4" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void toggleTask(task)}
                            disabled={Boolean(taskEditValues)}
                          >
                            {task.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                            {task.enabled ? 'Pause' : 'Resume'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void deleteTask(task.id)}
                            aria-label="Delete task"
                            disabled={Boolean(taskEditValues)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
                          {taskEditValues ? (
                            <div className="grid gap-3">
                              <label className="space-y-1">
                                <span className="text-xs text-muted-foreground">Task name</span>
                                <input
                                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                  value={taskEditValues.name}
                                  onChange={(event) => {
                                    setTaskEditForm((current) => current ? { ...current, name: event.target.value } : current);
                                  }}
                                  disabled={isUpdatingTask}
                                />
                              </label>

                              <label className="space-y-1">
                                <span className="text-xs text-muted-foreground">Message</span>
                                <textarea
                                  className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                  value={taskEditValues.prompt}
                                  onChange={(event) => {
                                    setTaskEditForm((current) => current ? { ...current, prompt: event.target.value } : current);
                                  }}
                                  disabled={isUpdatingTask}
                                />
                              </label>

                              <div className="grid gap-3 md:grid-cols-[160px_1fr_120px]">
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Every minutes</span>
                                  <input
                                    type="number"
                                    min={1}
                                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    value={taskEditValues.intervalMinutes}
                                    onChange={(event) => {
                                      setTaskEditForm((current) => current
                                        ? { ...current, intervalMinutes: Math.max(1, Number(event.target.value) || 1) }
                                        : current);
                                    }}
                                    disabled={isUpdatingTask}
                                  />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs text-muted-foreground">Next run</span>
                                  <input
                                    type="datetime-local"
                                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    value={taskEditValues.nextRunAt}
                                    onChange={(event) => {
                                      setTaskEditForm((current) => current ? { ...current, nextRunAt: event.target.value } : current);
                                    }}
                                    disabled={isUpdatingTask}
                                  />
                                </label>
                                <label className="flex items-end gap-2 pb-2 text-sm text-foreground">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-input"
                                    checked={taskEditValues.enabled}
                                    onChange={(event) => {
                                      setTaskEditForm((current) => current ? { ...current, enabled: event.target.checked } : current);
                                    }}
                                    disabled={isUpdatingTask}
                                  />
                                  Enabled
                                </label>
                              </div>

                              <div className="grid gap-3 sm:grid-cols-2">
                                <DetailRow label="Session" value={task.lastSessionId} />
                                <DetailRow label="Model" value={task.model} />
                                <DetailRow label="Permission" value={task.permissionMode} />
                                <DetailRow label="Last run" value={formatDateTime(task.lastRunAt)} />
                                <DetailRow label="Created" value={formatDateTime(task.createdAt)} />
                                {task.lastError ? (
                                  <DetailRow label="Last error" value={task.lastError} tone="error" />
                                ) : null}
                              </div>

                              <div className="flex justify-end gap-2">
                                <Button variant="ghost" size="sm" onClick={cancelTaskEdit} disabled={isUpdatingTask}>
                                  Cancel
                                </Button>
                                <Button size="sm" onClick={() => void saveTaskEdit(task)} disabled={!canSaveTaskEdit}>
                                  {isUpdatingTask ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                  Save changes
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <dl className="grid gap-3 sm:grid-cols-2">
                              <DetailRow label="Message" value={task.prompt} />
                              <DetailRow label="Schedule" value={`Every ${task.intervalMinutes} min`} />
                              <DetailRow label="Next run" value={formatDateTime(task.nextRunAt)} />
                              <DetailRow label="Last run" value={formatDateTime(task.lastRunAt)} />
                              <DetailRow label="Session" value={task.lastSessionId} />
                              <DetailRow label="Model" value={task.model} />
                              <DetailRow label="Permission" value={task.permissionMode} />
                              <DetailRow label="Created" value={formatDateTime(task.createdAt)} />
                              {task.lastError ? (
                                <DetailRow label="Last error" value={task.lastError} tone="error" />
                              ) : null}
                            </dl>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
