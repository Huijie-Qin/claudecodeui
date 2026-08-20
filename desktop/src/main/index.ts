import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  session,
  Tray,
} from 'electron';
import { DesktopBackendController } from './backend-controller';
import { DesktopIpcController } from './desktop-ipc';
import { DesktopNotificationController } from './notification-controller';
import {
  installOfflineProtocol,
  isOfflineDocumentUrl,
  OFFLINE_PAGE_URL,
  registerOfflineScheme,
  resolveOfflinePageUrl,
} from './offline-protocol';
import { resolveDesktopRuntimePaths } from './runtime-paths';
import {
  configureSessionPermissions,
  configureWindowNavigation,
  installApplicationSecurity,
} from './security';
import { DesktopUpdater } from './updater';
import { createSecureWebPreferences } from '../shared/security-policy';
import { APP_ID, SESSION_PARTITION } from '../shared/runtime-config';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: DesktopBackendController | null = null;
let desktopIpc: DesktopIpcController | null = null;
let isQuitting = false;
let backendShutdownComplete = false;
let backendShutdownPromise: Promise<void> | null = null;
let offlineUrl = '';

registerOfflineScheme();
app.setName('CloudCLI');
app.setAppUserModelId(APP_ID);
installApplicationSecurity();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function getAllowedOrigins(): ReadonlySet<string> {
  const origin = backend?.getOrigin();
  return origin ? new Set([origin]) : new Set();
}

const updater = new DesktopUpdater(
  () => mainWindow,
  async () => {
    await shutdownBackend();
  },
  async () => {
    await recoverAfterFailedUpdateRestart();
  },
);
const notifications = new DesktopNotificationController(
  () => mainWindow,
  getAllowedOrigins,
);

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function isOfflinePageUrl(url: string): boolean {
  if (!offlineUrl) {
    return false;
  }
  if (offlineUrl === OFFLINE_PAGE_URL) {
    return isOfflineDocumentUrl(url);
  }
  try {
    const expected = new URL(offlineUrl);
    const candidate = new URL(url);
    return candidate.origin === expected.origin;
  } catch {
    return false;
  }
}

function resolveTrayIconPath(): string {
  if (process.platform === 'darwin') {
    return app.isPackaged
      ? join(process.resourcesPath, 'trayTemplate.png')
      : join(app.getAppPath(), 'build', 'trayTemplate.png');
  }
  return resolveAppIconPath();
}

function resolveAppIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app-icon.png')
    : join(app.getAppPath(), 'build', 'icon.png');
}

function applyApplicationIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) {
    return;
  }

  const appIcon = nativeImage.createFromPath(resolveAppIconPath());
  if (!appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }
}

function createTray(): void {
  const trayImage = nativeImage.createFromPath(resolveTrayIconPath());
  if (process.platform === 'darwin') {
    trayImage.setTemplateImage(true);
  }
  tray = new Tray(trayImage);
  tray.setToolTip('CloudCLI');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开',
      click: showMainWindow,
    },
    {
      label: '检查更新',
      click: () => {
        void updater.check(true);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        void requestExplicitQuit();
      },
    },
  ]));
  tray.on('double-click', showMainWindow);
}

async function shutdownBackend(): Promise<void> {
  if (backendShutdownComplete) {
    return;
  }
  if (backendShutdownPromise) {
    return backendShutdownPromise;
  }

  isQuitting = true;
  backendShutdownPromise = (async () => {
    try {
      await backend?.stop();
    } catch (error) {
      console.error('[desktop] Failed to stop the local backend cleanly.', error);
    } finally {
      backendShutdownComplete = true;
    }
  })();
  return backendShutdownPromise;
}

