export type ModelResponseHookTriggers = {
  userConfirmation: boolean;
  runCompleted: boolean;
  error: boolean;
  assistantKeyword: boolean;
};

export type ModelResponseHookConfig = {
  enabled: boolean;
  browserNotifications: boolean;
  fallbackAlert: boolean;
  triggers: ModelResponseHookTriggers;
  keywordPatterns: string[];
};

export type ModelResponseHookMessage = {
  id?: string;
  kind?: string;
  role?: string;
  content?: string;
  text?: string;
  sessionId?: string;
  session_id?: string;
  provider?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  requestId?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  error?: unknown;
  isError?: boolean;
  exitCode?: number;
  aborted?: boolean;
  success?: boolean;
  status?: unknown;
  timestamp?: string;
};

export type ModelResponseHookNotification = {
  trigger: keyof ModelResponseHookTriggers;
  title: string;
  body: string;
  tag: string;
  sessionId: string | null;
  requiresUserAction?: boolean;
};

const MAX_KEYWORD_PATTERNS = 20;
const MAX_KEYWORD_PATTERN_LENGTH = 160;
const EXCERPT_LENGTH = 180;
const MAX_TRACKED_PROMPTED_RUNS = 250;

export const DEFAULT_MODEL_RESPONSE_HOOK_CONFIG: ModelResponseHookConfig = {
  enabled: false,
  browserNotifications: true,
  fallbackAlert: false,
  triggers: {
    userConfirmation: true,
    runCompleted: false,
    error: false,
    assistantKeyword: false,
  },
  keywordPatterns: [],
};

const toBoolean = (value: unknown, fallback: boolean): boolean => (
  typeof value === 'boolean' ? value : fallback
);

export function normalizeKeywordPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const patterns: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const pattern = entry.replace(/\s+/g, ' ').trim();
    const key = pattern.toLowerCase();
    if (!pattern || pattern.length > MAX_KEYWORD_PATTERN_LENGTH || seen.has(key)) {
      continue;
    }

    patterns.push(pattern);
    seen.add(key);

    if (patterns.length >= MAX_KEYWORD_PATTERNS) {
      break;
    }
  }

  return patterns;
}

export function normalizeModelResponseHookConfig(value: unknown): ModelResponseHookConfig {
  const source = value && typeof value === 'object' ? value as Partial<ModelResponseHookConfig> : {};
  const triggers = source.triggers && typeof source.triggers === 'object'
    ? source.triggers as Partial<ModelResponseHookTriggers>
    : {};

  return {
    enabled: toBoolean(source.enabled, DEFAULT_MODEL_RESPONSE_HOOK_CONFIG.enabled),
    browserNotifications: toBoolean(
      source.browserNotifications,
      DEFAULT_MODEL_RESPONSE_HOOK_CONFIG.browserNotifications,
    ),
    fallbackAlert: toBoolean(source.fallbackAlert, DEFAULT_MODEL_RESPONSE_HOOK_CONFIG.fallbackAlert),
    triggers: {
      userConfirmation: toBoolean(
        triggers.userConfirmation,
        DEFAULT_MODEL_RESPONSE_HOOK_CONFIG.triggers.userConfirmation,
      ),
      runCompleted: toBoolean(triggers.runCompleted, DEFAULT_MODEL_RESPONSE_HOOK_CONFIG.triggers.runCompleted),
      error: toBoolean(triggers.error, DEFAULT_MODEL_RESPONSE_HOOK_CONFIG.triggers.error),
      assistantKeyword: toBoolean(
        triggers.assistantKeyword,
        DEFAULT_MODEL_RESPONSE_HOOK_CONFIG.triggers.assistantKeyword,
      ),
    },
    keywordPatterns: normalizeKeywordPatterns(source.keywordPatterns),
  };
}

