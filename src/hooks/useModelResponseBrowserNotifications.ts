import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

import {
  DEFAULT_MODEL_RESPONSE_HOOK_CONFIG,
  buildModelResponseHookNotification,
  normalizeModelResponseHookConfig,
  shouldSuppressRunCompletedAfterUserConfirmation,
  type ModelResponseHookConfig,
  type ModelResponseHookMessage,
  type ModelResponseHookNotification,
} from './modelResponseNotificationHooks';

type UseModelResponseBrowserNotificationsArgs = {
  subscribeMessage?: (listener: (message: ModelResponseHookMessage) => void) => () => void;
  onNavigateToSession?: (sessionId: string) => void;
};

type ModelResponseHooksResponse = {
  success?: boolean;
  config?: ModelResponseHookConfig;
};

type StreamBuffer = {
  content: string;
  provider: string | null;
  sessionId: string | null;
  startedAt: number;
};

const MAX_SEEN_NOTIFICATIONS = 250;
const MAX_TRACKED_TOOL_USES = 120;

function canUseBrowserNotification(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function rememberLimited(set: Set<string>, value: string, limit: number) {
  set.add(value);
  if (set.size <= limit) {
    return;
  }

  const first = set.values().next().value;
  if (first) {
    set.delete(first);
  }
}

function rememberToolUse(
  map: Map<string, ModelResponseHookMessage>,
  message: ModelResponseHookMessage,
) {
  if (message.kind !== 'tool_use' || !message.toolId) {
    return;
  }

  map.set(message.toolId, message);
  while (map.size > MAX_TRACKED_TOOL_USES) {
    const first = map.keys().next().value;
    if (!first) {
      break;
    }
    map.delete(first);
  }
}

function getSessionId(message: ModelResponseHookMessage): string | null {
  return message.sessionId || message.session_id || null;
}

function getStreamKey(message: ModelResponseHookMessage): string {
  return [
    message.provider || 'assistant',
    getSessionId(message) || 'no-session',
  ].join(':');
}

function getNotificationRunKey(message: ModelResponseHookMessage): string | null {
  const sessionId = getSessionId(message);
  if (!sessionId) {
    return null;
  }

  return [
    message.provider || 'assistant',
    sessionId,
  ].join(':');
}

function normalizeDedupeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function appendStreamDelta(
  buffers: Map<string, StreamBuffer>,
  message: ModelResponseHookMessage,
) {
  const content = message.content || message.text || '';
  if (!content) {
    return;
  }

  const key = getStreamKey(message);
  const current = buffers.get(key);
  if (current) {
    current.content += content;
    return;
  }

  buffers.set(key, {
    content,
    provider: message.provider || null,
    sessionId: getSessionId(message),
    startedAt: Date.now(),
  });
}

function flushStreamBuffer(
  buffers: Map<string, StreamBuffer>,
  message: ModelResponseHookMessage,
): ModelResponseHookMessage | null {
  const key = getStreamKey(message);
  const buffer = buffers.get(key);
  if (!buffer) {
    return null;
  }

  buffers.delete(key);
  if (!buffer.content.trim()) {
    return null;
  }

  return {
    id: `stream-output:${buffer.startedAt}`,
    kind: 'text',
    role: 'assistant',
    content: buffer.content,
    provider: buffer.provider || message.provider,
    sessionId: buffer.sessionId || getSessionId(message) || undefined,
    timestamp: new Date().toISOString(),
  };
}

function showBrowserNotification(
  notification: ModelResponseHookNotification,
  config: ModelResponseHookConfig,
  onNavigateToSession?: (sessionId: string) => void,
) {
  const handleClick = () => {
    window.focus();
    if (notification.sessionId) {
      onNavigateToSession?.(notification.sessionId);
    }
  };

  if (config.browserNotifications && canUseBrowserNotification() && Notification.permission === 'granted') {
    const browserNotification = new Notification(notification.title, {
      body: notification.body,
      tag: notification.tag,
      requireInteraction: notification.requiresUserAction === true,
    });
    browserNotification.onclick = () => {
      handleClick();
      browserNotification.close();
    };
    return;
  }

  if (config.fallbackAlert) {
    window.alert(`${notification.title}\n\n${notification.body}`);
    handleClick();
  }
}

export function useModelResponseBrowserNotifications({
  subscribeMessage,
  onNavigateToSession,
}: UseModelResponseBrowserNotificationsArgs) {
  const [config, setConfig] = useState<ModelResponseHookConfig>(() => DEFAULT_MODEL_RESPONSE_HOOK_CONFIG);
  const configRef = useRef(config);
  const seenNotificationsRef = useRef(new Set<string>());
  const seenKeywordBodiesRef = useRef(new Set<string>());
  const userConfirmationRunKeysRef = useRef(new Set<string>());
  const toolUsesRef = useRef(new Map<string, ModelResponseHookMessage>());
  const streamBuffersRef = useRef(new Map<string, StreamBuffer>());

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const loadConfig = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/settings/model-response-hooks');
      if (!response.ok) {
        return;
      }

      const payload = await response.json() as ModelResponseHooksResponse;
      if (payload.success && payload.config) {
        setConfig(normalizeModelResponseHookConfig(payload.config));
      }
    } catch (error) {
      console.warn('[ModelResponseHooks] Failed to load hook config:', error);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!subscribeMessage) {
      return undefined;
    }

    return subscribeMessage((message) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      if ((message as { type?: string }).type === 'model-response-hooks-updated') {
        setConfig(normalizeModelResponseHookConfig((message as { config?: unknown }).config));
        return;
      }

      rememberToolUse(toolUsesRef.current, message);

      if (message.kind === 'stream_delta') {
        appendStreamDelta(streamBuffersRef.current, message);
        return;
      }

      if (message.kind === 'stream_end' || message.kind === 'complete') {
        const finalStreamMessage = flushStreamBuffer(streamBuffersRef.current, message);
        if (finalStreamMessage) {
          const streamNotification = buildModelResponseHookNotification(finalStreamMessage, configRef.current, null);
          if (streamNotification && !seenNotificationsRef.current.has(streamNotification.tag)) {
            const bodyKey = normalizeDedupeText(`${streamNotification.sessionId || ''}:${streamNotification.body}`);
            if (!seenKeywordBodiesRef.current.has(bodyKey)) {
              rememberLimited(seenKeywordBodiesRef.current, bodyKey, MAX_SEEN_NOTIFICATIONS);
              rememberLimited(seenNotificationsRef.current, streamNotification.tag, MAX_SEEN_NOTIFICATIONS);
              showBrowserNotification(streamNotification, configRef.current, onNavigateToSession);
            }
          }
        }
      }

      const relatedToolUse = message.toolId ? toolUsesRef.current.get(message.toolId) : null;
      const notification = buildModelResponseHookNotification(message, configRef.current, relatedToolUse);
      if (!notification) {
        return;
      }

      if (seenNotificationsRef.current.has(notification.tag)) {
        return;
      }

      if (shouldSuppressRunCompletedAfterUserConfirmation(
        notification,
        getNotificationRunKey(message),
        userConfirmationRunKeysRef.current,
      )) {
        rememberLimited(seenNotificationsRef.current, notification.tag, MAX_SEEN_NOTIFICATIONS);
        return;
      }

      if (notification.trigger === 'assistantKeyword') {
        const bodyKey = normalizeDedupeText(`${notification.sessionId || ''}:${notification.body}`);
        if (seenKeywordBodiesRef.current.has(bodyKey)) {
          return;
        }
        rememberLimited(seenKeywordBodiesRef.current, bodyKey, MAX_SEEN_NOTIFICATIONS);
      }

      rememberLimited(seenNotificationsRef.current, notification.tag, MAX_SEEN_NOTIFICATIONS);
      showBrowserNotification(notification, configRef.current, onNavigateToSession);
    });
  }, [onNavigateToSession, subscribeMessage]);
}
