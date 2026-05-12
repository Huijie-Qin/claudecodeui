import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  normalizeKeywordPatterns,
  normalizeModelResponseHookConfig,
  type ModelResponseHookConfig,
  type ModelResponseHookTriggers,
} from '../../../../hooks/modelResponseNotificationHooks';
import type { NotificationPreferencesState } from '../../types/types';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
};

function getBrowserNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }

  return Notification.permission;
}

export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const [browserPermission, setBrowserPermission] = useState<NotificationPermission | 'unsupported'>(() => (
    getBrowserNotificationPermission()
  ));
  const [browserPermissionMessage, setBrowserPermissionMessage] = useState('');
  const hooks = normalizeModelResponseHookConfig(notificationPreferences.modelResponseHooks);
  const syncedKeywordText = hooks.keywordPatterns.join('\n');
  const [keywordText, setKeywordText] = useState(() => hooks.keywordPatterns.join('\n'));
  const isEditingKeywordsRef = useRef(false);

  const browserNotificationsSupported = browserPermission !== 'unsupported';

  useEffect(() => {
    if (isEditingKeywordsRef.current) {
      return;
    }

    setKeywordText(syncedKeywordText);
  }, [syncedKeywordText]);

  const updateModelResponseHooks = (nextHooks: ModelResponseHookConfig) => {
    onNotificationPreferencesChange({
      ...notificationPreferences,
      modelResponseHooks: normalizeModelResponseHookConfig(nextHooks),
    });
  };

  const updateTrigger = (key: keyof ModelResponseHookTriggers, value: boolean) => {
    updateModelResponseHooks({
      ...hooks,
      triggers: {
        ...hooks.triggers,
        [key]: value,
      },
    });
  };

  const requestBrowserPermission = async () => {
    setBrowserPermissionMessage('');

    if (!browserNotificationsSupported || !('Notification' in window)) {
      setBrowserPermissionMessage(t(
        'notifications.modelHooks.permissionUnsupported',
        'This browser does not expose notification permission prompts.',
      ));
      return;
    }

    if (window.isSecureContext === false) {
      setBrowserPermissionMessage(t(
        'notifications.modelHooks.permissionInsecure',
        'Browser notifications require HTTPS or localhost.',
      ));
      return;
    }

    if (Notification.permission === 'denied') {
      setBrowserPermission('denied');
      setBrowserPermissionMessage(t(
        'notifications.modelHooks.permissionDenied',
        'Notifications are blocked. Enable them from browser site settings.',
      ));
      return;
    }

    const nextPermission = await Notification.requestPermission();
    setBrowserPermission(nextPermission);

    if (nextPermission === 'granted') {
      setBrowserPermissionMessage(t(
        'notifications.modelHooks.permissionGranted',
        'Browser notifications are allowed for this browser.',
      ));
      return;
    }

    if (nextPermission === 'denied') {
      setBrowserPermissionMessage(t(
        'notifications.modelHooks.permissionDenied',
        'Notifications are blocked. Enable them from browser site settings.',
      ));
      return;
    }

    setBrowserPermissionMessage(t(
      'notifications.modelHooks.permissionDismissed',
      'No permission prompt appeared or it was dismissed. The app browser may suppress notification prompts.',
    ));
  };

  const sendTestNotification = async () => {
    setBrowserPermissionMessage('');

    if (browserNotificationsSupported && 'Notification' in window && Notification.permission === 'default') {
      await requestBrowserPermission();
    }

    if (browserNotificationsSupported && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(t('notifications.modelHooks.testTitle', 'Model response hook'), {
        body: t('notifications.modelHooks.testBody', 'Browser notifications are ready.'),
        tag: `model-response-hook-test:${Date.now()}`,
      });
      return;
    }

    if (hooks.fallbackAlert) {
      window.alert(`${t('notifications.modelHooks.testTitle', 'Model response hook')}\n\n${t(
        'notifications.modelHooks.testBody',
        'Browser notifications are ready.',
      )}`);
      return;
    }

    setBrowserPermissionMessage(t(
      'notifications.modelHooks.testUnavailable',
      'No popup channel is currently available. Allow notifications or enable alert fallback.',
    ));
  };

  const updateKeywordText = (value: string) => {
    isEditingKeywordsRef.current = true;
    setKeywordText(value);
    updateModelResponseHooks({
      ...hooks,
      keywordPatterns: normalizeKeywordPatterns(value.split(/\r?\n/)),
    });
  };

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-blue-600" />
          <h3 className="text-lg font-medium text-foreground">{t('notifications.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('notifications.description')}</p>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h4 className="font-medium text-foreground">
            {t('notifications.modelHooks.title', 'Model response popups')}
          </h4>
          <p className="text-sm text-muted-foreground">
            {t(
              'notifications.modelHooks.description',
              'Show a browser popup when selected model conversation events arrive.',
            )}
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={hooks.enabled}
            onChange={(event) => updateModelResponseHooks({ ...hooks, enabled: event.target.checked })}
            className="h-4 w-4"
          />
          {t('notifications.modelHooks.enable', 'Enable model response popups')}
        </label>

        <div className="space-y-3 rounded-md border border-border p-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={hooks.browserNotifications}
              onChange={(event) => updateModelResponseHooks({ ...hooks, browserNotifications: event.target.checked })}
              className="h-4 w-4"
            />
            {t('notifications.modelHooks.browserNotifications', 'Browser notifications')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={hooks.fallbackAlert}
              onChange={(event) => updateModelResponseHooks({ ...hooks, fallbackAlert: event.target.checked })}
              className="h-4 w-4"
            />
            {t('notifications.modelHooks.fallbackAlert', 'Use alert fallback when notifications are unavailable')}
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!browserNotificationsSupported || browserPermission === 'granted'}
              onClick={() => void requestBrowserPermission()}
              className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <BellRing className="h-4 w-4" />
              {browserPermission === 'granted'
                ? t('notifications.modelHooks.permissionAllowed', 'Allowed')
                : t('notifications.modelHooks.allowBrowser', 'Allow this browser')}
            </button>

            <button
              type="button"
              disabled={!browserNotificationsSupported && !hooks.fallbackAlert}
              onClick={() => void sendTestNotification()}
              className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {t('notifications.modelHooks.testPopup', 'Test popup')}
            </button>

            <span className="text-xs text-muted-foreground">
              {t('notifications.modelHooks.permissionLabel', 'Permission')}: {browserPermission}
            </span>
          </div>

          {browserPermissionMessage ? (
            <p className="text-sm text-muted-foreground">{browserPermissionMessage}</p>
          ) : null}
        </div>

        <div className="space-y-3 rounded-md border border-border p-3">
          <h5 className="text-sm font-medium text-foreground">
            {t('notifications.modelHooks.triggersTitle', 'Triggers')}
          </h5>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={hooks.triggers.userConfirmation}
                onChange={(event) => updateTrigger('userConfirmation', event.target.checked)}
                className="h-4 w-4"
              />
              {t('notifications.modelHooks.userConfirmation', 'User confirmation or question')}
            </label>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={hooks.triggers.runCompleted}
                onChange={(event) => updateTrigger('runCompleted', event.target.checked)}
                className="h-4 w-4"
              />
              {t('notifications.modelHooks.runCompleted', 'Run completed')}
            </label>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={hooks.triggers.error}
                onChange={(event) => updateTrigger('error', event.target.checked)}
                className="h-4 w-4"
              />
              {t('notifications.modelHooks.errors', 'Errors')}
            </label>
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-border p-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={hooks.triggers.assistantKeyword}
              onChange={(event) => updateTrigger('assistantKeyword', event.target.checked)}
              className="h-4 w-4"
            />
            {t('notifications.modelHooks.keywordTrigger', 'Match custom response keywords')}
          </label>

          <textarea
            value={keywordText}
            onChange={(event) => updateKeywordText(event.target.value)}
            onBlur={() => {
              isEditingKeywordsRef.current = false;
              setKeywordText(syncedKeywordText);
            }}
            placeholder={t('notifications.modelHooks.keywordPlaceholder', 'One keyword per line')}
            className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>

    </div>
  );
}
