import { userDb } from '../database/db.js';

export const CODEHUB_EMAIL_ENV_NAMES = [
  'codehub_email',
  'CODEHUB_EMAIL',
];

const MANAGED_ENV_NAMES = new Set([
  'W3_NAME',
  'GIT_AUTHOR_NAME',
  'GIT_COMMITTER_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_EMAIL',
  ...CODEHUB_EMAIL_ENV_NAMES,
]);

export function buildManagedUserExecutionEnv(userId, {
  baseEnv = process.env,
  users = userDb,
} = {}) {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
    throw createExecutionIdentityError('A valid userId is required for a user execution environment');
  }

  const user = users.getUserById?.(normalizedUserId);
  if (!user?.username) {
    throw createExecutionIdentityError('An active user with a current username is required');
  }
  if (user.identity_change_status && user.identity_change_status !== 'active') {
    throw createExecutionIdentityError('User identity is currently changing', 409);
  }

  const userEnv = users.getEnvForUser?.(normalizedUserId) || {};
  const gitConfig = users.getGitConfig?.(normalizedUserId) || {};
  const output = copyStringEnvironment(baseEnv);

  for (const [name, value] of Object.entries(userEnv)) {
    if (MANAGED_ENV_NAMES.has(name) || value === undefined || value === null) continue;
    output[name] = String(value);
  }

  const currentUsername = String(user.username).trim();
  const gitName = String(gitConfig.git_name || currentUsername).trim();
  const gitEmail = String(gitConfig.git_email || '').trim();

  output.W3_NAME = currentUsername;
  output.GIT_AUTHOR_NAME = gitName;
  output.GIT_COMMITTER_NAME = gitName;
  if (gitEmail) {
    output.GIT_AUTHOR_EMAIL = gitEmail;
    output.GIT_COMMITTER_EMAIL = gitEmail;
  } else {
    delete output.GIT_AUTHOR_EMAIL;
    delete output.GIT_COMMITTER_EMAIL;
  }
  for (const name of CODEHUB_EMAIL_ENV_NAMES) {
    output[name] = gitEmail;
  }

  return output;
}

export function resolveManagedGitIdentity(userId, { users = userDb } = {}) {
  const user = users.getUserById?.(Number(userId));
  if (!user?.username) {
    throw createExecutionIdentityError('An active user with a current username is required');
  }
  const gitConfig = users.getGitConfig?.(Number(userId)) || {};
  return {
    name: String(gitConfig.git_name || user.username).trim(),
    email: String(gitConfig.git_email || '').trim() || null,
  };
}

function copyStringEnvironment(source) {
  return Object.fromEntries(
    Object.entries(source || {})
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => [name, String(value)]),
  );
}

function createExecutionIdentityError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
