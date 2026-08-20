import { describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { on: electronMocks.appOn },
  BrowserWindow: class {},
  shell: { openExternal: electronMocks.openExternal },
}));

import {
  configureSessionPermissions,
  installApplicationSecurity,
} from '../src/main/security';

describe('application-wide security hooks', () => {
  it('always fails closed when Chromium reports a certificate error', () => {
    let certificateErrorHandler: ((...args: unknown[]) => void) | undefined;
    electronMocks.appOn.mockImplementation((eventName: string, handler: (...args: unknown[]) => void) => {
      if (eventName === 'certificate-error') {
        certificateErrorHandler = handler;
      }
    });

    installApplicationSecurity();
    expect(certificateErrorHandler).toBeTypeOf('function');

    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    certificateErrorHandler?.(
      event,
      null,
      'https://cloudcli.example.com/',
      'net::ERR_CERT_DATE_INVALID',
      {},
      callback,
    );

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(false);
  });

  it('updates renderer permissions only after the backend origin becomes ready', () => {
    let permissionCheck: ((
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: { requestingUrl: string; isMainFrame: boolean },
    ) => boolean) | undefined;
    let allowedOrigins = new Set<string>();
    const desktopSession = {
      setPermissionCheckHandler: vi.fn((handler) => {
        permissionCheck = handler;
      }),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      on: vi.fn(),
    };

    configureSessionPermissions(desktopSession as never, {
      getAllowedOrigins: () => allowedOrigins,
    });
    const webContents = { getURL: () => 'http://127.0.0.1:43123/' };
    const details = {
      requestingUrl: 'http://127.0.0.1:43123/session/1',
      isMainFrame: true,
    };

    expect(permissionCheck?.(
      webContents,
      'notifications',
      'http://127.0.0.1:43123',
      details,
    )).toBe(false);
    allowedOrigins = new Set(['http://127.0.0.1:43123']);
    expect(permissionCheck?.(
      webContents,
      'notifications',
      'http://127.0.0.1:43123',
      details,
    )).toBe(true);
  });
});