async function recoverAfterFailedUpdateRestart(): Promise<void> {
  // The installer never took ownership of application shutdown. Restore the
  // normal tray/window lifecycle before starting the backend so status events
  // can navigate the window back to the local application.
  backendShutdownComplete = false;
  backendShutdownPromise = null;
  isQuitting = false;

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }
  showMainWindow();

  if (!backend) {
    throw new Error('The local backend controller is unavailable.');
  }
  try {
    await backend.start();
    showMainWindow();
  } catch (error) {
    loadBackendErrorPage();
    showMainWindow();
    throw error;
  }
}

async function requestExplicitQuit(): Promise<void> {
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: '退出 CloudCLI',
    message: '确定退出桌面客户端吗？',
    detail: '退出会停止接收新请求，并等待本机正在运行的任务完成；最长等待 30 分钟。',
    buttons: ['退出', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) {
    app.quit();
  }
}

function loadBackendErrorPage(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || isQuitting) {
    return;
  }
  if (isOfflinePageUrl(window.webContents.getURL())) {
    window.webContents.reload();
    return;
  }
  void window.loadURL(offlineUrl);
}

function createMainWindow(): BrowserWindow {
  const preloadPath = join(__dirname, '../preload/index.js');
  offlineUrl = resolveOfflinePageUrl(
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
  );

  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'CloudCLI',
    backgroundColor: '#0f172a',
    icon: resolveAppIconPath(),
    webPreferences: {
      ...createSecureWebPreferences(SESSION_PARTITION),
      preload: preloadPath,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });

  configureWindowNavigation(window, {
    isInternalUrl: isOfflinePageUrl,
    getAllowedOrigins,
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    mainWindow = null;
  });
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || isOfflinePageUrl(validatedUrl)) {
        return;
      }
      loadBackendErrorPage();
    },
  );

  // The local application itself is not loaded until the utility process sends
  // a validated ready message. This renderer doubles as startup/crash recovery UI.
  void window.loadURL(offlineUrl);
  return window;
}

function createBackendController(): DesktopBackendController {
  const runtimePaths = resolveDesktopRuntimePaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  return new DesktopBackendController({
    utilityEntry: join(__dirname, 'backend-entry.js'),
    runtimePaths,
    stateDirectory: app.getPath('userData'),
  });
}

function handleBackendStatus(): void {
  const status = backend?.getStatus();
  const window = mainWindow;
  if (!status || !window || window.isDestroyed() || isQuitting) {
    return;
  }

  if (status.state === 'ready') {
    if (window.webContents.getURL() !== `${status.origin}/`) {
      void window.loadURL(`${status.origin}/`);
    }
  } else if (status.state === 'error') {
    loadBackendErrorPage();
    showMainWindow();
  }
}

app.on('second-instance', () => {
  showMainWindow();
});
app.on('before-quit', (event) => {
  if (backendShutdownComplete || !backend) {
    isQuitting = true;
    return;
  }

  event.preventDefault();
  void shutdownBackend().finally(() => {
    app.quit();
  });
});
app.on('activate', () => {
  showMainWindow();
});
app.on('window-all-closed', () => {
  // The tray owns application lifetime. Explicit Quit is the only exit action.
});

if (hasSingleInstanceLock) {
  void app.whenReady().then(() => {
    applyApplicationIcon();
    const desktopSession = session.fromPartition(SESSION_PARTITION);
    installOfflineProtocol(desktopSession);
    configureSessionPermissions(desktopSession, { getAllowedOrigins });

    backend = createBackendController();
    backend.onStatusChange(handleBackendStatus);
    mainWindow = createMainWindow();
    desktopIpc = new DesktopIpcController({
      backend,
      isOfflineUrl: isOfflinePageUrl,
    });
    desktopIpc.register();
    notifications.register();
    createTray();
    updater.start();

    void backend.start().catch((error) => {
      console.error('[desktop] Local backend startup failed.', error);
    });
  });
}

app.on('quit', () => {
  desktopIpc?.dispose();
  desktopIpc = null;
  notifications.dispose();
  tray?.destroy();
  tray = null;
});
