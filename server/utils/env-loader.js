export function applyEnvFileContents(contents, targetEnv = process.env, options = {}) {
  const { override = true } = options;

  contents.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      return;
    }

    const [rawKey, ...valueParts] = trimmedLine.split('=');
    const key = rawKey?.trim();
    if (!key || valueParts.length === 0) {
      return;
    }

    if (!override && targetEnv[key]) {
      return;
    }

    targetEnv[key] = valueParts.join('=').trim();
  });
}
