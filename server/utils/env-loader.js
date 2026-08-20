import path from 'node:path';

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

export function resolveEnvFilePaths({ appRoot, userHome, desktopMode = false } = {}) {
  if (typeof appRoot !== 'string' || appRoot.trim() === '') {
    throw new TypeError('appRoot is required to resolve environment files');
  }

  const paths = [path.join(appRoot, '.env')];
  if (desktopMode) {
    if (typeof userHome !== 'string' || userHome.trim() === '') {
      throw new TypeError('userHome is required in desktop mode');
    }
    const userEnvPath = path.join(userHome, '.cloudcli', '.env');
    if (!paths.includes(userEnvPath)) {
      paths.push(userEnvPath);
    }
  }
  return paths;
}
