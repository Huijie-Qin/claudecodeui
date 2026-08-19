import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAgentGraphDemoDataRouter } from './agent-graph-demo-data.js';

async function requestJson(router, requestPath, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function createService() {
  return {
    getDemoDataCatalog: () => ({ datasets: ['reports', 'profiles'] }),
    getMusicReportSchema: () => ({ id: 'reports' }),
    queryMusicReports: (query) => ({ query, rows: [] }),
    getAudienceSchema: () => ({ id: 'profiles' }),
    analyzeAudience: (body) => ({ body, cohort: { size: 10 } }),
    sampleAudience: (body) => ({ body, rows: [] }),
  };
}

test('demo data routes are completely hidden with Agent Graph disabled', async () => {
  const router = createAgentGraphDemoDataRouter({
    service: createService(),
    featureFlags: { isEnabled: () => false },
  });
  const { response, payload } = await requestJson(router, '/catalog');

  assert.equal(response.status, 404);
  assert.equal(payload.error, 'Agent Graph demo data is not enabled');
});

test('report and audience routes pass query and body inputs to separate data services', async () => {
  const router = createAgentGraphDemoDataRouter({
    service: createService(),
    featureFlags: { isEnabled: () => true },
  });
  const report = await requestJson(router, '/music-reports/query?apps=soda-music');
  const audience = await requestJson(router, '/audience-profiles/analyze', {
    method: 'POST',
    body: { filters: [{ tag: 'industry', operator: 'eq', value: '教育' }] },
  });

  assert.equal(report.response.status, 200);
  assert.equal(report.payload.query.apps, 'soda-music');
  assert.equal(audience.response.status, 200);
  assert.equal(audience.payload.cohort.size, 10);
  assert.equal(audience.payload.body.filters[0].value, '教育');
});
