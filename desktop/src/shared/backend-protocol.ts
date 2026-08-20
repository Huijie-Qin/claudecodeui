export interface DesktopBootstrapUser {
  id?: number | string;
  username: string;
  [key: string]: unknown;
}

export interface DesktopBootstrapSession {
  user: DesktopBootstrapUser;
  token: string;
}

export interface DesktopBackendReadyMessage {
  type: 'ready';
  port: number;
  origin: string;
  session: DesktopBootstrapSession | null;
}

export interface DesktopBackendStartupErrorMessage {
  type: 'startup-error';
  code: string;
  message: string;
}

export interface DesktopBootstrapSessionRequest {
  type: 'bootstrap-session-request';
  requestId: string;
}

export interface DesktopBootstrapSessionResultMessage {
  type: 'bootstrap-session-result';
  requestId: string;
  session: DesktopBootstrapSession;
}

export interface DesktopBootstrapSessionErrorMessage {
  type: 'bootstrap-session-error';
  requestId: string;
  code: string;
  message: string;
}

export type DesktopBootstrapSessionResponse =
  | DesktopBootstrapSessionResultMessage
  | DesktopBootstrapSessionErrorMessage;

export type DesktopBackendMessage =
  | DesktopBackendReadyMessage
  | DesktopBackendStartupErrorMessage;

export type DesktopBackendStatus =
  | { state: 'stopped' }
  | { state: 'starting'; message: string }
  | { state: 'ready'; origin: string }
  | { state: 'stopping'; message: string }
  | { state: 'error'; code: string; message: string };

const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_USERNAME_LENGTH = 256;
const MAX_ERROR_LENGTH = 2_000;
const ERROR_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,127}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export function isValidBackendPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

export function parseLoopbackBackendOrigin(value: unknown, port?: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(value);
    const parsedPort = parsed.port ? Number(parsed.port) : 80;
    if (
      parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || (port !== undefined && parsedPort !== port)
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function parseBootstrapSession(value: unknown): DesktopBootstrapSession | null | undefined {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const user = candidate.user;
  const token = candidate.token;
  const username = user && typeof user === 'object' && !Array.isArray(user)
    ? (user as Record<string, unknown>).username
    : undefined;
  if (
    !user
    || typeof user !== 'object'
    || Array.isArray(user)
    || typeof username !== 'string'
    || !username
    || username.length > MAX_USERNAME_LENGTH
    || typeof token !== 'string'
    || !token
    || token.length > MAX_TOKEN_LENGTH
  ) {
    return undefined;
  }

  return {
    user: { ...(user as DesktopBootstrapUser) },
    token,
  };
}

export function createDesktopBootstrapSessionRequest(
  requestId: string,
): DesktopBootstrapSessionRequest {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new TypeError('Desktop bootstrap request ID is invalid.');
  }
  return { type: 'bootstrap-session-request', requestId };
}

export function parseDesktopBootstrapSessionResponse(
  value: unknown,
): DesktopBootstrapSessionResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.requestId !== 'string'
    || !REQUEST_ID_PATTERN.test(candidate.requestId)
  ) {
    return null;
  }

  if (candidate.type === 'bootstrap-session-result') {
    const session = parseBootstrapSession(candidate.session);
    if (!session) {
      return null;
    }
    return {
      type: 'bootstrap-session-result',
      requestId: candidate.requestId,
      session,
    };
  }

  if (candidate.type === 'bootstrap-session-error') {
    if (
      typeof candidate.code !== 'string'
      || !ERROR_CODE_PATTERN.test(candidate.code)
      || typeof candidate.message !== 'string'
      || !candidate.message.trim()
      || candidate.message.length > MAX_ERROR_LENGTH
    ) {
      return null;
    }
    return {
      type: 'bootstrap-session-error',
      requestId: candidate.requestId,
      code: candidate.code,
      message: candidate.message.trim(),
    };
  }

  return null;
}

export function parseDesktopBackendMessage(value: unknown): DesktopBackendMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'ready') {
    if (!isValidBackendPort(candidate.port)) {
      return null;
    }
    const origin = parseLoopbackBackendOrigin(candidate.origin, candidate.port);
    const session = parseBootstrapSession(candidate.session);
    if (!origin || session === undefined) {
      return null;
    }
    return {
      type: 'ready',
      port: candidate.port,
      origin,
      session,
    };
  }

  if (candidate.type === 'startup-error') {
    if (
      typeof candidate.code !== 'string'
      || !ERROR_CODE_PATTERN.test(candidate.code)
      || typeof candidate.message !== 'string'
      || !candidate.message.trim()
      || candidate.message.length > MAX_ERROR_LENGTH
    ) {
      return null;
    }
    return {
      type: 'startup-error',
      code: candidate.code,
      message: candidate.message.trim(),
    };
  }

  return null;
}
