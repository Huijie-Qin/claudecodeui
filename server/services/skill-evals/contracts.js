import { createHash } from 'node:crypto';

export const MAX_CASES = 50;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const ACTIVE = new Set(['queued', 'running', 'cancelling']);
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function fail(message, code = 'EVAL_SCHEMA_INVALID', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}
export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || /[\x00-\x1f:]/.test(value) || value.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw fail('Invalid relative file path');
  }
  return value;
}
export function inputFileName(value) {
  const name = String(value || 'input').normalize('NFC').split(/[\\/]/).pop()
    .replace(/[\x00-\x1f\x7f:*?"<>|]/g, '_').trim().replace(/^\.+/, '').trim() || 'input';
  const suffix = name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] || '';
  const stem = Array.from(suffix ? name.slice(0, -suffix.length) : name).slice(0, 180);
  while (Buffer.byteLength(stem.join('') + suffix) > 180) stem.pop();
  return (stem.join('') || 'input') + suffix;
}
export function validateEvals(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((k) => !['skill_name', 'evals'].includes(k))
    || value.skill_name !== name || !Array.isArray(value.evals) || value.evals.length > MAX_CASES) {
    throw fail(`Expected { skill_name: "${name}", evals: [...] } (maximum ${MAX_CASES} cases)`);
  }
  const ids = new Set();
  for (const item of value.evals) {
    if (!item || Object.keys(item).some((k) => !['id', 'prompt', 'expected_output', 'files', 'expectations'].includes(k))
      || !Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id)) throw fail('Case IDs must be unique positive integers; unknown fields are not supported');
    ids.add(item.id);
    for (const field of ['prompt', 'expected_output']) {
      if (typeof item[field] !== 'string' || !item[field].trim() || item[field].length > 50000) throw fail(`${field} must contain 1–50000 characters`);
    }
    if (item.files !== undefined) {
      if (!Array.isArray(item.files) || item.files.length > 20) throw fail('files must be an array (maximum 20)');
      item.files.forEach(relativePath);
      if (item.files.some((p) => !p.startsWith('evals/files/'))) throw fail('Test inputs must be stored under evals/files/');
    }
    if (item.expectations !== undefined && (!Array.isArray(item.expectations) || item.expectations.length > 30
      || item.expectations.some((s) => typeof s !== 'string' || !s.trim() || s.length > 5000))) throw fail('Invalid expectations');
  }
  return value;
}
export function parseEvals(content, name) {
  let value;
  try { value = JSON.parse(content); } catch { throw fail('evals/evals.json is not valid JSON'); }
  return validateEvals(value, name);
}
export function validateStart(input) {
  if (!input || !['run-all', 'optimize'].includes(input.mode)) throw fail('mode must be run-all or optimize');
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId)) throw fail('A unique requestId is required');
  if (typeof input.expectedContentHash !== 'string' || typeof input.expectedEvalsRevision !== 'string') throw fail('Content and case revisions are required');
  const maxIterations = input.mode === 'optimize' ? (input.maxIterations === undefined ? 3 : input.maxIterations) : 0;
  if (input.mode === 'optimize' && (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10)) throw fail('maxIterations must be an integer from 1 to 10');
  if (input.mode === 'run-all' && input.maxIterations !== undefined) throw fail('run-all does not accept maxIterations');
  return { mode: input.mode, requestId: input.requestId, expectedContentHash: input.expectedContentHash, expectedEvalsRevision: input.expectedEvalsRevision, maxIterations };
}
export function outcome(cases) {
  const states = cases.map((c) => c.status);
  if (!states.length) return 'not_evaluated';
  if (states.includes('error')) return 'error';
  if (states.includes('failed')) return 'failed';
  if (states.includes('inconclusive')) return 'inconclusive';
  return states.every((s) => s === 'passed') ? 'passed' : 'not_evaluated';
}
export function redact(text) {
  return String(text).replace(/((?:api[_-]?key|auth[_-]?token|password|secret|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s"'`]+/gi, '$1[REDACTED]');
}
