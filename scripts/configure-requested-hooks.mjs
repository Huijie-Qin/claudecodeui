import crypto from 'node:crypto';

const baseUrl = String(process.env.CCUI_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const username = String(process.env.CCUI_ADMIN_USERNAME || 'root');
const gitEmail = String(process.env.CCUI_ADMIN_EMAIL || 'admin@ccui.local');
let password = String(process.env.CCUI_ADMIN_PASSWORD || '');

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${payload.error || payload.message || 'unknown error'}`);
  }
  return payload;
}

if (process.argv.includes('--direct-database')) {
  const [
    { db },
    { hookConfigService },
    { createRequestedHookExamples },
  ] = await Promise.all([
    import('../dist-server/server/database/db.js'),
    import('../dist-server/server/services/hook-configs.js'),
    import('../dist-server/server/services/hook-examples.js'),
  ]);
  const admin = db.prepare('SELECT id, username, is_system_admin FROM users WHERE username = ?').get(username);
  if (!admin?.is_system_admin) throw new Error(`${username} is not a CCUI system administrator`);
  const result = createRequestedHookExamples({ hookConfigs: hookConfigService, userId: admin.id });
  console.log(JSON.stringify({ admin: { username }, ...result }, null, 2));
  process.exit(0);
}

const authStatus = await request('/api/auth/status');
let auth;
let generatedPassword = false;
if (authStatus.needsSetup) {
  if (!password) {
    password = `CCUI-${crypto.randomBytes(18).toString('base64url')}!`;
    generatedPassword = true;
  }
  auth = await request('/api/auth/register', {
    method: 'POST',
    body: { username, password, gitEmail },
  });
} else {
  if (!password) throw new Error('CCUI already has users; set CCUI_ADMIN_PASSWORD to create Hook examples through Admin APIs');
  auth = await request('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
}

if (!auth.user?.is_system_admin) throw new Error(`${username} is not a CCUI system administrator`);
const result = await request('/api/admin/hooks/examples', {
  method: 'POST',
  token: auth.token,
});

console.log(JSON.stringify({
  admin: {
    username,
    ...(generatedPassword ? { generatedPassword: password } : {}),
  },
  ...result,
}, null, 2));
