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

vi.mock('../src/shared/runtime-config', () => ({
  ALLOWED_ORIGINS: new Set(['https://cloudcli.example.com']),
  AUTH_ORIGINS: new Set(['https://login.example.com']),
  SESSION_PARTITION: 'persist:test',
}));

import { installApplicationSecurity } from '../src/main/security';

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
});
