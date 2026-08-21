import {
  app,
  BrowserWindow,
  shell,
  type Session,
  type WebContents,
} from 'electron';
import {
  classifyNavigation,
  type OriginPolicy,
} from '../shared/origins';
import {
  createSecureWebPreferences,
  isAllowedDownloadRequest,
  isAllowedWebPermission,
} from '../shared/security-policy';
import { ALLOWED_ORIGINS, AUTH_ORIGINS, SESSION_PARTITION } from '../shared/runtime-config';

interface NavigationGuardOptions {
  isInternalUrl: (url: string) => boolean;
  onAllowedReturn?: (url: string) => void;
}

const originPolicy: OriginPolicy = {
  allowedOrigins: ALLOWED_ORIGINS,
  authOrigins: AUTH_ORIGINS,
};

function isTrustedPermissionRequest(
  webContents: WebContents | null,
  permission: string,
  requestingUrl: string,
  isMainFrame = true,
): boolean {
  return isAllowedWebPermission(
    permission,
    requestingUrl,
    isMainFrame,
    ALLOWED_ORIGINS,
    webContents?.getURL(),
  );
}

export function configureSessionPermissions(desktopSession: Session): void {
  desktopSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    isTrustedPermissionRequest(
      webContents,
      permission,
      details.requestingUrl || requestingOrigin,
      details.isMainFrame,
    )
  ));

  desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isTrustedPermissionRequest(
      webContents,
      permission,
      details.requestingUrl,
      details.isMainFrame,
    ));
  });

  desktopSession.setDevicePermissionHandler(() => false);

  desktopSession.on('will-download', (event, item, webContents) => {
    if (!isAllowedDownloadRequest(
      webContents.getURL(),
      item.getURLChain(),
      item.hasUserGesture(),
      ALLOWED_ORIGINS,
    )) {
      event.preventDefault();
    }
  });
}

function openExternalUrl(url: string): void {
  void shell.openExternal(url).catch((error: unknown) => {
    console.error('[desktop] Failed to open an external URL.', error);
  });
}

function secureWebPreferences(): Electron.WebPreferences {
  return createSecureWebPreferences(SESSION_PARTITION);
}

function configureAuthWindow(
  authWindow: BrowserWindow,
  parentWindow: BrowserWindow,
  options: NavigationGuardOptions,
): void {
  authWindow.setMenuBarVisibility(false);

  const handleAuthNavigation = (
    event: Electron.Event,
    url: string,
  ): void => {
    if (options.isInternalUrl(url)) {
      event.preventDefault();
      return;
    }

    const disposition = classifyNavigation(url, originPolicy);
    if (disposition === 'auth') {
      return;
    }
    event.preventDefault();

    if (disposition === 'allowed') {
      options.onAllowedReturn?.(url);
      if (!parentWindow.isDestroyed()) {
        void parentWindow.loadURL(url);
      }
      authWindow.close();
    } else if (disposition === 'external') {
      openExternalUrl(url);
    }
  };

  authWindow.webContents.on('will-navigate', (event) => {
    handleAuthNavigation(event, event.url);
  });
  authWindow.webContents.on('will-redirect', (event) => {
    if (event.isMainFrame) {
      handleAuthNavigation(event, event.url);
      return;
    }
    const disposition = classifyNavigation(event.url, originPolicy);
    if (disposition === 'denied' || disposition === 'external') {
      event.preventDefault();
    }
  });
  authWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) {
      return;
    }
    const disposition = classifyNavigation(event.url, originPolicy);
    if (disposition === 'denied' || disposition === 'external') {
      event.preventDefault();
    }
  });
  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    const disposition = classifyNavigation(url, originPolicy);
    if (disposition === 'auth') {
      void authWindow.loadURL(url);
    } else if (disposition === 'allowed') {
      if (!parentWindow.isDestroyed()) {
        void parentWindow.loadURL(url);
      }
      authWindow.close();
    } else if (disposition === 'external') {
      openExternalUrl(url);
    }
    return { action: 'deny' };
  });
  authWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

export function configureWindowNavigation(
  mainWindow: BrowserWindow,
  options: NavigationGuardOptions,
): void {
  let authWindow: BrowserWindow | null = null;

  const openAuthWindow = (url: string): void => {
    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.focus();
      void authWindow.loadURL(url);
      return;
    }

    authWindow = new BrowserWindow({
      parent: mainWindow,
      width: 560,
      height: 760,
      minWidth: 420,
      minHeight: 560,
      show: false,
      autoHideMenuBar: true,
      title: 'CloudCLI Sign In',
      webPreferences: secureWebPreferences(),
    });
    configureAuthWindow(authWindow, mainWindow, options);
    authWindow.once('ready-to-show', () => authWindow?.show());
    authWindow.once('closed', () => {
      authWindow = null;
    });
    void authWindow.loadURL(url);
  };

  const handleMainNavigation = (event: Electron.Event, url: string): void => {
    if (options.isInternalUrl(url)) {
      event.preventDefault();
      return;
    }

    const disposition = classifyNavigation(url, originPolicy);
    if (disposition === 'allowed') {
      return;
    }

    event.preventDefault();
    if (disposition === 'auth') {
      openAuthWindow(url);
    } else if (disposition === 'external') {
      openExternalUrl(url);
    }
  };

  mainWindow.webContents.on('will-navigate', (event) => {
    handleMainNavigation(event, event.url);
  });
  mainWindow.webContents.on('will-redirect', (event) => {
    if (event.isMainFrame) {
      handleMainNavigation(event, event.url);
      return;
    }
    const disposition = classifyNavigation(event.url, originPolicy);
    if (disposition === 'denied' || disposition === 'external') {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) {
      return;
    }

    const disposition = classifyNavigation(event.url, originPolicy);
    if (disposition === 'denied' || disposition === 'external') {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const disposition = classifyNavigation(url, originPolicy);
    if (disposition === 'auth') {
      openAuthWindow(url);
    } else if (disposition === 'allowed') {
      void mainWindow.loadURL(url);
    } else if (disposition === 'external') {
      openExternalUrl(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

export function installApplicationSecurity(): void {
  app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  });
}
