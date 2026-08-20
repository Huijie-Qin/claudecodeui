declare const __DESKTOP_UPDATE_BASE_URL__: string;
declare const __DESKTOP_APP_VERSION__: string;

interface CloudCliDesktopNotificationInput {
  tag: string;
  title: string;
  body: string;
  sessionId?: string;
}

interface CloudCliDesktopNotificationActivation {
  sessionId?: string;
}

interface CloudCliDesktopBootstrapUser {
  id?: number | string;
  username: string;
  [key: string]: unknown;
}

interface CloudCliDesktopBootstrapSession {
  user: CloudCliDesktopBootstrapUser;
  token: string;
}

type CloudCliDesktopBackendStatus =
  | { state: 'stopped' }
  | { state: 'starting'; message: string }
  | { state: 'ready'; origin: string }
  | { state: 'stopping'; message: string }
  | { state: 'error'; code: string; message: string };

interface CloudCliDesktopBridge {
  readonly isDesktop: true;
  readonly platform: 'darwin' | 'win32';
  readonly appVersion: string;
  getBootstrapSession(): Promise<CloudCliDesktopBootstrapSession | null>;
  getBackendStatus(): Promise<CloudCliDesktopBackendStatus>;
  retryBackend(): Promise<CloudCliDesktopBackendStatus>;
  openBackendLogs(): Promise<void>;
  showNotification(input: CloudCliDesktopNotificationInput): Promise<boolean>;
  onNotificationActivated(
    listener: (input: CloudCliDesktopNotificationActivation) => void,
  ): () => void;
}

interface Window {
  cloudcliDesktop?: CloudCliDesktopBridge;
}
