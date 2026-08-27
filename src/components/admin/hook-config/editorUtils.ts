import type { HookConfigDraft } from './types';

type HookItemIdRuntime = {
  randomUUID?: () => string;
  now?: () => number;
  random?: () => number;
};

export function createHookDraftSignature(hook: HookConfigDraft): string {
  return JSON.stringify({
    name: hook.name,
    description: hook.description,
    showInChat: hook.showInChat,
    eventName: hook.eventName,
    matcher: hook.matcher,
    extensionLogic: hook.extensionLogic,
    postActions: hook.postActions,
    claudeResponse: hook.claudeResponse,
  });
}

export function createHookItemId(runtime?: HookItemIdRuntime) {
  const randomUUID = runtime
    ? runtime.randomUUID
    : typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID.bind(globalThis.crypto)
      : undefined;

  if (randomUUID) return randomUUID();

  const now = (runtime?.now || Date.now)().toString(36);
  const random = (runtime?.random || Math.random)().toString(36).slice(2, 10);
  return `hook_item_${now}_${random}`;
}
