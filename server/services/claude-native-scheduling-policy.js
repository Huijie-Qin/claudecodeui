const ALLOW_NATIVE_SCHEDULING_ENV = 'CCUI_ALLOW_CLAUDE_NATIVE_SCHEDULING';
const DISABLE_CLAUDE_CRON_ENV = 'CLAUDE_CODE_DISABLE_CRON';

export const CLAUDE_NATIVE_SCHEDULING_TOOL_NAMES = ['CronCreate', 'CronList', 'CronDelete'];

export function isClaudeNativeSchedulingDisabled(env = process.env) {
  return env?.[ALLOW_NATIVE_SCHEDULING_ENV] !== 'true';
}

export function applyClaudeNativeSchedulingEnvironmentPolicy(env = process.env) {
  const nextEnv = { ...(env || {}) };

  if (isClaudeNativeSchedulingDisabled(nextEnv)) {
    nextEnv[DISABLE_CLAUDE_CRON_ENV] = '1';
  }

  return nextEnv;
}

export function getClaudeNativeSchedulingCommandName(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trimStart();
  const match = trimmed.match(/^\/(schedule|loop)(?=\s|$)/i);
  return match ? `/${match[1].toLowerCase()}` : null;
}

export function assertClaudeNativeSchedulingCommandAllowed(command, env = process.env) {
  if (!isClaudeNativeSchedulingDisabled(env)) return;

  const commandName = getClaudeNativeSchedulingCommandName(command);
  if (!commandName) return;

  const error = new Error(
    `${commandName} is disabled in CCUI. Please create scheduled work with CCUI scheduled tasks instead.`,
  );
  error.code = 'CLAUDE_NATIVE_SCHEDULING_DISABLED';
  error.statusCode = 400;
  throw error;
}
