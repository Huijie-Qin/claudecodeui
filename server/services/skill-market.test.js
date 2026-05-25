import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getSkillMarketDetail,
  importMarketSkill,
  listSkillMarket,
  removeMarketSkill,
  submitMarketSkill,
  viewMarketSkillFile,
} from './skill-market.js';

let marketServer;
let marketDataPath;
let previousMarketBaseUrl;
let previousMarketApiUrl;
let previousMarketAuthAppid;
let previousMarketAuthKey;

async function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-skill-market-'));
}

const TEST_SKILLS = [
  {
    id: 'bug-hunter',
    skillName: 'bug-hunter',
    description: 'Investigate regressions and propose focused fixes.',
    nspPath: 'mock://skills/bug-hunter',
    createUserId: 'j00939207',
    files: {
      'SKILL.md': '# Bug Hunter\n',
      'references/checklist.md': '# Checklist\n',
    },
  },
  {
    id: 'code-reviewer',
    skillName: 'code-reviewer',
    description: 'Review changes for bugs and missing tests.',
    nspPath: 'mock://skills/code-reviewer',
    createUserId: 'j00939207',
    files: {
      'SKILL.md': '# Code Reviewer\n',
      'references/review.md': '# Review Notes\n',
    },
  },
  {
    id: 'frontend-polisher',
    skillName: 'frontend-polisher',
    description: 'Tighten UI layout and interaction states.',
    nspPath: 'mock://skills/frontend-polisher',
    createUserId: 'j00939207',
    files: {
      'SKILL.md': '# Frontend Polisher\n',
      'references/ui.md': '# UI Notes\n',
    },
  },
  {
    id: 'plan-slicer',
    skillName: 'plan-slicer',
    description: 'Split ambiguous work into small slices.',
    nspPath: 'mock://skills/plan-slicer',
    createUserId: 'j00939207',
    files: {
      'SKILL.md': '# Plan Slicer\n',
      'references/planning.md': '# Planning Notes\n',
    },
  },
  {
    id: 'prd-helper',
    skillName: 'prd-helper',
    description: 'Draft concise product requirements.',
    nspPath: 'mock://skills/prd-helper',
    createUserId: 'j00939207',
    files: {
      'SKILL.md': '# PRD Helper\n',
      'references/prd.md': '# PRD Notes\n',
    },
  },
  {
    id: 'test-writer',
    skillName: 'test-writer',
    description: 'Design focused tests around behavior.',
    nspPath: 'mock://skills/test-writer',
    createUserId: 'j00939207',
    files: {
      'SKILL.md': '# Test Writer\n',
      'references/test-cases.md': '# Test Cases\n',
    },
  },
];

function createSkillMarketMockServer({ dataPath }) {
  return http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const endpoint = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const body = parseJson(bodyBuffer.toString('utf8'));

    if (endpoint === '/api/skill/skillList') {
      const submissions = await readMockSubmissions(dataPath);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: TEST_SKILLS.map((skill) => toSkillSummary(skill, submissions[skill.id])),
      });
      return;
    }

    if (endpoint === '/api/skill/preview') {
      const submissions = await readMockSubmissions(dataPath);
      const skill = findTestSkill(body?.data?.id);
      const files = getMockSkillFiles(skill, submissions[skill.id]);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: {
          directoryTree: buildDirectoryTree(files),
          fileContent: body?.data?.filePath ? files[body.data.filePath] ?? '' : undefined,
        },
      });
      return;
    }

    if (endpoint === '/api/skill/download') {
      const submissions = await readMockSubmissions(dataPath);
      const skill = findTestSkill(body?.data?.id);
      const files = getMockSkillFiles(skill, submissions[skill.id]);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: {
          files: Object.entries(files).map(([filePath, content]) => ({ path: filePath, content })),
        },
      });
      return;
    }

    if (endpoint === '/api/skill/update') {
      const fields = parseMultipartFields(bodyBuffer, req.headers['content-type']);
      const id = fields.id || parseJson(fields.data)?.id;
      const files = parseJson(fields.files) || [];
      const submissions = await readMockSubmissions(dataPath);
      submissions[id] = {
        ...submissions[id],
        pendingFiles: Object.fromEntries(files.map((file) => [file.path, file.content])),
      };
      await writeMockSubmissions(dataPath, submissions);
      sendJson(res, { code: 0, message: 'success' });
      return;
    }

    if (endpoint === '/api/skill/publish') {
      const id = body?.data?.id;
      const skill = findTestSkill(id);
      const submissions = await readMockSubmissions(dataPath);
      const current = submissions[id] || {};
      const nextVersion = Number(current.version || 1) + 1;
      submissions[id] = {
        ...current,
        files: current.pendingFiles || getMockSkillFiles(skill, current),
        pendingFiles: undefined,
        version: nextVersion,
      };
      await writeMockSubmissions(dataPath, submissions);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: { version: nextVersion },
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404, message: 'not found' }));
  });
}

