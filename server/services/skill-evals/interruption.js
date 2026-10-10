import { fail } from './contracts.js';

export function timeoutSetting(env, name, fallback) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 3600000) {
    throw fail(`${name} 必须是 1–3600000 之间的整数（毫秒）。`, 'EVAL_RUNTIME_CONFIGURATION', 503);
  }
  return value;
}

export function timeoutError(milliseconds, execution) {
  const duration = milliseconds % 60000 === 0 ? `${milliseconds / 60000} 分钟` : `${milliseconds / 1000} 秒`;
  const setting = execution ? 'SKILL_EVAL_CASE_TIMEOUT_MS' : 'SKILL_EVAL_MODEL_TIMEOUT_MS';
  return fail(`${execution ? '测试用例运行' : '模型请求'}超过 ${duration}，已停止。可通过 ${setting} 调整超时时间。`, 'EVAL_TIMEOUT');
}

export function interruptionError(signal, fallback) {
  if (!signal?.aborted) return fallback;
  const reason = signal.reason;
  if (reason instanceof Error && reason.name !== 'AbortError') return reason;
  return fail('任务执行已中止。', 'EVAL_ABORTED');
}
