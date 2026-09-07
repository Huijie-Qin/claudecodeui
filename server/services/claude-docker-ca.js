import { createHash, X509Certificate } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

export const DOCKER_CA_FILE_ENV = 'CLOUDCLI_DOCKER_CA_CERTS_FILE';

function parseCertificates(contents, source) {
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(contents)) {
    throw new Error(`Docker CA source ${source} must contain certificates only, not private keys`);
  }
  const blocks = contents.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  // Catch a partially truncated bundle instead of silently losing a root.
  if (!blocks.length || blocks.length !== (contents.match(/-----BEGIN CERTIFICATE-----/g) || []).length) {
    throw new Error(`Docker CA source ${source} is not a valid PEM certificate bundle`);
  }
  try {
    return blocks.map((block) => new X509Certificate(block).toString().trim());
  } catch {
    throw new Error(`Docker CA source ${source} contains an invalid certificate`);
  }
}

/** Export only public trust certificates through the existing runtime-home mount.
 * Host file paths come exclusively from backend configuration, never user env.
 * Content-addressed filenames let existing processes keep their original bundle.
 */
export async function prepareClaudeDockerCa({
  runtimeHomePath,
  env = process.env,
  containerEnv = {},
  fsImpl = fs,
  tlsApi = tls,
} = {}) {
  // A tenant/user may already specify an intentional container-local CA path.
  // Do not interpret it as a backend filesystem path or overwrite it.
  if (containerEnv.NODE_EXTRA_CA_CERTS?.trim()) {
    return { mode: 'container_override', certificateCount: null, env: {} };
  }

  const certificates = [];
  let systemStore = 'unsupported';
  if (typeof tlsApi.getCACertificates === 'function') {
    let system = [];
    try {
      system = tlsApi.getCACertificates('system');
      systemStore = system.length ? 'loaded' : 'empty';
    } catch {
      systemStore = 'unavailable';
    }
    for (const pem of system) certificates.push(...parseCertificates(pem, 'system store'));
  }
  const filePaths = [...new Set([env[DOCKER_CA_FILE_ENV], env.NODE_EXTRA_CA_CERTS]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim()))];
  for (const filePath of filePaths) {
    if (!path.isAbsolute(filePath)) {
      throw new Error('Docker CA source file must use an absolute backend path');
    }
    let contents;
    try {
      contents = await fsImpl.readFile(filePath, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read Docker CA source file (${error.code || 'read_failed'}): ${filePath}`);
    }
    certificates.push(...parseCertificates(contents, filePath));
  }

  const uniqueCertificates = [...new Set(certificates)].sort();
  if (!uniqueCertificates.length) {
    return { mode: 'image_defaults', systemStore, certificateCount: 0, env: {} };
  }
  const contents = `${uniqueCertificates.join('\n')}\n`;
  const digest = createHash('sha256').update(contents).digest('hex');
  const fileName = `.cloudcli-ca-${digest}.pem`;
  const hostPath = path.join(runtimeHomePath, fileName);
  let handle;
  try {
    handle = await fsImpl.open(hostPath, 'wx', 0o444);
    await handle.writeFile(contents, 'utf8');
    // Public CA certificates must be readable by the container UID, even when
    // the PM2 user's umask is restrictive. No chown privilege is required.
    await handle.chmod(0o444);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Do not follow a runtime-user symlink or block on a replaced FIFO.
    handle = await fsImpl.open(hostPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile() || await handle.readFile('utf8') !== contents) {
      throw new Error('Existing Docker CA bundle is not a matching regular file');
    }
  } finally {
    await handle?.close();
  }
  const containerPath = `/home/cloudcli/${fileName}`;
  return {
    mode: 'host_bundle', systemStore, certificateCount: uniqueCertificates.length,
    fileSourceCount: filePaths.length, containerPath,
    env: { NODE_EXTRA_CA_CERTS: containerPath },
  };
}
