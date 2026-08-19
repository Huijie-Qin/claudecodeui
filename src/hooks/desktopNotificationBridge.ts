import type {
  ModelResponseHookConfig,
  ModelResponseHookNotification,
} from './modelResponseNotificationHooks';

function canUseBrowserNotification(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function getDesktopBridge(): CloudCliDesktopBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const bridge = window.cloudcliDesktop;
  return bridge?.isDesktop === true ? bridge : null;
}

function showFallbackAlert(
  notification: ModelResponseHookNotification,
  config: ModelResponseHookConfig,
  onNavigateToSession?: (sessionId: string) => void,
) {
  if (!config.fallbackAlert || typeof window === 'undefined') {
    return;
  }

  window.alert(`${notification.title}\n\n${notification.body}`);
  window.focus();
  if (notification.sessionId) {
    onNavigateToSession?.(notification.sessionId);
  }
}

export async function showModelResponseNotification(
  notification: ModelResponseHookNotification,
  config: ModelResponseHookConfig,
  onNavigateToSession?: (sessionId: string) => void,
): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  const handleClick = () => {
    window.focus();
    if (notification.sessionId) {
      onNavigateToSession?.(notification.sessionId);
    }
  };

  if (config.browserNotifications) {
    const desktopBridge = getDesktopBridge();
    if (desktopBridge) {
      try {
        const shown = await desktopBridge.showNotification({
          tag: notification.tag,
          title: notification.title,
          body: notification.body,
          ...(notification.sessionId ? { sessionId: notification.sessionId } : {}),
        });
        if (shown) {
          return;
        }

        console.warn('[ModelResponseHooks] Desktop notification was not shown.');
      } catch (error) {
        console.warn('[ModelResponseHooks] Failed to show desktop notification:', error);
      }

      showFallbackAlert(notification, config, onNavigateToSession);
      return;
    }

    if (canUseBrowserNotification() && window.Notification.permission === 'granted') {
      try {
        const browserNotification = new window.Notification(notification.title, {
          body: notification.body,
          tag: notification.tag,
          requireInteraction: notification.requiresUserAction === true,
        });
        browserNotification.onclick = () => {
          handleClick();
          browserNotification.close();
        };
        return;
      } catch (error) {
        console.warn('[ModelResponseHooks] Failed to show browser notification:', error);
      }
    }
  }

  showFallbackAlert(notification, config, onNavigateToSession);
}

export function subscribeToDesktopNotificationActivations(
  onNavigateToSession?: (sessionId: string) => void,
): (() => void) | undefined {
  const desktopBridge = getDesktopBridge();
  if (!desktopBridge || typeof desktopBridge.onNotificationActivated !== 'function') {
    return undefined;
  }

  try {
    const unsubscribe = desktopBridge.onNotificationActivated((activation) => {
      const sessionId = typeof activation?.sessionId === 'string'
        ? activation.sessionId.trim()
        : '';
      if (sessionId) {
        onNavigateToSession?.(sessionId);
      }
    });

    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  } catch (error) {
    console.warn('[ModelResponseHooks] Failed to subscribe to desktop notification activations:', error);
    return undefined;
  }
}
