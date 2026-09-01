/**
 * Centralized tool configuration registry
 * Defines display behavior for all tool types 
 */

import { normalizeBashOutput } from '../utils/bashOutput';

export interface ToolDisplayConfig {
  input: {
    type: 'one-line' | 'collapsible' | 'plan' | 'hidden';
    // One-line config
    icon?: string;
    label?: string;
    getValue?: (input: any) => string;
    getSecondary?: (input: any) => string | undefined;
    action?: 'copy' | 'open-file' | 'jump-to-results' | 'none';
    wrapText?: boolean;
    colorScheme?: {
      primary?: string;
      secondary?: string;
      background?: string;
      border?: string;
      icon?: string;
    };
    // Collapsible config
    title?: string | ((input: any) => string);
    defaultOpen?: boolean;
    contentType?: 'diff' | 'markdown' | 'file-list' | 'todo-list' | 'text' | 'task' | 'question-answer';
    getContentProps?: (input: any, helpers?: any) => any;
    actionButton?: 'file-button' | 'none';
  };
  result?: {
    hidden?: boolean;
    hideOnSuccess?: boolean;
    hideWhen?: (result: any) => boolean;
    type?: 'one-line' | 'collapsible' | 'plan' | 'special';
    title?: string | ((result: any) => string);
    defaultOpen?: boolean;
    // Special result handlers
    contentType?: 'markdown' | 'file-list' | 'todo-list' | 'text' | 'success-message' | 'task' | 'question-answer';
    getMessage?: (result: any) => string;
    getContentProps?: (result: any) => any;
  };
}

function normalizeAskUserQuestionAnswers(value: unknown): Record<string, string> {
  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === 'string') {
      normalized[key] = entry;
    }
  }
  return normalized;
}

function parseQuestionList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (parsed && Array.isArray((parsed as any).questions)) {
        return (parsed as any).questions;
      }
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeAskUserQuestionInput(value: unknown): any[] {
  const raw = parseQuestionList(value);
  return raw
    .map((q) => {
      if (!q || typeof q !== 'object') {
        return {
          question: typeof q === 'string' ? q : '',
          header: undefined,
          options: [],
          multiSelect: false,
        };
      }

      const rawOptions = Array.isArray((q as any).options) ? (q as any).options : [];
      const options = rawOptions
        .map((opt: any) => {
          if (!opt || typeof opt !== 'object') {
            return null;
          }
          if (typeof opt.label !== 'string') {
            return null;
          }
          return {
            label: opt.label,
            description: typeof opt.description === 'string' ? opt.description : undefined,
          };
        })
        .filter((opt: { label: string; description?: string } | null): opt is { label: string; description?: string } => opt !== null);

      return {
        question: typeof (q as any).question === 'string' ? (q as any).question : '',
        header: typeof (q as any).header === 'string' ? (q as any).header : undefined,
        options,
        multiSelect: (q as any).multiSelect === true,
      };
    })
    .filter((q) => q.question || q.options.length > 0);
}

export interface SearchToolResultSummary {
  files: string[];
  count: number;
}

type SearchResultAccumulator = {
  files: string[];
  seenFiles: Set<string>;
  counts: number[];
};

const SEARCH_FILE_LIST_KEYS = [
  'filenames',
  'files',
  'filePaths',
  'file_paths',
  'paths',
  'matches',
  'results',
] as const;

const SEARCH_FILE_PATH_KEYS = [
  'path',
  'filePath',
  'file_path',
  'filename',
  'file',
] as const;

const SEARCH_FILE_COUNT_KEYS = [
  'numFiles',
  'num_files',
  'fileCount',
  'file_count',
  'totalFiles',
  'total_files',
] as const;

const SEARCH_TEXT_CONTENT_KEYS = [
  'content',
  'output',
  'text',
  'stdout',
] as const;

