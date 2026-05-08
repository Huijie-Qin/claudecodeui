const MAX_KEYWORD_PATTERNS = 20;
const MAX_KEYWORD_PATTERN_LENGTH = 160;

const DEFAULT_MODEL_RESPONSE_HOOK_CONFIG = Object.freeze({
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
});

function toBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeKeywordPatterns(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const patterns = [];
  const seen = new Set();

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const pattern = entry.replace(/\s+/g, ' ').trim();
    if (!pattern || pattern.length > MAX_KEYWORD_PATTERN_LENGTH || seen.has(pattern.toLowerCase())) {
      continue;
    }

    patterns.push(pattern);
    seen.add(pattern.toLowerCase());

    if (patterns.length >= MAX_KEYWORD_PATTERNS) {
      break;
    }
  }

  return patterns;
}

function normalizeModelResponseHookConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const triggers = source.triggers && typeof source.triggers === 'object' ? source.triggers : {};

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

export {
  DEFAULT_MODEL_RESPONSE_HOOK_CONFIG,
  normalizeModelResponseHookConfig,
};