test.before(async () => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-skill-market-api-'));
  marketDataPath = path.join(dataDirectory, 'submissions.json');
  marketServer = createSkillMarketMockServer({ dataPath: marketDataPath });
  await new Promise((resolve) => {
    marketServer.listen(0, '127.0.0.1', resolve);
  });

  const { port } = marketServer.address();
  previousMarketBaseUrl = process.env.SKILL_MARKET_BASE_URL;
  previousMarketApiUrl = process.env.SKILL_MARKET_API_URL;
  previousMarketAuthAppid = process.env.SKILL_MARKET_AUTH_APPID;
  previousMarketAuthKey = process.env.SKILL_MARKET_AUTH_KEY;
  delete process.env.SKILL_MARKET_BASE_URL;
  process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${port}`;
  delete process.env.SKILL_MARKET_AUTH_APPID;
  delete process.env.SKILL_MARKET_AUTH_KEY;
});

test.beforeEach(async () => {
  await fs.rm(marketDataPath, { force: true });
});

test.after(async () => {
  if (previousMarketBaseUrl === undefined) {
    delete process.env.SKILL_MARKET_BASE_URL;
  } else {
    process.env.SKILL_MARKET_BASE_URL = previousMarketBaseUrl;
  }

  if (previousMarketApiUrl === undefined) {
    delete process.env.SKILL_MARKET_API_URL;
  } else {
    process.env.SKILL_MARKET_API_URL = previousMarketApiUrl;
  }
  restoreEnv('SKILL_MARKET_AUTH_APPID', previousMarketAuthAppid);
  restoreEnv('SKILL_MARKET_AUTH_KEY', previousMarketAuthKey);

  if (marketServer) {
    await new Promise((resolve, reject) => {
      marketServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('listSkillMarket enriches remote skills with local import and version state', async () => {
  const workspacePath = await makeWorkspace();
  await importMarketSkill({ workspacePath, name: 'bug-hunter' });

  const skills = await listSkillMarket(workspacePath);
  const bugHunter = skills.find((skill) => skill.name === 'bug-hunter');
  const detail = await getSkillMarketDetail({ workspacePath, name: 'bug-hunter' });

  assert.ok(skills.length >= 6);
  assert.ok(bugHunter);
  assert.equal(bugHunter.imported, true);
  assert.equal(bugHunter.importedVersion, 1);
  assert.equal(bugHunter.updateAvailable, false);
  assert.equal(detail.imported, true);
});

test('importMarketSkill downloads the mock API skill into .claude/skills and records metadata', async () => {
  const workspacePath = await makeWorkspace();

  const detail = await importMarketSkill({
    workspacePath,
    name: 'plan-slicer',
    now: () => new Date('2026-05-14T00:00:00.000Z'),
  });

  assert.equal(detail.name, 'plan-slicer');
  assert.equal(detail.imported, true);
  assert.equal(detail.targetPath, '.claude/skills/plan-slicer');
  const viewedFile = await viewMarketSkillFile({
    workspacePath,
    name: 'plan-slicer',
    filePath: 'SKILL.md',
  });
  assert.equal(
    await fs.readFile(path.join(workspacePath, '.claude', 'skills', 'plan-slicer', 'SKILL.md'), 'utf8'),
    viewedFile.file.content,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'), 'utf8')).imports['plan-slicer'],
    {
      name: 'plan-slicer',
      skillId: 'plan-slicer',
      id: 'plan-slicer',
      skillName: 'plan-slicer',
      nspPath: 'mock://skills/plan-slicer',
      createUserId: 'j00939207',
      version: 1,
      source: 'skill-market-api',
      importedAt: '2026-05-14T00:00:00.000Z',
      updatedAt: '2026-05-14T00:00:00.000Z',
    },
  );
});

test('submitMarketSkill submits the complete imported skill directory', async () => {
  const workspacePath = await makeWorkspace();
  await importMarketSkill({ workspacePath, name: 'test-writer' });

  const skillPath = path.join(workspacePath, '.claude', 'skills', 'test-writer');
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Custom Test Writer\n', 'utf8');
  await fs.writeFile(path.join(skillPath, 'references', 'test-cases.md'), '# Custom Cases\n', 'utf8');
  await fs.writeFile(path.join(skillPath, 'references', 'extra.md'), '# Extra File\n', 'utf8');

  const submitted = await submitMarketSkill({
    workspacePath,
    name: 'test-writer',
    currentUsername: 'j00939207',
    now: () => new Date('2026-05-14T01:00:00.000Z'),
  });

  assert.equal(submitted.submittedFileCount, 3);
  assert.equal(submitted.skill.updatedAt, submitted.publishedAt);
  assert.equal(submitted.publishedVersion, 2);
  assert.equal(
    (await viewMarketSkillFile({
      workspacePath,
      name: 'test-writer',
      filePath: 'references/test-cases.md',
    })).file.content,
    '# Custom Cases\n',
  );
  assert.equal(
    (await viewMarketSkillFile({
      workspacePath,
      name: 'test-writer',
      filePath: 'references/extra.md',
    })).file.content,
    '# Extra File\n',
  );
});

test('submitMarketSkill preserves empty file content instead of falling back to the mock source', async () => {
  const workspacePath = await makeWorkspace();
  await importMarketSkill({ workspacePath, name: 'bug-hunter' });

  await fs.writeFile(
    path.join(workspacePath, '.claude', 'skills', 'bug-hunter', 'SKILL.md'),
    '',
    'utf8',
  );

  await submitMarketSkill({
    workspacePath,
    name: 'bug-hunter',
    currentUsername: 'j00939207',
  });

  const viewedFile = await viewMarketSkillFile({
    workspacePath,
    name: 'bug-hunter',
    filePath: 'SKILL.md',
  });

  assert.equal(viewedFile.file.content, '');
});

test('submitMarketSkill rejects stale local skills when the remote version has advanced', async () => {
  const staleWorkspacePath = await makeWorkspace();
  const updaterWorkspacePath = await makeWorkspace();
  await importMarketSkill({ workspacePath: staleWorkspacePath, name: 'bug-hunter' });
  await importMarketSkill({ workspacePath: updaterWorkspacePath, name: 'bug-hunter' });

  await fs.writeFile(
    path.join(updaterWorkspacePath, '.claude', 'skills', 'bug-hunter', 'SKILL.md'),
    '# Remote Update\n',
    'utf8',
  );
  await submitMarketSkill({
    workspacePath: updaterWorkspacePath,
    name: 'bug-hunter',
    currentUsername: 'j00939207',
  });

  const staleDetail = await getSkillMarketDetail({
    workspacePath: staleWorkspacePath,
    name: 'bug-hunter',
    currentUsername: 'j00939207',
  });
  assert.equal(staleDetail.importedVersion, 1);
  assert.equal(staleDetail.version, 2);
  assert.equal(staleDetail.updateAvailable, true);
  assert.equal(staleDetail.canPublish, true);

  await assert.rejects(
    submitMarketSkill({
      workspacePath: staleWorkspacePath,
      name: 'bug-hunter',
      currentUsername: 'j00939207',
    }),
    /Update the local skill before publishing/,
  );
});

test('submitMarketSkill requires a market-imported local skill', async () => {
  const workspacePath = await makeWorkspace();

  await assert.rejects(
    submitMarketSkill({
      workspacePath,
      name: 'bug-hunter',
    }),
    /has not been imported/,
  );
});

test('removeMarketSkill only removes skills imported from the market', async () => {
  const workspacePath = await makeWorkspace();
  await importMarketSkill({ workspacePath, name: 'bug-hunter' });

  await removeMarketSkill({ workspacePath, name: 'bug-hunter' });

  await assert.rejects(
    fs.access(path.join(workspacePath, '.claude', 'skills', 'bug-hunter')),
    /ENOENT/,
  );
  const detail = await getSkillMarketDetail({ workspacePath, name: 'bug-hunter' });
  assert.equal(detail.imported, false);
});

test('manual same-name runtime directories are conflicts instead of removable imports', async () => {
  const workspacePath = await makeWorkspace();
  const manualPath = path.join(workspacePath, '.claude', 'skills', 'frontend-polisher');
  await fs.mkdir(manualPath, { recursive: true });
  await fs.writeFile(path.join(manualPath, 'SKILL.md'), '# Manual Skill', 'utf8');

  const detail = await getSkillMarketDetail({ workspacePath, name: 'frontend-polisher' });

  assert.equal(detail.imported, false);
  assert.equal(detail.conflict, true);
  await assert.rejects(
    importMarketSkill({ workspacePath, name: 'frontend-polisher' }),
    /already exists/,
  );
  await assert.rejects(
    removeMarketSkill({ workspacePath, name: 'frontend-polisher' }),
    /has not been imported/,
  );
  assert.equal(await fs.readFile(path.join(manualPath, 'SKILL.md'), 'utf8'), '# Manual Skill');
});

test('submitMarketSkill signs update requests without including the file in the auth payload', async () => {
  const workspacePath = await makeWorkspace();
  const skillPath = path.join(workspacePath, '.claude', 'skills', 'auth-skill');
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Local Auth Skill\n', 'utf8');
  await fs.mkdir(path.join(workspacePath, '.cloudcli', 'skills'), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'),
    JSON.stringify({
      version: 1,
      imports: {
        'auth-skill': {
          name: 'auth-skill',
          skillId: 'auth-skill',
          id: 'auth-skill',
          skillName: 'auth-skill',
          nspPath: 'mock://skills/auth-skill',
          createUserId: 'creator',
          version: 1,
          source: 'skill-market-api',
        },
      },
    }),
    'utf8',
  );

  const appid = 'auth-app';
  const authKey = '00112233445566778899aabbccddeeff';
  let checkedUpdateAuth = false;
  let updateBodyIncludesFile = false;

  const server = http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const bodyText = bodyBuffer.toString('utf8');
    const endpoint = new URL(req.url || '/', 'http://127.0.0.1').pathname;

    if (endpoint === '/api/skill/update') {
      updateBodyIncludesFile = bodyBuffer.toString('latin1').includes('name="file"');
      assert.equal(
        req.headers.authorization,
        createExpectedAuthorization({
          endpoint,
          payloadText: JSON.stringify({ data: { id: 'auth-skill' } }),
          appid,
          authKey,
          actualAuthorization: req.headers.authorization,
        }),
      );
      checkedUpdateAuth = true;
      sendJson(res, { code: 0, message: 'success' });
      return;
    }

    assert.equal(
      req.headers.authorization,
      createExpectedAuthorization({
        endpoint,
        payloadText: bodyText,
        appid,
        authKey,
        actualAuthorization: req.headers.authorization,
      }),
    );

    if (endpoint === '/api/skill/skillList') {
      sendJson(res, {
        code: 0,
        message: 'success',
        data: [{
          id: 'auth-skill',
          skillName: 'auth-skill',
          description: 'Auth skill',
          nspPath: 'mock://skills/auth-skill',
          createUserId: 'creator',
          version: 1,
          published: true,
        }],
      });
      return;
    }
    if (endpoint === '/api/skill/preview') {
      sendJson(res, {
        code: 0,
        message: 'success',
        data: {
          directoryTree: [{
            name: 'SKILL.md',
            path: 'SKILL.md',
            isDirectory: false,
          }],
        },
      });
      return;
    }
    if (endpoint === '/api/skill/publish') {
      sendJson(res, {
        code: 0,
        message: 'success',
        data: {
          version: 2,
        },
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const previousApiUrl = process.env.SKILL_MARKET_API_URL;
  const previousBaseUrl = process.env.SKILL_MARKET_BASE_URL;
  const previousAppid = process.env.SKILL_MARKET_AUTH_APPID;
  const previousAuthKey = process.env.SKILL_MARKET_AUTH_KEY;

  try {
    delete process.env.SKILL_MARKET_BASE_URL;
    process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.SKILL_MARKET_AUTH_APPID = appid;
    process.env.SKILL_MARKET_AUTH_KEY = authKey;

    await submitMarketSkill({
      workspacePath,
      name: 'auth-skill',
      currentUsername: 'creator',
    });
  } finally {
    restoreEnv('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousBaseUrl);
    restoreEnv('SKILL_MARKET_AUTH_APPID', previousAppid);
    restoreEnv('SKILL_MARKET_AUTH_KEY', previousAuthKey);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  assert.equal(checkedUpdateAuth, true);
  assert.equal(updateBodyIncludesFile, true);
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function findTestSkill(id) {
  const skill = TEST_SKILLS.find((entry) => entry.id === id || entry.skillName === id);
  assert.ok(skill, `Unknown test skill: ${id}`);
  return skill;
}

function toSkillSummary(skill, submission = {}) {
  return {
    id: skill.id,
    skillName: skill.skillName,
    description: skill.description,
    nspPath: skill.nspPath,
    mpdifyTimestamp: null,
    createUserId: skill.createUserId,
    version: Number(submission.version || 1),
    published: true,
  };
}

function getMockSkillFiles(skill, submission = {}) {
  return submission.files || skill.files;
}

async function readMockSubmissions(dataPath) {
  try {
    return JSON.parse(await fs.readFile(dataPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeMockSubmissions(dataPath, submissions) {
  await fs.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.writeFile(dataPath, JSON.stringify(submissions, null, 2), 'utf8');
}

function buildDirectoryTree(files) {
  const root = [];
  for (const filePath of Object.keys(files).sort()) {
    const parts = filePath.split('/').filter(Boolean);
    let children = root;
    let currentPath = '';
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isDirectory = index < parts.length - 1;
      let node = children.find((entry) => entry.name === part);
      if (!node) {
        node = {
          name: part,
          path: currentPath,
          isDirectory,
          ...(isDirectory ? { children: [] } : {}),
        };
        children.push(node);
      }
      if (isDirectory) {
        children = node.children;
      }
    });
  }
  return root;
}

function parseMultipartFields(buffer, contentType = '') {
  const boundary = String(contentType).match(/boundary=(.+)$/)?.[1];
  if (!boundary) return {};
  const fields = {};
  const body = buffer.toString('utf8');
  body.split(`--${boundary}`).forEach((part) => {
    const name = part.match(/name="([^"]+)"/)?.[1];
    if (!name) return;
    const separatorIndex = part.indexOf('\r\n\r\n');
    if (separatorIndex === -1) return;
    fields[name] = part
      .slice(separatorIndex + 4)
      .replace(/\r\n$/, '')
      .replace(/--$/, '');
  });
  return fields;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createExpectedAuthorization({
  endpoint,
  payloadText,
  appid,
  authKey,
  actualAuthorization,
}) {
  const timestamp = String(actualAuthorization).match(/timestamp=([^,]+)/)?.[1];
  assert.ok(timestamp, 'authorization timestamp is required');
  const builder = `POST&${endpoint}${payloadText}&appid ${appid}&timestamp${timestamp}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(authKey, 'hex'))
    .update(builder)
    .digest('base64');
  return `CLOUDSOA-HMAC-SHA256 appid=${appid}, timestamp=${timestamp}, signature="${signature}"`;
}

function readRequestBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
