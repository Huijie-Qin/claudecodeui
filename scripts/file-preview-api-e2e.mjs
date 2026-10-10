#!/usr/bin/env node
// Run against the isolated full CCUI server started by file-preview-e2e-server.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(process.argv[2] || path.join(root, 'artifacts/file-preview-e2e/manifest.json'), 'utf8'));
assert.match(manifest.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const { primary, private: privateWorkspace, secondary } = manifest.workspaces;
const results = [];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const request = (url, options = {}) => fetch(`${manifest.origin}${url}`, { ...options, signal: AbortSignal.timeout(15_000) });
const authenticate = async (user) => {
  const response = await request('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  assert.equal(response.status, 200, `login ${user.username}`);
  return (await response.json()).token;
};
const [memberToken, viewerToken, outsiderToken] = await Promise.all([
  authenticate(manifest.users.member), authenticate(manifest.users.viewer), authenticate(manifest.users.outsider),
]);
const headers = (token) => ({ Authorization: `Bearer ${token}` });
const contentUrl = (fileName, workspace = primary, override = {}) => {
  const query = new URLSearchParams({ tenantId: String(workspace.tenantId), workspaceId: String(workspace.id), path: path.join(workspace.path, fileName), ...override });
  return `/api/projects/${encodeURIComponent(workspace.slug)}/files/content?${query}`;
};
async function check(name, run) {
  try {
    const evidence = await run();
    results.push({ name, passed: true, ...evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

await check('Real login and workspace file listing', async () => {
  const query = new URLSearchParams({ tenantId: String(primary.tenantId), workspaceId: String(primary.id) });
  const response = await request(`/api/projects/${encodeURIComponent(primary.slug)}/files?${query}`, { headers: headers(memberToken) });
  assert.equal(response.status, 200);
  const files = await response.json();
  assert.ok(Array.isArray(files) && files.length > 0);
  return { count: files.length, status: response.status };
});

const unicodeWorkbook = manifest.files.find((file) => /[^\x00-\x7f]/.test(file.name) && file.name.endsWith('.xlsx'))?.name;
assert.ok(unicodeWorkbook, 'Unicode workbook fixture is required');
for (const fileName of ['sample.png', 'sample.xlsx', unicodeWorkbook]) {
  await check(`Binary response is byte-identical: ${fileName}`, async () => {
    const response = await request(contentUrl(fileName), { headers: headers(memberToken) });
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const source = await readFile(path.join(primary.path, fileName));
    assert.equal(sha256(bytes), sha256(source));
    assert.equal(response.headers.get('content-type'), fileName.endsWith('.png') ? 'image/png' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return { bytes: bytes.length, sha256: sha256(bytes), status: response.status };
  });
}

await check('Viewer can preview and download a shared workbook', async () => {
  const response = await request(contentUrl('sample.xlsx'), { headers: headers(viewerToken) });
  assert.equal(response.status, 200);
  assert.equal(sha256(new Uint8Array(await response.arrayBuffer())), sha256(await readFile(path.join(primary.path, 'sample.xlsx'))));
  return { status: response.status };
});

const denied = [
  ['Anonymous request denied', contentUrl('sample.xlsx'), undefined, [401]],
  ['Missing workspace denied', contentUrl('sample.xlsx', primary, { workspaceId: '' }), memberToken, [400]],
  ['Other tenant user denied', contentUrl('sample.xlsx'), outsiderToken, [403, 404]],
  ['Cross-tenant workspace denied', contentUrl('sample.xlsx', secondary), memberToken, [403, 404]],
  ['Same-tenant private workspace denied', contentUrl('sample.xlsx', privateWorkspace), memberToken, [403, 404]],
  ['Directory traversal denied', contentUrl('sample.xlsx', primary, { path: `${primary.path}/../outside.txt` }), memberToken, [400, 403]],
  ['Symlink outside workspace denied', contentUrl('escape.xlsx'), memberToken, [400, 403]],
  ['Missing file returns 404', contentUrl('missing.xlsx'), memberToken, [404]],
];
for (const [name, url, token, expected] of denied) {
  await check(name, async () => {
    const response = await request(url, { headers: token ? headers(token) : {} });
    assert.ok(expected.includes(response.status), `expected ${expected.join('/')} but got ${response.status}`);
    await response.arrayBuffer();
    return { status: response.status };
  });
}

await check('Viewer cannot overwrite a previewed workbook', async () => {
  const sourcePath = path.join(primary.path, 'sample.xlsx');
  const before = sha256(await readFile(sourcePath));
  const response = await request(`/api/projects/${encodeURIComponent(primary.slug)}/file?tenantId=${primary.tenantId}&workspaceId=${primary.id}`, {
    method: 'PUT', headers: { ...headers(viewerToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath: sourcePath, content: 'must not be written' }),
  });
  assert.equal(response.status, 403);
  assert.equal(sha256(await readFile(sourcePath)), before);
  return { status: response.status, fileUnchanged: true };
});

const report = { finishedAt: new Date().toISOString(), origin: manifest.origin, passed: results.filter((result) => result.passed).length, total: results.length, results };
await writeFile(path.join(root, 'artifacts/file-preview-e2e/api-results.json'), `${JSON.stringify(report, null, 2)}\n`);
if (report.passed !== report.total) process.exitCode = 1;
