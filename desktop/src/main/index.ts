import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  session,
  Tray,
  dialog,
} from 'electron';
import { DesktopNotificationController } from './notification-controller';
import {
  installOfflineProtocol,
  isOfflineDocumentUrl,
  OFFLINE_PAGE_URL,
  registerOfflineScheme,
  resolveOfflinePageUrl,
} from './offline-protocol';
import {
  configureSessionPermissions,
  configureWindowNavigation,
  installApplicationSecurity,
} from './security';
import { DesktopUpdater } from './updater';
import { createSecureWebPreferences } from '../shared/security-policy';
import {
  APP_ID,
  HOME_URL,
  SESSION_PARTITION,
} from '../shared/runtime-config';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let offlineUrl = '';

registerOfflineScheme();
app.setName('CloudCLI');
app.setAppUserModelId(APP_ID);
installApplicationSecurity();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function prepareToQuit(): void {
  isQuitting = true;
}

const updater = new DesktopUpdater(() => mainWindow);
const notifications = new DesktopNotificationController(() => mainWindow);

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

async function requestExplicitQuit(): Promise<void> {
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: '退出 CloudCLI',
    message: '确定退出桌面客户端吗？',
    detail: '退出后将不再接收桌面通知，但正在运行的云端任务会继续。',
    buttons: ['退出', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) {
    prepareToQuit();
    app.quit();
  }
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
      void window.loadURL(offlineUrl);
    },
  );

  void window.loadURL(HOME_URL);
  return window;
}

app.on('second-instance', () => {
  showMainWindow();
});
app.on('before-quit', () => {
  prepareToQuit();
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
    configureSessionPermissions(desktopSession);
    mainWindow = createMainWindow();
    notifications.register();
    createTray();
    updater.start();
  });
}

app.on('quit', () => {
  notifications.dispose();
  tray?.destroy();
  tray = null;
});
