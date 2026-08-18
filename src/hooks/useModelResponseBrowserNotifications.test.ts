import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MODEL_RESPONSE_HOOK_CONFIG,
  shouldSuppressRunCompletedAfterUserConfirmation,
} from './modelResponseNotificationHooks';
import type { ModelResponseHookNotification } from './modelResponseNotificationHooks';
import {
  showModelResponseNotification,
  subscribeToDesktopNotificationActivations,
} from './desktopNotificationBridge';

const baseNotification = {
  title: 'Assistant notification',
  body: 'A model response event occurred.',
  sessionId: 'session-1',
} satisfies Omit<ModelResponseHookNotification, 'tag' | 'trigger'>;

const notificationConfig = {
  ...DEFAULT_MODEL_RESPONSE_HOOK_CONFIG,
  enabled: true,
  browserNotifications: true,
  fallbackAlert: false,
};

async function withMockWindow<T>(
  mockWindow: Record<string, unknown>,
  run: () => T | Promise<T>,
): Promise<T> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: mockWindow,
  });

  try {
    return await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

function createDesktopBridge(
  overrides: Partial<CloudCliDesktopBridge> = {},
): CloudCliDesktopBridge {
  return {
    isDesktop: true,
    platform: 'darwin',
    appVersion: '1.0.0',
    showNotification: async () => true,
    onNotificationActivated: () => () => undefined,
    ...overrides,
  };
}

test('model response hook suppresses the next run completed notification after user confirmation', () => {
  const promptedRunKeys = new Set<string>();
  const runKey = 'claude:session-1';

  const userConfirmation = {
    ...baseNotification,
    trigger: 'userConfirmation',
    tag: 'confirm-1',
  } satisfies ModelResponseHookNotification;
  const runCompleted = {
    ...baseNotification,
    trigger: 'runCompleted',
    tag: 'complete-1',
  } satisfies ModelResponseHookNotification;

  assert.equal(shouldSuppressRunCompletedAfterUserConfirmation(
    userConfirmation,
    runKey,
    promptedRunKeys,
  ), false);
  assert.equal(promptedRunKeys.has(runKey), true);

  assert.equal(shouldSuppressRunCompletedAfterUserConfirmation(
    runCompleted,
    runKey,
    promptedRunKeys,
  ), true);
  assert.equal(promptedRunKeys.has(runKey), false);

  assert.equal(shouldSuppressRunCompletedAfterUserConfirmation(
    { ...runCompleted, tag: 'complete-2' },
    runKey,
    promptedRunKeys,
  ), false);
});

test('model response hook keeps run completed notifications for other sessions', () => {
  const promptedRunKeys = new Set<string>(['claude:session-1']);
  const runCompleted = {
    ...baseNotification,
    trigger: 'runCompleted',
    tag: 'complete-2',
  } satisfies ModelResponseHookNotification;

  assert.equal(shouldSuppressRunCompletedAfterUserConfirmation(
    runCompleted,
    'claude:session-2',
    promptedRunKeys,
  ), false);
  assert.equal(promptedRunKeys.has('claude:session-1'), true);
});

test('model response hook sends native notifications through the desktop bridge', async () => {
  let desktopInput: CloudCliDesktopNotificationInput | undefined;
  let browserNotificationCount = 0;

  class FakeNotification {
    static permission = 'granted';

    constructor() {
      browserNotificationCount += 1;
    }
  }

  const bridge = createDesktopBridge({
    showNotification: async (input) => {
      desktopInput = input;
      return true;
    },
  });

  await withMockWindow({
    cloudcliDesktop: bridge,
    Notification: FakeNotification,
    alert: () => undefined,
    focus: () => undefined,
  }, async () => {
    await showModelResponseNotification({
      ...baseNotification,
      trigger: 'runCompleted',
      tag: 'complete-desktop',
    }, notificationConfig);
  });

  assert.deepEqual(desktopInput, {
    tag: 'complete-desktop',
    title: baseNotification.title,
    body: baseNotification.body,
    sessionId: 'session-1',
  });
  assert.equal(browserNotificationCount, 0);
});

test('model response hook retains browser notifications when the desktop bridge is absent', async () => {
  type FakeNotificationInstance = {
    title: string;
    options?: NotificationOptions;
    onclick: (() => void) | null;
    closed: boolean;
  };

  const instances: FakeNotificationInstance[] = [];
  let focusCount = 0;
  const navigatedSessions: string[] = [];

  class FakeNotification implements FakeNotificationInstance {
    static permission = 'granted';
    onclick: (() => void) | null = null;
    closed = false;

    constructor(
      readonly title: string,
      readonly options?: NotificationOptions,
    ) {
      instances.push(this);
    }

    close() {
      this.closed = true;
    }
  }

  await withMockWindow({
    Notification: FakeNotification,
    alert: () => undefined,
    focus: () => {
      focusCount += 1;
    },
  }, async () => {
    await showModelResponseNotification({
      ...baseNotification,
      trigger: 'userConfirmation',
      tag: 'confirm-browser',
      requiresUserAction: true,
    }, notificationConfig, (sessionId) => {
      navigatedSessions.push(sessionId);
    });

    assert.equal(instances.length, 1);
    assert.equal(instances[0].title, baseNotification.title);
    assert.deepEqual(instances[0].options, {
      body: baseNotification.body,
      tag: 'confirm-browser',
      requireInteraction: true,
    });

    instances[0].onclick?.();
  });

  assert.equal(focusCount, 1);
  assert.deepEqual(navigatedSessions, ['session-1']);
  assert.equal(instances[0].closed, true);
});

test('model response hook falls back to an alert when desktop notification delivery fails', async () => {
  const alerts: string[] = [];
  const navigatedSessions: string[] = [];
  let focusCount = 0;
  const previousWarn = console.warn;
  console.warn = () => undefined;

  try {
    await withMockWindow({
      cloudcliDesktop: createDesktopBridge({
        showNotification: async () => {
          throw new Error('native notifications unavailable');
        },
      }),
      alert: (message: string) => {
        alerts.push(message);
      },
      focus: () => {
        focusCount += 1;
      },
    }, async () => {
      await showModelResponseNotification({
        ...baseNotification,
        trigger: 'error',
        tag: 'error-desktop',
      }, {
        ...notificationConfig,
        fallbackAlert: true,
      }, (sessionId) => {
        navigatedSessions.push(sessionId);
      });
    });
  } finally {
    console.warn = previousWarn;
  }

  assert.deepEqual(alerts, [`${baseNotification.title}\n\n${baseNotification.body}`]);
  assert.equal(focusCount, 1);
  assert.deepEqual(navigatedSessions, ['session-1']);
});

test('desktop notification activation navigates by session id and returns its cleanup', async () => {
  let activationListener: ((input: CloudCliDesktopNotificationActivation) => void) | undefined;
  let cleanupCount = 0;
  const navigatedSessions: string[] = [];

  await withMockWindow({
    cloudcliDesktop: createDesktopBridge({
      onNotificationActivated: (listener) => {
        activationListener = listener;
        return () => {
          cleanupCount += 1;
        };
      },
    }),
  }, () => {
    const cleanup = subscribeToDesktopNotificationActivations((sessionId) => {
      navigatedSessions.push(sessionId);
    });

    activationListener?.({ sessionId: '  session-2  ' });
    activationListener?.({});
    cleanup?.();
  });

  assert.deepEqual(navigatedSessions, ['session-2']);
  assert.equal(cleanupCount, 1);
});
