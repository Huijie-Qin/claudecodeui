import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createDesktopUpdatesRouter } from './desktop-updates.js';

async function createFixture(t) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-desktop-updates-'));
  const updateRoot = path.join(fixtureRoot, 'updates');
  const macRoot = path.join(updateRoot, 'latest', 'mac', 'universal');
  const winRoot = path.join(updateRoot, 'latest', 'win', 'x64');
  await Promise.all([
    fs.mkdir(macRoot, { recursive: true }),
    fs.mkdir(winRoot, { recursive: true }),
  ]);

  await Promise.all([
    fs.writeFile(path.join(macRoot, 'latest-mac.yml'), 'version: 1.2.3\npath: CloudCLI-1.2.3-universal.zip\n'),
    fs.writeFile(path.join(macRoot, 'CloudCLI-1.2.3-universal.zip'), '0123456789'),
    fs.writeFile(path.join(macRoot, 'CloudCLI-1.2.3-universal.dmg'), 'mac-installer'),
    fs.writeFile(path.join(macRoot, 'CloudCLI-1.2.3-universal.zip.blockmap'), 'mac-blockmap'),
    fs.writeFile(path.join(winRoot, 'latest.yml'), 'version: 1.2.3\npath: CloudCLI-Setup-1.2.3.exe\n'),
    fs.writeFile(path.join(winRoot, 'CloudCLI-Setup-1.2.3.exe'), 'windows-installer'),
    fs.writeFile(path.join(winRoot, 'CloudCLI-Setup-1.2.3.exe.blockmap'), 'windows-blockmap'),
  ]);

  t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  return { fixtureRoot, updateRoot, macRoot };
}

async function withServer(updateRoot, run, { accelRedirectPrefix = null } = {}) {
  const app = express();
  app.use('/api/desktop-updates', createDesktopUpdatesRouter({
    updateRoot,
    accelRedirectPrefix,
  }));
  app.use('/api', (_req, res) => res.status(401).json({ error: 'API key required' }));
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('serves public updater metadata without caching for GET and HEAD', async (t) => {
  const { updateRoot } = await createFixture(t);

  await withServer(updateRoot, async (baseUrl) => {
    const url = `${baseUrl}/api/desktop-updates/latest/mac/universal/latest-mac.yml`;
    const response = await fetch(url);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await response.text(), /version: 1\.2\.3/);

    const headResponse = await fetch(url, { method: 'HEAD' });
    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get('cache-control'), 'no-store');
    assert.equal(await headResponse.text(), '');
  });
});

test('serves versioned artifacts with immutable caching and byte ranges', async (t) => {
  const { updateRoot } = await createFixture(t);

  await withServer(updateRoot, async (baseUrl) => {
    const url = `${baseUrl}/api/desktop-updates/latest/mac/universal/CloudCLI-1.2.3-universal.zip`;
    const response = await fetch(url, { headers: { Range: 'bytes=2-5' } });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await response.text(), '2345');

    const headResponse = await fetch(url, { method: 'HEAD' });
    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get('content-length'), '10');
    assert.equal(await headResponse.text(), '');

    for (const artifactPath of [
      '/api/desktop-updates/latest/mac/universal/CloudCLI-1.2.3-universal.dmg',
      '/api/desktop-updates/latest/mac/universal/CloudCLI-1.2.3-universal.zip.blockmap',
      '/api/desktop-updates/latest/win/x64/CloudCLI-Setup-1.2.3.exe',
      '/api/desktop-updates/latest/win/x64/CloudCLI-Setup-1.2.3.exe.blockmap',
    ]) {
      const artifactResponse = await fetch(`${baseUrl}${artifactPath}`);
      assert.equal(artifactResponse.status, 200, artifactPath);
      assert.equal(artifactResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    }
  });
});

test('offloads validated artifacts through a safe Nginx internal redirect prefix', async (t) => {
  const { updateRoot } = await createFixture(t);
  const winRoot = path.join(updateRoot, 'latest', 'win', 'x64');
  await fs.writeFile(path.join(winRoot, 'CloudCLI Setup 1.2.3.exe'), 'spaced installer');

  await withServer(updateRoot, async (baseUrl) => {
    const artifactUrl = `${baseUrl}/api/desktop-updates/latest/win/x64/CloudCLI%20Setup%201.2.3.exe`;
    const response = await fetch(artifactUrl, { headers: { Range: 'bytes=0-3' } });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(
      response.headers.get('x-accel-redirect'),
      '/_internal/cloudcli-updates/latest/win/x64/CloudCLI%20Setup%201.2.3.exe',
    );
    assert.equal(await response.text(), '');

    const headResponse = await fetch(artifactUrl, { method: 'HEAD' });
    assert.equal(headResponse.status, 200);
    assert.equal(
      headResponse.headers.get('x-accel-redirect'),
      '/_internal/cloudcli-updates/latest/win/x64/CloudCLI%20Setup%201.2.3.exe',
    );

    const metadataResponse = await fetch(
      `${baseUrl}/api/desktop-updates/latest/win/x64/latest.yml`,
    );
    assert.equal(metadataResponse.status, 200);
    assert.equal(metadataResponse.headers.get('x-accel-redirect'), null);
    assert.equal(metadataResponse.headers.get('cache-control'), 'no-store');
    assert.match(await metadataResponse.text(), /version: 1\.2\.3/);
  }, { accelRedirectPrefix: '/_internal/cloudcli-updates/' });
});

