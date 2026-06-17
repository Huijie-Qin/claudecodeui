import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import { checkOpenApiAgentList } from './openapi-agent.js';

test('checkOpenApiAgentList calls the OpenAPI agent list endpoint', async () => {
  const seen = {};
  const fixedTimestamp = 1710000000000;
  const authKey = '00112233445566778899aabbccddeeff';
  const expectedBody = {
    data: {
      mine: false,
      searchContent: '',
    },
    pageInfo: {
      orderId: 'modify_timestamp',
      orderType: 'desc',
      page: 1,
      pageSize: 24,
    },
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.method = req.method;
    seen.path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    seen.tenant = req.headers['x-data-agent-tenant'];
    seen.accountId = req.headers['x-account-id'];
    seen.authorization = req.headers.authorization;
    seen.body = body;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, message: 'success', data: { records: [] } }));
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const previousProdDaBaseUrl = process.env.PROD_DA_BASE_URL;
  const previousProdDaAppid = process.env.PROD_DA_APPID;
  const previousProdDaKey = process.env.PROD_DA_KEY;
  const previousOpenApiBaseUrl = process.env.OPENAPI_BASE_URL;
  const previousSkillMarketBaseUrl = process.env.SKILL_MARKET_BASE_URL;
  const previousDateNow = Date.now;
  try {
    process.env.PROD_DA_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.PROD_DA_APPID = 'agent-app';
    process.env.PROD_DA_KEY = authKey;
    process.env.OPENAPI_BASE_URL = 'http://127.0.0.1:1';
    process.env.SKILL_MARKET_BASE_URL = 'http://127.0.0.1:1';
    Date.now = () => fixedTimestamp;

    assert.deepEqual(
      await checkOpenApiAgentList({ tenantCode: 'prod-code-001', accountId: 'j00939207' }),
      { ok: true },
    );
  } finally {
    restoreEnv('PROD_DA_BASE_URL', previousProdDaBaseUrl);
    restoreEnv('PROD_DA_APPID', previousProdDaAppid);
    restoreEnv('PROD_DA_KEY', previousProdDaKey);
    restoreEnv('OPENAPI_BASE_URL', previousOpenApiBaseUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousSkillMarketBaseUrl);
    Date.now = previousDateNow;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  assert.equal(seen.method, 'POST');
  assert.equal(seen.path, '/data-agent/api/agent/list');
  assert.equal(seen.tenant, 'prod-code-001');
  assert.equal(seen.accountId, 'j00939207');
  const expectedBuilder = `POST&/data-agent/api/agent/list&&${JSON.stringify(expectedBody)}&appid=agent-app&timestamp=${fixedTimestamp}`;
  const expectedSignature = crypto
    .createHmac('sha256', Buffer.from(authKey, 'hex'))
    .update(expectedBuilder)
    .digest('base64');
  assert.equal(
    seen.authorization,
    `CLOUDSOA-HMAC-SHA256 appid=agent-app, timestamp=${fixedTimestamp}, signature="${expectedSignature}"`,
  );
  assert.deepEqual(seen.body, expectedBody);
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
