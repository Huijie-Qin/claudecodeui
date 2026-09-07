import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { promisify } from 'node:util';

import { prepareClaudeDockerCa, DOCKER_CA_FILE_ENV } from './claude-docker-ca.js';

const run = promisify(execFile);
const [rootA, rootB] = tls.rootCertificates;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-ca-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtimeHomePath = path.join(directory, 'home');
  await fs.mkdir(runtimeHomePath);
  return { directory, runtimeHomePath };
}

test('exports deduplicated host system and extra roots into the existing home mount', async (t) => {
  const { directory, runtimeHomePath } = await fixture(t);
  const source = path.join(directory, 'company.pem');
  await fs.writeFile(source, `${rootA}\n${rootB}`);
  const options = {
    runtimeHomePath,
    env: { [DOCKER_CA_FILE_ENV]: source, NODE_EXTRA_CA_CERTS: source },
    tlsApi: { getCACertificates: () => [rootA] },
  };
  const first = await prepareClaudeDockerCa(options);
  assert.equal(first.mode, 'host_bundle');
  assert.equal(first.certificateCount, 2);
  assert.equal(first.fileSourceCount, 1);
  assert.match(first.env.NODE_EXTRA_CA_CERTS, /^\/home\/cloudcli\/\.cloudcli-ca-[a-f0-9]+\.pem$/);
  const bundlePath = path.join(runtimeHomePath, path.basename(first.containerPath));
  assert.equal((await fs.stat(bundlePath)).mode & 0o777, 0o444);
  assert.equal((await fs.readFile(bundlePath, 'utf8')).match(/BEGIN CERTIFICATE/g).length, 2);
  assert.deepEqual(await prepareClaudeDockerCa(options), first);
  await fs.writeFile(source, rootA);
  const rotated = await prepareClaudeDockerCa(options);
  assert.notEqual(rotated.containerPath, first.containerPath);
  assert.equal(rotated.certificateCount, 1);
  assert.equal((await fs.readFile(bundlePath, 'utf8')).match(/BEGIN CERTIFICATE/g).length, 2);
});

test('older Node can use explicit CA files and an empty store preserves image defaults', async (t) => {
  const { directory, runtimeHomePath } = await fixture(t);
  const options = { runtimeHomePath, env: {}, tlsApi: {} };
  assert.equal((await prepareClaudeDockerCa(options)).mode, 'image_defaults');
  const source = path.join(directory, 'extra.pem');
  await fs.writeFile(source, rootA);
  assert.equal((await prepareClaudeDockerCa({
    ...options, env: { NODE_EXTRA_CA_CERTS: source },
  })).certificateCount, 1);
});

test('retains an explicit container-local override without reading it on the host', async () => {
  const result = await prepareClaudeDockerCa({
    env: { [DOCKER_CA_FILE_ENV]: '/host/private/path' },
    containerEnv: { NODE_EXTRA_CA_CERTS: '/container/custom-ca.pem' },
    fsImpl: { readFile: () => { throw new Error('must not read host files'); } },
  });
  assert.equal(result.mode, 'container_override');
  assert.deepEqual(result.env, {});
});

test('configured missing, malformed and private-key bundles fail before launching Claude', async (t) => {
  const { directory, runtimeHomePath } = await fixture(t);
  const source = path.join(directory, 'bad.pem');
  const options = { runtimeHomePath, env: { [DOCKER_CA_FILE_ENV]: source }, tlsApi: {} };
  await assert.rejects(prepareClaudeDockerCa(options), /Cannot read Docker CA source file/);
  for (const contents of ['not a cert', `${rootA}\n-----BEGIN CERTIFICATE-----`,
    '-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----',
    `${rootA}\n-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----`]) {
    await fs.writeFile(source, contents);
    await assert.rejects(prepareClaudeDockerCa(options), (error) => {
      assert.doesNotMatch(error.message, /SECRET/);
      return /Docker CA source/.test(error.message);
    });
  }
  assert.deepEqual(await fs.readdir(runtimeHomePath), []);
});

test('refuses a symlink substituted for a generated CA bundle', async (t) => {
  const { directory, runtimeHomePath } = await fixture(t);
  const options = { runtimeHomePath, env: {}, tlsApi: { getCACertificates: () => [rootA] } };
  const result = await prepareClaudeDockerCa(options);
  const output = path.join(runtimeHomePath, path.basename(result.containerPath));
  const target = path.join(directory, 'target');
  await fs.writeFile(target, 'untouched');
  await fs.unlink(output);
  await fs.symlink(target, output);
  await assert.rejects(prepareClaudeDockerCa(options));
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
});

test('a fresh Node process trusts a private HTTPS endpoint only with the exported CA', async (t) => {
  const { directory, runtimeHomePath } = await fixture(t);
  const cert = path.join(directory, 'cert.pem');
  const key = path.join(directory, 'key.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { timeout: 15000 });
  const server = https.createServer({
    cert: await fs.readFile(cert), key: await fs.readFile(key),
  }, (_req, res) => res.end('trusted'));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const ca = await prepareClaudeDockerCa({
    runtimeHomePath, env: { [DOCKER_CA_FILE_ENV]: cert }, tlsApi: {},
  });
  const script = `require('https').get(process.argv[1], r => {
    r.resume(); r.on('end', () => console.log('trusted'));
  }).on('error', e => { console.error(e.code); process.exitCode = 1; });`;
  const url = `https://127.0.0.1:${server.address().port}`;
  const cleanEnv = { PATH: process.env.PATH };
  await assert.rejects(run(process.execPath, ['-e', script, url], { env: cleanEnv, timeout: 5000 }),
    (error) => /SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.stderr));
  // The host equivalent of the mounted path is used in this Docker-free TLS test.
  const { stdout } = await run(process.execPath, ['-e', script, url], {
    env: { ...cleanEnv, NODE_EXTRA_CA_CERTS: path.join(runtimeHomePath, path.basename(ca.containerPath)) },
    timeout: 5000,
  });
  assert.match(stdout, /trusted/);
});
