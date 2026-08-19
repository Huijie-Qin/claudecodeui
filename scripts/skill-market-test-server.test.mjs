import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSkillMarketTestServer,
  createTestSkills,
} from './skill-market-test-server.mjs';
import { listSkillMarket } from '../server/services/skill-market.js';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function postSkillList(port, { searchContent = '', page = 1, pageSize = 20 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/data-agent/api/skill/skillList`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-data-agent-tenant': 'tenant-test',
      'x-account-id': 'account-test',
    },
    body: JSON.stringify({
      data: { hasPublishedVersion: true, searchContent },
      pageInfo: { page, pageSize },
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('mock Skill Market filters and paginates deterministic fixtures', async (t) => {
  const fixtureCount = 137;
  const { server } = createSkillMarketTestServer({
    skills: createTestSkills(fixtureCount),
    logger: { info: () => {} },
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const port = await listen(server);

  const firstPage = await postSkillList(port, { page: 1, pageSize: 50 });
  const thirdPage = await postSkillList(port, { page: 3, pageSize: 50 });
  assert.equal(firstPage.data.list.length, 50);
  assert.equal(firstPage.data.total, fixtureCount);
  assert.equal(thirdPage.data.list.length, 37);
  assert.equal(thirdPage.data.list[0].id, 'mock-skill-101');

  const sqlPage = await postSkillList(port, { searchContent: 'sql', page: 2, pageSize: 7 });
  assert.equal(sqlPage.data.list.length, 7);
  assert.equal(sqlPage.data.total, 27);
  assert.equal(sqlPage.data.list.every((skill) => skill.skillName.includes('sql')), true);

  const stateResponse = await fetch(`http://127.0.0.1:${port}/__test/requests`);
  const state = await stateResponse.json();
  assert.deepEqual(state.requests.at(-1), {
    searchContent: 'sql',
    page: 2,
    pageSize: 7,
    resultCount: 7,
    total: 27,
    tenantCode: 'tenant-test',
    accountId: 'account-test',
  });
});

test('CCUI Skill Market client forwards search and pagination to the service', async (t) => {
  const { server } = createSkillMarketTestServer({
    skills: createTestSkills(137),
    logger: { info: () => {} },
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const port = await listen(server);
  const previousBaseUrl = process.env.SKILL_MARKET_BASE_URL;
  const previousApiUrl = process.env.SKILL_MARKET_API_URL;
  const previousAuthAppId = process.env.SKILL_MARKET_AUTH_APPID;
  const previousAuthKey = process.env.SKILL_MARKET_AUTH_KEY;
  t.after(() => {
    restoreEnvironmentVariable('SKILL_MARKET_BASE_URL', previousBaseUrl);
    restoreEnvironmentVariable('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnvironmentVariable('SKILL_MARKET_AUTH_APPID', previousAuthAppId);
    restoreEnvironmentVariable('SKILL_MARKET_AUTH_KEY', previousAuthKey);
  });
  delete process.env.SKILL_MARKET_BASE_URL;
  process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${port}`;
  delete process.env.SKILL_MARKET_AUTH_APPID;
  delete process.env.SKILL_MARKET_AUTH_KEY;

  const result = await listSkillMarket({
    searchContent: 'sql',
    page: 2,
    pageSize: 7,
    tenantCode: 'tenant-through-ccui',
    accountId: 'root-through-ccui',
    includePageInfo: true,
  });

  assert.equal(result.skills.length, 7);
  assert.equal(result.skills.every((skill) => skill.name.includes('sql')), true);
  assert.deepEqual(result.pageInfo, {
    page: 2,
    pageSize: 7,
    total: 27,
    totalPages: 4,
    hasNextPage: true,
  });
  assert.deepEqual(result.openApiRequestBody, {
    data: { hasPublishedVersion: true, searchContent: 'sql' },
    pageInfo: { page: 2, pageSize: 7 },
  });

  const lastPage = await listSkillMarket({
    page: 3,
    pageSize: 50,
    tenantCode: 'tenant-through-ccui',
    accountId: 'root-through-ccui',
    includePageInfo: true,
  });
  assert.deepEqual(lastPage.pageInfo, {
    page: 3,
    pageSize: 50,
    total: 137,
    totalPages: 3,
    hasNextPage: false,
  });

  const stateResponse = await fetch(`http://127.0.0.1:${port}/__test/requests`);
  const state = await stateResponse.json();
  assert.deepEqual(state.requests.at(-1), {
    searchContent: '',
    page: 3,
    pageSize: 50,
    resultCount: 37,
    total: 137,
    tenantCode: 'tenant-through-ccui',
    accountId: 'root-through-ccui',
  });
});

function restoreEnvironmentVariable(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
