function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

export function normalizeHookUserVariables(value = []) {
  if (!Array.isArray(value) || value.length > 20) invalid('用户个人变量最多可配置 20 项');
  const names = new Set();
  return value.map((variable) => {
    if (!variable || typeof variable !== 'object' || Array.isArray(variable)) invalid('用户个人变量格式无效');
    const name = typeof variable.name === 'string' ? variable.name.trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)
      || ['__proto__', 'prototype', 'constructor'].includes(name)) {
      invalid('变量名须以字母或下划线开头，仅包含字母、数字和下划线，最多 64 个字符');
    }
    if (names.has(name)) invalid(`用户个人变量名重复：${name}`);
    names.add(name);
    const label = variable.label == null ? name : variable.label;
    const description = variable.description ?? '';
    if (typeof label !== 'string' || !label.trim() || label.length > 100) invalid(`变量 ${name} 的显示名称须为 1–100 个字符`);
    if (typeof description !== 'string' || description.length > 1000) invalid(`变量 ${name} 的填写说明最多 1000 个字符`);
    for (const flag of ['required', 'secret']) {
      if (variable[flag] != null && typeof variable[flag] !== 'boolean') invalid(`变量 ${name} 的 ${flag} 必须为布尔值`);
    }
    return { name, label: label.trim(), description: description.trim(), required: variable.required !== false, secret: variable.secret === true };
  });
}

export function mergeHookUserVariableValues(definitions, stored, input, { requireComplete = false } = {}) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) invalid('用户个人变量值必须为对象');
  const names = new Set(definitions.map((variable) => variable.name));
  const values = Object.fromEntries(Object.entries(stored || {}).filter(([name]) => names.has(name)));
  for (const [name, value] of Object.entries(input || {})) {
    if (!names.has(name)) invalid(`未配置的用户个人变量：${name}`);
    if (typeof value !== 'string' || value.length > 8192) invalid(`变量 ${name} 的值须为字符串，最多 8192 个字符`);
    if (value.includes('\0')) invalid(`变量 ${name} 的值不能包含 NUL 字符`);
    if (value.trim()) values[name] = value;
    else delete values[name];
  }
  if (requireComplete) {
    const missing = definitions.filter((variable) => variable.required && !values[variable.name]?.trim());
    if (missing.length) invalid(`请填写必填的个人变量：${missing.map((variable) => variable.label).join('、')}`);
  }
  return values;
}

// Replace sensitive values even when a script puts them in an innocuous field,
// free-form message, or Skill argument rather than a key named "token".
export function createHookVariableRedactor(definitions, values) {
  const secrets = [...new Set(definitions.filter((variable) => variable.secret)
    .flatMap((variable) => {
      const value = values[variable.name];
      return value ? [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)] : [];
    }))].sort((left, right) => right.length - left.length);
  const redact = (value, depth = 0) => {
    if (depth > 20) return '[depth limit]';
    if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
    if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [redact(key, depth + 1), redact(entry, depth + 1)]));
    return value;
  };
  return redact;
}