test('fails closed for unsafe X-Accel-Redirect prefixes', async (t) => {
  const { updateRoot } = await createFixture(t);
  const artifactPath = '/api/desktop-updates/latest/mac/universal/CloudCLI-1.2.3-universal.zip';
  const unsafePrefixes = [
    '/',
    '//internal/updates',
    'https://example.com/internal',
    '/internal/../updates',
    '/internal%2Fupdates',
    '/internal/updates?download=1',
    '/internal\\updates',
  ];

  for (const accelRedirectPrefix of unsafePrefixes) {
    await withServer(updateRoot, async (baseUrl) => {
      const response = await fetch(`${baseUrl}${artifactPath}`);
      assert.equal(response.status, 503, accelRedirectPrefix);
      assert.equal(response.headers.get('x-accel-redirect'), null);
    }, { accelRedirectPrefix });
  }
});

test('only exposes the stable target combinations and expected updater filenames', async (t) => {
  const { updateRoot, macRoot } = await createFixture(t);
  await Promise.all([
    fs.writeFile(path.join(macRoot, 'latest.yml'), 'not mac metadata'),
    fs.writeFile(path.join(macRoot, 'CloudCLI.zip'), 'unversioned'),
    fs.writeFile(path.join(macRoot, 'CloudCLI-1.2.3.exe'), 'wrong platform'),
  ]);

  await withServer(updateRoot, async (baseUrl) => {
    const invalidPaths = [
      '/api/desktop-updates/beta/mac/universal/latest-mac.yml',
      '/api/desktop-updates/latest/mac/x64/latest-mac.yml',
      '/api/desktop-updates/latest/win/universal/latest.yml',
      '/api/desktop-updates/latest/mac/universal/latest.yml',
      '/api/desktop-updates/latest/mac/universal/CloudCLI.zip',
      '/api/desktop-updates/latest/mac/universal/CloudCLI-1.2.3.exe',
      '/api/desktop-updates/latest/mac/universal/package.json',
    ];

    for (const requestPath of invalidPaths) {
      const response = await fetch(`${baseUrl}${requestPath}`);
      assert.equal(response.status, 404, requestPath);
    }

    const postResponse = await fetch(
      `${baseUrl}/api/desktop-updates/latest/mac/universal/latest-mac.yml`,
      { method: 'POST' },
    );
    assert.equal(postResponse.status, 401);
  });
});

test('rejects encoded traversal and symlinks that escape the update root', async (t) => {
  const { fixtureRoot, updateRoot, macRoot } = await createFixture(t);
  const outsideArtifact = path.join(fixtureRoot, 'Outside-9.9.9.zip');
  await fs.writeFile(outsideArtifact, 'secret');
  await fs.symlink(outsideArtifact, path.join(macRoot, 'CloudCLI-9.9.9.zip'));

  await withServer(updateRoot, async (baseUrl) => {
    const traversalResponse = await fetch(
      `${baseUrl}/api/desktop-updates/latest/mac/universal/%2e%2e%2fOutside-9.9.9.zip`,
    );
    assert.notEqual(traversalResponse.status, 200);

    const symlinkResponse = await fetch(
      `${baseUrl}/api/desktop-updates/latest/mac/universal/CloudCLI-9.9.9.zip`,
    );
    assert.equal(symlinkResponse.status, 404);
    assert.equal(symlinkResponse.headers.get('x-accel-redirect'), null);
  }, { accelRedirectPrefix: '/_internal/cloudcli-updates' });
});

test('returns service unavailable when DESKTOP_UPDATE_ROOT is absent or unusable', async (t) => {
  const missingRoot = path.join(os.tmpdir(), `cloudcli-missing-updates-${Date.now()}`);
  const rootFile = path.join(os.tmpdir(), `cloudcli-update-root-file-${Date.now()}`);
  await fs.writeFile(rootFile, 'not a directory');

  await withServer(null, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/desktop-updates/latest/mac/universal/latest-mac.yml`,
    );
    assert.equal(response.status, 503);
  });

  await withServer(missingRoot, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/desktop-updates/latest/mac/universal/latest-mac.yml`,
    );
    assert.equal(response.status, 503);
  });

  await withServer(rootFile, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/desktop-updates/latest/mac/universal/latest-mac.yml`,
    );
    assert.equal(response.status, 503);
  });

  t.after(() => Promise.all([
    fs.rm(missingRoot, { recursive: true, force: true }),
    fs.rm(rootFile, { force: true }),
  ]));
});
