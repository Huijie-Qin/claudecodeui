import http from 'node:http';
import { fileURLToPath } from 'node:url';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3101;
const DEFAULT_SKILL_COUNT = 137;
const MAX_BODY_BYTES = 1024 * 1024;

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function createTestSkills(count = DEFAULT_SKILL_COUNT) {
  const normalizedCount = normalizePositiveInteger(count, DEFAULT_SKILL_COUNT);
  return Array.from({ length: normalizedCount }, (_, offset) => {
    const index = offset + 1;
    const isSqlSkill = index % 5 === 0;
    const suffix = String(index).padStart(3, '0');
    const skillName = isSqlSkill ? `sql-auditor-${suffix}` : `test-skill-${suffix}`;
    return {
      id: `mock-skill-${suffix}`,
      skillName,
      description: isSqlSkill
        ? `SQL syntax and safety review fixture ${suffix}`
        : `General Skill Market fixture ${suffix}`,
      nspPath: `mock://skill-market/${skillName}`,
      createUserId: 'skill-market-test-user',
      version: 1 + (index % 4),
      published: true,
    };
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function matchesSearch(skill, searchContent) {
  const query = String(searchContent || '').trim().toLowerCase();
  if (!query) return true;
  return [skill.id, skill.skillName, skill.description]
    .some((value) => String(value || '').toLowerCase().includes(query));
}

export function createSkillMarketTestServer({ skills = createTestSkills(), logger = console } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://skill-market-test.local');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, skillCount: skills.length });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__test/requests') {
      sendJson(res, 200, { requests });
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/__test/requests') {
      requests.length = 0;
      sendJson(res, 200, { cleared: true });
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/data-agent/api/skill/skillList') {
      sendJson(res, 404, { code: 404, message: 'not found' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const searchContent = String(body?.data?.searchContent || '');
      const page = normalizePositiveInteger(body?.pageInfo?.page, 1);
      const pageSize = normalizePositiveInteger(body?.pageInfo?.pageSize, 20);
      const filtered = skills.filter((skill) => matchesSearch(skill, searchContent));
      const start = (page - 1) * pageSize;
      const items = filtered.slice(start, start + pageSize);
      const requestRecord = {
        searchContent,
        page,
        pageSize,
        resultCount: items.length,
        total: filtered.length,
        tenantCode: req.headers['x-data-agent-tenant'] || null,
        accountId: req.headers['x-account-id'] || null,
      };
      requests.push(requestRecord);
      if (requests.length > 100) requests.shift();
      logger.info?.('[skill-market-test]', requestRecord);
      sendJson(res, 200, {
        code: 0,
        message: 'success',
        data: {
          list: items,
          total: filtered.length,
          page,
          pageSize,
        },
      });
    } catch (error) {
      sendJson(res, 400, { code: 400, message: error instanceof Error ? error.message : String(error) });
    }
  });

  return { server, skills, requests };
}

export async function startSkillMarketTestServer({
  host = process.env.SKILL_MARKET_TEST_HOST || DEFAULT_HOST,
  port = normalizePositiveInteger(process.env.SKILL_MARKET_TEST_PORT, DEFAULT_PORT),
  count = normalizePositiveInteger(process.env.SKILL_MARKET_TEST_SKILL_COUNT, DEFAULT_SKILL_COUNT),
  logger = console,
} = {}) {
  const testServer = createSkillMarketTestServer({ skills: createTestSkills(count), logger });
  await new Promise((resolve, reject) => {
    testServer.server.once('error', reject);
    testServer.server.listen(port, host, resolve);
  });
  const address = testServer.server.address();
  logger.info?.(`[skill-market-test] listening on http://${host}:${address.port} with ${count} skills`);
  return testServer;
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const testServer = await startSkillMarketTestServer();
  const shutdown = () => testServer.server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
