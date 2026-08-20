import { describe, expect, it } from 'vitest';
import {
  createDesktopBootstrapSessionRequest,
  parseDesktopBackendMessage,
  parseDesktopBootstrapSessionResponse,
  parseLoopbackBackendOrigin,
} from '../src/shared/backend-protocol';

describe('desktop backend protocol', () => {
  it('accepts a structured ready message from the assigned loopback origin', () => {
    expect(parseDesktopBackendMessage({
      type: 'ready',
      port: 43123,
      origin: 'http://127.0.0.1:43123',
      session: {
        user: { id: 1, username: 'desktop-admin', role: 'admin' },
        token: 'signed-token',
      },
    })).toEqual({
      type: 'ready',
      port: 43123,
      origin: 'http://127.0.0.1:43123',
      session: {
        user: { id: 1, username: 'desktop-admin', role: 'admin' },
        token: 'signed-token',
      },
    });
  });

  it('rejects non-loopback, mismatched, credential-bearing, and malformed origins', () => {
    expect(parseLoopbackBackendOrigin('http://127.0.0.1:80', 80))
      .toBe('http://127.0.0.1');
    expect(parseLoopbackBackendOrigin('http://localhost:43123', 43123)).toBeNull();
    expect(parseLoopbackBackendOrigin('http://127.0.0.1:43124', 43123)).toBeNull();
    expect(parseLoopbackBackendOrigin('http://user@127.0.0.1:43123', 43123)).toBeNull();
    expect(parseLoopbackBackendOrigin('https://127.0.0.1:43123', 43123)).toBeNull();
    expect(parseLoopbackBackendOrigin('http://127.0.0.1:43123/path', 43123)).toBeNull();
  });

  it('rejects ready and startup errors that do not match the private contract', () => {
    expect(parseDesktopBackendMessage({
      type: 'ready',
      port: 43123,
      origin: 'http://127.0.0.1:43123',
      session: { user: { username: '' }, token: 'token' },
    })).toBeNull();
    expect(parseDesktopBackendMessage({
      type: 'startup-error',
      code: 'bad code',
      message: 'failed',
    })).toBeNull();
    expect(parseDesktopBackendMessage('ready')).toBeNull();
  });

  it('validates correlated fresh bootstrap session responses', () => {
    expect(createDesktopBootstrapSessionRequest('request_123')).toEqual({
      type: 'bootstrap-session-request',
      requestId: 'request_123',
    });
    expect(parseDesktopBootstrapSessionResponse({
      type: 'bootstrap-session-result',
      requestId: 'request_123',
      session: {
        user: { id: 1, username: 'desktop-admin' },
        token: 'fresh-token',
      },
    })).toEqual({
      type: 'bootstrap-session-result',
      requestId: 'request_123',
      session: {
        user: { id: 1, username: 'desktop-admin' },
        token: 'fresh-token',
      },
    });
    expect(parseDesktopBootstrapSessionResponse({
      type: 'bootstrap-session-error',
      requestId: 'request_123',
      code: 'DESKTOP_BOOTSTRAP_USER_UNAVAILABLE',
      message: 'User is disabled.',
    })).toEqual({
      type: 'bootstrap-session-error',
      requestId: 'request_123',
      code: 'DESKTOP_BOOTSTRAP_USER_UNAVAILABLE',
      message: 'User is disabled.',
    });
  });

  it('rejects malformed bootstrap request IDs, sessions, and errors', () => {
    expect(() => createDesktopBootstrapSessionRequest('bad request id')).toThrow(TypeError);
    expect(parseDesktopBootstrapSessionResponse({
      type: 'bootstrap-session-result',
      requestId: '../bad',
      session: { user: { username: 'admin' }, token: 'token' },
    })).toBeNull();
    expect(parseDesktopBootstrapSessionResponse({
      type: 'bootstrap-session-result',
      requestId: 'request-1',
      session: { user: { username: '' }, token: 'token' },
    })).toBeNull();
    expect(parseDesktopBootstrapSessionResponse({
      type: 'bootstrap-session-error',
      requestId: 'request-1',
      code: 'bad code',
      message: 'failed',
    })).toBeNull();
  });
});