function stringifyUnknown(value: unknown): string {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function excerpt(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= EXCERPT_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, EXCERPT_LENGTH - 3)}...`;
}

function getSessionId(message: ModelResponseHookMessage): string | null {
  return message.sessionId || message.session_id || null;
}

function matchesKeywordPattern(message: ModelResponseHookMessage, patterns: string[]): boolean {
  if (!patterns.length) {
    return false;
  }

  if (message.kind === 'thinking' || message.kind === 'reasoning') {
    return false;
  }

  const searchText = [
    message.content,
    message.text,
    message.toolName,
    stringifyUnknown(message.toolInput),
    stringifyUnknown(message.output),
    stringifyUnknown(message.result),
  ].filter(Boolean).join('\n').toLowerCase();

  if (!searchText) {
    return false;
  }

  return patterns.some((pattern) => searchText.includes(pattern.toLowerCase()));
}

function getQuestionText(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return null;
  }

  const firstQuestion = questions[0];
  if (!firstQuestion || typeof firstQuestion !== 'object') {
    return null;
  }

  const record = firstQuestion as { header?: unknown; question?: unknown; description?: unknown };
  return excerpt(
    [
      typeof record.header === 'string' ? record.header : '',
      typeof record.question === 'string' ? record.question : '',
      typeof record.description === 'string' ? record.description : '',
    ].filter(Boolean).join(': '),
  ) || null;
}

function buildTag(message: ModelResponseHookMessage, trigger: keyof ModelResponseHookTriggers): string {
  return [
    'model-response-hook',
    trigger,
    message.provider || 'assistant',
    getSessionId(message) || 'no-session',
    message.requestId || message.toolId || message.id || message.timestamp || 'event',
  ].join(':');
}

function rememberPromptedRunKey(set: Set<string>, value: string) {
  set.add(value);
  if (set.size <= MAX_TRACKED_PROMPTED_RUNS) {
    return;
  }

  const first = set.values().next().value;
  if (first) {
    set.delete(first);
  }
}

export function shouldSuppressRunCompletedAfterUserConfirmation(
  notification: ModelResponseHookNotification,
  runKey: string | null,
  userConfirmationRunKeys: Set<string>,
): boolean {
  if (!runKey) {
    return false;
  }

  if (notification.trigger === 'userConfirmation') {
    rememberPromptedRunKey(userConfirmationRunKeys, runKey);
    return false;
  }

  if (notification.trigger === 'runCompleted' && userConfirmationRunKeys.has(runKey)) {
    userConfirmationRunKeys.delete(runKey);
    return true;
  }

  return false;
}

export function buildModelResponseHookNotification(
  message: ModelResponseHookMessage,
  configInput: ModelResponseHookConfig,
  _relatedToolUse?: ModelResponseHookMessage | null,
): ModelResponseHookNotification | null {
  const config = normalizeModelResponseHookConfig(configInput);
  if (!config.enabled) {
    return null;
  }

  const sessionId = getSessionId(message);

  if (config.triggers.userConfirmation && message.kind === 'permission_request') {
    const toolName = message.toolName || 'Tool';
    const questionText = getQuestionText(message.input);
    const isQuestion = toolName === 'AskUserQuestion';
    return {
      trigger: 'userConfirmation',
      title: isQuestion ? 'Assistant is asking a question' : 'Assistant needs confirmation',
      body: questionText || `${toolName} is waiting for your response.`,
      tag: buildTag(message, 'userConfirmation'),
      sessionId,
      requiresUserAction: true,
    };
  }

  if (
    config.triggers.assistantKeyword
    && message.kind !== 'stream_delta'
    && matchesKeywordPattern(message, config.keywordPatterns)
  ) {
    const searchText = [message.content, message.text, stringifyUnknown(message.output), stringifyUnknown(message.result)]
      .filter(Boolean)
      .join('\n');
    return {
      trigger: 'assistantKeyword',
      title: 'Assistant response matched a hook',
      body: excerpt(searchText) || 'A configured model response hook matched.',
      tag: buildTag(message, 'assistantKeyword'),
      sessionId,
    };
  }

  if (config.triggers.error && (message.kind === 'error' || message.isError === true)) {
    const body = excerpt(stringifyUnknown(message.error) || message.content || 'The assistant reported an error.');
    return {
      trigger: 'error',
      title: 'Assistant run needs attention',
      body,
      tag: buildTag(message, 'error'),
      sessionId,
      requiresUserAction: true,
    };
  }

  if (
    config.triggers.runCompleted
    && message.kind === 'complete'
    && message.aborted !== true
    && message.exitCode !== 1
  ) {
    return {
      trigger: 'runCompleted',
      title: 'Assistant run completed',
      body: 'The model finished responding.',
      tag: buildTag(message, 'runCompleted'),
      sessionId,
    };
  }

  return null;
}
