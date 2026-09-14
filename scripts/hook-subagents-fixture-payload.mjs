export function readToolPayload(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { /* Claude CLI may append a system reminder. */ }
  const text = value.trimStart();
  if (!['{', '['].includes(text[0])) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
    if (depth === 0) {
      try { return JSON.parse(text.slice(0, index + 1)); } catch { return null; }
    }
  }
  return null;
}

export function findTaskResult(value) {
  if (typeof value === 'string') return findTaskResult(readToolPayload(value));
  if (!value || typeof value !== 'object') return null;
  if (typeof value.task_id === 'string' && ['running', 'success', 'failed'].includes(value.status)) return value;
  for (const nested of Object.values(value)) {
    const task = findTaskResult(nested);
    if (task) return task;
  }
  return null;
}
