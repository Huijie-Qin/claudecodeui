import {
  app,
  shell,
  type BrowserWindow,
  type Session,
  type WebContents,
} from 'electron';
import { classifyNavigation, type OriginPolicy } from '../shared/origins';
import {
  isAllowedDownloadRequest,
  isAllowedWebPermission,
} from '../shared/security-policy';

interface DynamicOriginOptions {
  getAllowedOrigins: () => ReadonlySet<string>;
}

interface NavigationGuardOptions extends DynamicOriginOptions {
  isInternalUrl: (url: string) => boolean;
}

function currentOriginPolicy(options: DynamicOriginOptions): OriginPolicy {
  return {
    allowedOrigins: options.getAllowedOrigins(),
    // Remote HTTPS navigation belongs in the system browser. OAuth callbacks
    // return to the local loopback origin and are covered by allowedOrigins.
    authOrigins: new Set<string>(),
  };
}

function isTrustedPermissionRequest(
  webContents: WebContents | null,
  permission: string,
  requestingUrl: string,
  isMainFrame: boolean,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  return isAllowedWebPermission(
    permission,
    requestingUrl,
    isMainFrame,
    allowedOrigins,
    webContents?.getURL(),
  );
}

export function configureSessionPermissions(
  desktopSession: Session,
  options: DynamicOriginOptions,
): void {
  desktopSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const allowedOrigins = options.getAllowedOrigins();
    return isTrustedPermissionRequest(
      webContents,
      permission,
      details.requestingUrl || requestingOrigin,
      details.isMainFrame,
      allowedOrigins,
    );
  });

  desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isTrustedPermissionRequest(
      webContents,
      permission,
      details.requestingUrl,
      details.isMainFrame,
      options.getAllowedOrigins(),
    ));
  });

  desktopSession.setDevicePermissionHandler(() => false);

  desktopSession.on('will-download', (event, item, webContents) => {
    if (!isAllowedDownloadRequest(
      webContents.getURL(),
      item.getURLChain(),
      item.hasUserGesture(),
      options.getAllowedOrigins(),
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

export function configureWindowNavigation(
  mainWindow: BrowserWindow,
  options: NavigationGuardOptions,
): void {
  const handleMainNavigation = (event: Electron.Event, url: string): void => {
    if (options.isInternalUrl(url)) {
      event.preventDefault();
      return;
    }

    const disposition = classifyNavigation(url, currentOriginPolicy(options));
    if (disposition === 'allowed') {
      return;
    }

    event.preventDefault();
    if (disposition === 'external') {
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
    const disposition = classifyNavigation(event.url, currentOriginPolicy(options));
    if (disposition !== 'allowed') {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) {
      return;
    }
    const disposition = classifyNavigation(event.url, currentOriginPolicy(options));
    if (disposition !== 'allowed') {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const disposition = classifyNavigation(url, currentOriginPolicy(options));
    if (disposition === 'allowed') {
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
