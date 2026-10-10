import { createHash } from 'node:crypto';

import { MAX_SKILL_EVAL_CASES } from '../../../shared/skillEvaluationConstants.js';

export const MAX_CASES = MAX_SKILL_EVAL_CASES;
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
export function validateEvals(value, name, { maxCases = MAX_CASES } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((k) => !['skill_name', 'evals'].includes(k))
    || value.skill_name !== name || !Array.isArray(value.evals)) {
    throw fail(`Expected { skill_name: "${name}", evals: [...] } (maximum ${MAX_CASES} cases)`);
  }
  if (value.evals.length > maxCases) throw fail(`每个技能最多支持 ${MAX_CASES} 条测试用例，请先删除多余用例。`, 'EVAL_CASE_LIMIT');
  const ids = new Set();
  for (const [index, item] of value.evals.entries()) {
    const label = `evals/evals.json 中第 ${index + 1} 条测试用例`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail(`${label}必须是 JSON 对象。`);
    if (!Number.isSafeInteger(item.id) || item.id <= 0) throw fail(`${label}的 id 必须是正整数（例如 1、2、3），不能留空或使用字符串。`);
    if (ids.has(item.id)) throw fail(`${label}的 id=${item.id} 与前面的用例重复，每条用例必须使用不同的编号。`);
    const unsupported = Object.keys(item).filter((k) => !['id', 'prompt', 'expected_output', 'files', 'expectations'].includes(k));
    if (unsupported.length) throw fail(`${label}包含暂不支持的字段：${unsupported.map(k => JSON.stringify(k)).join('、')}。支持的字段为 id、prompt、expected_output、files、expectations；请先核对字段含义，不要直接删除测试要求。`);
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
export function parseEvals(content, name, options) {
  let value;
  try { value = JSON.parse(content); } catch { throw fail('evals/evals.json is not valid JSON'); }
  return validateEvals(value, name, options);
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