function parseJsonLikeString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || !['{', '['].includes(trimmed[0])) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function readCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (typeof value === 'string') {
    const match = value.match(/\d+/);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[0], 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

function readCountFromText(value: string): number | null {
  const foundMatch = value.match(/\bFound\s+(\d+)\s+files?\b/i);
  if (foundMatch) {
    return readCount(foundMatch[1]);
  }

  const filesFoundMatch = value.match(/\b(\d+)\s+files?\s+found\b/i);
  if (filesFoundMatch) {
    return readCount(filesFoundMatch[1]);
  }

  return null;
}

function normalizeFilePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  let normalized = value.trim();
  if (!normalized) {
    return null;
  }

  normalized = normalized.replace(/^[-*]\s+/, '');
  normalized = normalized.replace(/^["'`]+|["'`,]+$/g, '');

  return normalized || null;
}

function isLikelyFilePath(value: string): boolean {
  const basename = value.split(/[\\/]/).pop() || value;
  return /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.includes('/') ||
    value.includes('\\') ||
    /\.[A-Za-z0-9]+$/.test(basename);
}

function addFile(value: unknown, accumulator: SearchResultAccumulator) {
  const normalized = normalizeFilePath(value);
  if (!normalized || !isLikelyFilePath(normalized) || accumulator.seenFiles.has(normalized)) {
    return;
  }

  accumulator.seenFiles.add(normalized);
  accumulator.files.push(normalized);
}

function extractFilePathFromGrepLine(line: string): string {
  const lineMatch = line.match(/^(.*):\d+(?::\d+)?:/);
  return lineMatch?.[1] || line;
}

function collectFilesFromText(value: string, accumulator: SearchResultAccumulator) {
  const explicitCount = readCountFromText(value);
  if (explicitCount !== null) {
    accumulator.counts.push(explicitCount);
  }

  for (const rawLine of value.split(/\r?\n/)) {
    const line = normalizeFilePath(rawLine);
    if (!line || /^Found\s+\d+\s+files?$/i.test(line) || /^No files? found$/i.test(line)) {
      continue;
    }

    addFile(extractFilePathFromGrepLine(line), accumulator);
  }
}

function collectFileEntry(value: unknown, accumulator: SearchResultAccumulator, depth: number) {
  if (!value || depth > 4) {
    return;
  }

  const parsed = typeof value === 'string' ? parseJsonLikeString(value) : value;
  if (parsed !== value) {
    collectFileEntry(parsed, accumulator, depth + 1);
    return;
  }

  if (typeof value === 'string') {
    collectFilesFromText(value, accumulator);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectFileEntry(item, accumulator, depth + 1);
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;

  for (const key of SEARCH_FILE_COUNT_KEYS) {
    const count = readCount(record[key]);
    if (count !== null) {
      accumulator.counts.push(count);
    }
  }

  for (const key of SEARCH_FILE_PATH_KEYS) {
    addFile(record[key], accumulator);
  }

  for (const key of SEARCH_FILE_LIST_KEYS) {
    collectFileEntry(record[key], accumulator, depth + 1);
  }

  for (const key of SEARCH_TEXT_CONTENT_KEYS) {
    collectFileEntry(record[key], accumulator, depth + 1);
  }

  collectFileEntry(record.toolUseResult, accumulator, depth + 1);
}

export function normalizeSearchToolResult(result: any): SearchToolResultSummary {
  const accumulator: SearchResultAccumulator = {
    files: [],
    seenFiles: new Set<string>(),
    counts: [],
  };

  collectFileEntry(result?.toolUseResult, accumulator, 0);
  collectFileEntry(result, accumulator, 0);

  return {
    files: accumulator.files,
    count: Math.max(0, accumulator.files.length, ...accumulator.counts),
  };
}

export const TOOL_CONFIGS: Record<string, ToolDisplayConfig> = {
  // ============================================================================
  // COMMAND TOOLS
  // ============================================================================

  Bash: {
    input: {
      type: 'one-line',
      label: 'Bash',
      getValue: (input) => input.command,
      action: 'copy',
      wrapText: true,
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        secondary: 'text-gray-500 dark:text-gray-400',
        background: '',
        border: 'border-gray-300 dark:border-gray-600',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      type: 'collapsible',
      title: 'Output',
      defaultOpen: true,
      contentType: 'text',
      hideWhen: (result) => !normalizeBashOutput(result).hasOutput,
      getContentProps: (result) => {
        const { stdout, stderr } = normalizeBashOutput(result);
        return {
          content: [stdout, stderr].filter(Boolean).join('\n'),
          format: 'code'
        };
      }
    }
  },

  // ============================================================================
  // FILE OPERATION TOOLS
  // ============================================================================

  Read: {
    input: {
      type: 'one-line',
      label: 'Read',
      getValue: (input) => input.file_path || '',
      action: 'open-file',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        background: '',
        border: 'border-gray-300 dark:border-gray-600',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      hidden: true
    }
  },

  Edit: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const filename = input.file_path?.split('/').pop() || input.file_path || 'file';
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => ({
        oldContent: input.old_string,
        newContent: input.new_string,
        filePath: input.file_path,
        badge: 'Edit',
        badgeColor: 'gray'
      })
    },
    result: {
      hideOnSuccess: true
    }
  },

  Write: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const filename = input.file_path?.split('/').pop() || input.file_path || 'file';
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => ({
        oldContent: '',
        newContent: input.content,
        filePath: input.file_path,
        badge: 'New',
        badgeColor: 'green'
      })
    },
    result: {
      hideOnSuccess: true
    }
  },

  ApplyPatch: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const filename = input.file_path?.split('/').pop() || input.file_path || 'file';
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => ({
        oldContent: input.old_string,
        newContent: input.new_string,
        filePath: input.file_path,
        badge: 'Patch',
        badgeColor: 'gray'
      })
    },
    result: {
      hideOnSuccess: true
    }
  },

  // ============================================================================
  // SEARCH TOOLS
  // ============================================================================

  Grep: {
    input: {
      type: 'one-line',
      label: 'Grep',
      getValue: (input) => input.pattern,
      getSecondary: (input) => input.path ? `in ${input.path}` : undefined,
      action: 'jump-to-results',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        secondary: 'text-gray-500 dark:text-gray-400',
        background: '',
        border: 'border-gray-400 dark:border-gray-500',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: (result) => {
        const { count } = normalizeSearchToolResult(result);
        return `Found ${count} ${count === 1 ? 'file' : 'files'}`;
      },
      contentType: 'file-list',
      getContentProps: (result) => {
        const { files } = normalizeSearchToolResult(result);
        return {
          files
        };
      }
    }
  },

  Glob: {
    input: {
      type: 'one-line',
      label: 'Glob',
      getValue: (input) => input.pattern,
      getSecondary: (input) => input.path ? `in ${input.path}` : undefined,
      action: 'jump-to-results',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        secondary: 'text-gray-500 dark:text-gray-400',
        background: '',
        border: 'border-gray-400 dark:border-gray-500',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: (result) => {
        const { count } = normalizeSearchToolResult(result);
        return `Found ${count} ${count === 1 ? 'file' : 'files'}`;
      },
      contentType: 'file-list',
      getContentProps: (result) => {
        const { files } = normalizeSearchToolResult(result);
        return {
          files
        };
      }
    }
  },

  // ============================================================================
  // TODO TOOLS
  // ============================================================================

  TodoWrite: {
    input: {
      type: 'collapsible',
      title: 'Updating todo list',
      defaultOpen: false,
      contentType: 'todo-list',
      getContentProps: (input) => ({
        todos: input.todos
      })
    },
    result: {
      type: 'collapsible',
      contentType: 'success-message',
      getMessage: () => 'Todo list updated'
    }
  },

  TodoRead: {
    input: {
      type: 'one-line',
      label: 'TodoRead',
      getValue: () => 'reading list',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-500 dark:text-gray-400',
        border: 'border-violet-400 dark:border-violet-500'
      }
    },
    result: {
      type: 'collapsible',
      contentType: 'todo-list',
      getContentProps: (result) => {
        try {
          const content = String(result.content || '');
          let todos = null;
          if (content.startsWith('[')) {
            todos = JSON.parse(content);
          }
          return { todos, isResult: true };
        } catch (e) {
          console.warn('Failed to parse todo list content:', e);
          return { todos: [], isResult: true };
        }
      }
    }
  },

  // ============================================================================
  // TASK TOOLS (TaskCreate, TaskUpdate, TaskList, TaskGet)
  // ============================================================================

  TaskCreate: {
    input: {
      type: 'one-line',
      label: 'Task',
      getValue: (input) => input.subject || 'Creating task',
      getSecondary: (input) => input.status || undefined,
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      hideOnSuccess: true
    }
  },

  TaskUpdate: {
    input: {
      type: 'one-line',
      label: 'Task',
      getValue: (input) => {
        const parts = [];
        if (input.taskId) parts.push(`#${input.taskId}`);
        if (input.status) parts.push(input.status);
        if (input.subject) parts.push(`"${input.subject}"`);
        return parts.join(' → ') || 'updating';
      },
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      hideOnSuccess: true
    }
  },

  TaskList: {
    input: {
      type: 'one-line',
      label: 'Tasks',
      getValue: () => 'listing tasks',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-500 dark:text-gray-400',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: true,
      title: 'Task list',
      contentType: 'task',
      getContentProps: (result) => ({
        content: String(result?.content || '')
      })
    }
  },

  TaskGet: {
    input: {
      type: 'one-line',
      label: 'Task',
      getValue: (input) => input.taskId ? `#${input.taskId}` : 'fetching',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: true,
      title: 'Task details',
      contentType: 'task',
      getContentProps: (result) => ({
        content: String(result?.content || '')
      })
    }
  },

  // ============================================================================
  // SUBAGENT TASK TOOL
  // ============================================================================

  Task: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const subagentType = input.subagent_type || 'Agent';
        const description = input.description || 'Running task';
        return `Subagent / ${subagentType}: ${description}`;
      },
      defaultOpen: false,
      contentType: 'markdown',
      getContentProps: (input) => {
        // If only prompt exists (and required fields), show just the prompt
        // Otherwise show all available fields
        const hasOnlyPrompt = input.prompt &&
          !input.model &&
          !input.resume;

        if (hasOnlyPrompt) {
          return {
            content: input.prompt || ''
          };
        }

        // Format multiple fields
        const parts = [];

        if (input.model) {
          parts.push(`**Model:** ${input.model}`);
        }

        if (input.prompt) {
          parts.push(`**Prompt:**\n${input.prompt}`);
        }

        if (input.resume) {
          parts.push(`**Resuming from:** ${input.resume}`);
        }

        return {
          content: parts.join('\n\n')
        };
      },
      colorScheme: {
        border: 'border-purple-500 dark:border-purple-400',
        icon: 'text-purple-500 dark:text-purple-400'
      }
    },
    result: {
      type: 'collapsible',
      title: 'Subagent result',
      defaultOpen: false,
      contentType: 'markdown',
      getContentProps: (result) => {
        // Handle agent results which may have complex structure
        if (result && result.content) {
          let content = result.content;
          // If content is a JSON string, try to parse it (agent results may arrive serialized)
          if (typeof content === 'string') {
            try {
              const parsed = JSON.parse(content);
              if (Array.isArray(parsed)) {
                content = parsed;
              }
            } catch {
              // Not JSON — use as-is
              return { content };
            }
          }
          // If content is an array (typical for agent responses with multiple text blocks)
          if (Array.isArray(content)) {
            const textContent = content
              .filter((item: any) => item.type === 'text')
              .map((item: any) => item.text)
              .join('\n\n');
            return { content: textContent || 'No response text' };
          }
          return { content: String(content) };
        }
        // Fallback to string representation
        return { content: String(result || 'No response') };
      }
    }
  },

  // ============================================================================
  // INTERACTIVE TOOLS
  // ============================================================================

  AskUserQuestion: {
    input: {
      type: 'collapsible',
      title: (input: any) => {
        const questions = normalizeAskUserQuestionInput(input?.questions);
        const answers = normalizeAskUserQuestionAnswers(input?.answers);
        const count = questions.length;
        const hasAnswers = Object.keys(answers).length > 0;
        if (count === 1) {
          const header = questions[0]?.header || 'Question';
          return hasAnswers ? `${header} — answered` : header;
        }
        return hasAnswers ? `${count} questions — answered` : `${count} questions`;
      },
      defaultOpen: true,
      contentType: 'question-answer',
      getContentProps: (input: any) => ({
        questions: normalizeAskUserQuestionInput(input?.questions),
        answers: normalizeAskUserQuestionAnswers(input?.answers),
      }),
    },
    result: {
      hideOnSuccess: true
    }
  },

  // ============================================================================
  // PLAN TOOLS
  // ============================================================================

  exit_plan_mode: {
    input: {
      type: 'plan',
      title: 'Implementation plan',
      defaultOpen: true,
      contentType: 'markdown',
      getContentProps: (input) => ({
        content: input.plan?.replace(/\\n/g, '\n') || input.plan
      })
    },
    result: {
      hidden: true
    }
  },

  // Also register as ExitPlanMode (the actual tool name used by Claude)
  ExitPlanMode: {
    input: {
      type: 'plan',
      title: 'Implementation plan',
      defaultOpen: true,
      contentType: 'markdown',
      getContentProps: (input) => ({
        content: input.plan?.replace(/\\n/g, '\n') || input.plan
      })
    },
    result: {
      hidden: true
    }
  },

  // ============================================================================
  // DEFAULT FALLBACK
  // ============================================================================

  Default: {
    input: {
      type: 'collapsible',
      title: 'Parameters',
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (input) => ({
        content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
        format: 'code'
      })
    },
    result: {
      type: 'collapsible',
      contentType: 'text',
      getContentProps: (result) => ({
        content: String(result?.content || ''),
        format: 'plain'
      })
    }
  }
};

/**
 * Get configuration for a tool, with fallback to default
 */
export function getToolConfig(toolName: string): ToolDisplayConfig {
  return TOOL_CONFIGS[toolName] || TOOL_CONFIGS.Default;
}

/**
 * Check if a tool result should be hidden
 */
export function shouldHideToolResult(toolName: string, toolResult: any): boolean {
  const config = getToolConfig(toolName);

  if (!config.result) return false;

  // Always hidden
  if (config.result.hidden) return true;

  // Hide on success only
  if (config.result.hideOnSuccess && toolResult && !toolResult.isError) {
    return true;
  }

  if (config.result.hideWhen?.(toolResult)) {
    return true;
  }

  return false;
}
