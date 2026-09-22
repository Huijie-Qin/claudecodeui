import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const pending = new Map();
const owned = new AsyncLocalStorage();
let mutationGuard = async () => {};
export const setSkillMutationGuard = (guard) => { mutationGuard = guard; };
export const checkSkillMutation = (options) => mutationGuard(options);
// Reentrant within a file transaction. Job locks are separate and never block user editing.
export async function withSkillLock(workspacePath, name, run) {
  const key = path.resolve(workspacePath); // Includes market imports and managed-copy transactions.
  if (owned.getStore()?.has(key)) return run();
  const before = pending.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = before.catch(() => {}).then(() => gate);
  pending.set(key, tail);
  await before.catch(() => {});
  try { return await owned.run(new Set([...(owned.getStore() || []), key]), run); }
  finally { release(); if (pending.get(key) === tail) pending.delete(key); }
}
