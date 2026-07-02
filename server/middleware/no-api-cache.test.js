import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { noApiCache } from './no-api-cache.js';

async function request(app, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
        const text = await response.text();
        server.close(() => resolve({ response, text }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

test('noApiCache disables dynamic API caching and prevents stale 304 responses', async () => {
  const app = express();

  app.use(noApiCache);
  app.get('/status', (req, res) => {
    assert.equal(req.headers['if-none-match'], undefined);
    assert.equal(req.headers['if-modified-since'], undefined);
    res.setHeader('ETag', '"fixed-status-etag"');
    res.json({ status: 'changed' });
  });

  const { response, text } = await request(app, '/status', {
    headers: {
      'If-None-Match': '"fixed-status-etag"',
      'If-Modified-Since': 'Wed, 01 Jul 2026 00:00:00 GMT',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('expires'), '0');
  assert.equal(response.headers.get('surrogate-control'), 'no-store');
  assert.deepEqual(JSON.parse(text), { status: 'changed' });
});
