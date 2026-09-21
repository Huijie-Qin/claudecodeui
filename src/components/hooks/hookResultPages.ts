export const RESULT_PAGE_LINES = 100;
export const RESULT_PAGE_BYTES = 20 * 1024;

const sensitiveKey = /^(?:.*[_-])?(?:api[_-]?key|auth[_-]?token|private[_-]?token|user[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential)$/i;

function redactText(text: string) {
  return text
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|auth[_-]?token|private[_-]?token|user[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE)[A-Z0-9_]*\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]');
}

// Incremental formatting: opening page 1 never stringifies all 3000 rows.
export function* formatResultChunks(value: unknown, depth = 0, ancestors = new Set<object>()): Generator<string> {
  const indent = '  '.repeat(Math.min(depth, 30));
  if (typeof value === 'string') {
    const text = redactText(value);
    yield '"';
    for (let i = 0; i < text.length; i += 1024) yield JSON.stringify(text.slice(i, i + 1024)).slice(1, -1);
    yield '"';
  } else if (value === null || typeof value !== 'object') {
    yield JSON.stringify(value) ?? 'null';
  } else if (value instanceof Date) {
    yield JSON.stringify(value);
  } else if (ancestors.has(value) || depth >= 256) {
    yield JSON.stringify(ancestors.has(value) ? '[Circular]' : '[Depth limit]');
  } else {
    ancestors.add(value);
    const array = Array.isArray(value);
    yield array ? '[' : '{';
    let count = 0;
    function* entries(): Generator<[string, unknown]> {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) yield [String(i), value[i]];
      } else {
        for (const key in value as Record<string, unknown>) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          const entry = (value as Record<string, unknown>)[key];
          if (entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol') yield [key, entry];
        }
      }
    }
    for (const [key, entry] of entries()) {
      yield `${count++ ? ',' : ''}\n${indent}  `;
      if (!array) { yield* formatResultChunks(key); yield ': '; }
      yield* formatResultChunks(!array && sensitiveKey.test(key) ? '[REDACTED]' : entry, depth + 1, ancestors);
    }
    if (count) yield `\n${indent}`;
    yield array ? ']' : '}';
    ancestors.delete(value);
  }
}

export type ResultPage = { text: string; hasMore: boolean };

export function createResultPager(value: unknown) {
  const chunks = formatResultChunks(value);
  let pending = '';
  let done = false;
  const pages: ResultPage[] = [];
  const fill = () => {
    while (!pending && !done) {
      const next = chunks.next();
      done = Boolean(next.done);
      pending = next.value ?? '';
    }
  };
  return (index: number): ResultPage => {
    if (!Number.isInteger(index) || index < 0 || index > pages.length) throw new Error('Invalid result page');
    if (pages[index]) return pages[index];
    let text = '';
    let bytes = 0;
    let lines = 1;
    fill();
    while (pending && lines < RESULT_PAGE_LINES) {
      const point = pending.codePointAt(0)!;
      const character = String.fromCodePoint(point);
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes + size > RESULT_PAGE_BYTES) break;
      text += character;
      bytes += size;
      if (character === '\n') lines++;
      pending = pending.slice(character.length);
      fill();
    }
    const page = { text, hasMore: !done };
    pages.push(page);
    return page;
  };
}
