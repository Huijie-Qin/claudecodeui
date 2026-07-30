import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import JSZip from 'jszip';

import {
  getSkillMarketDetail,
  getMarketSkillPublishPreview,
  getMarketSkillPublishState,
  importMarketSkill,
  listSkillMarket,
  removeMarketSkill,
  submitMarketSkill,
  uploadAndPublishLocalSkill,
  viewMarketSkillFile,
} from './skill-market.js';

let marketServer;
let marketDataPath;
let previousMarketBaseUrl;
let previousMarketApiUrl;
let previousMarketAuthAppid;
let previousMarketAuthKey;
const TEST_TENANT_CODE = 'tenant-code';
const TEST_ACCOUNT_ID = 'j00939207';

async function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-skill-market-'));
}

function withTenant(options = {}) {
  return { tenantCode: TEST_TENANT_CODE, accountId: TEST_ACCOUNT_ID, ...options };
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
  {
    id: 'cn-skill',
    skillName: '中文技能',
    description: 'Validate non-ASCII skill names.',
    nspPath: 'mock://skills/cn-skill',
    createUserId: 'j00939207',
    files: {
      'SKILL.md': '# 中文技能\n',
    },
  },
];

function createSkillMarketMockServer({ dataPath }) {
  return http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const endpoint = normalizeMockEndpoint(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    const body = parseJson(bodyBuffer.toString('utf8'));

    assert.equal(req.headers['x-data-agent-tenant'], TEST_TENANT_CODE);
    assert.equal(req.headers['x-account-id'], TEST_ACCOUNT_ID);

    if (endpoint === '/api/skill/skillList') {
      assert.equal(body?.data?.hasPublishedVersion, true);
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
      assert.equal(req.method, 'POST');
      const { fields, files: multipartFiles } = parseMultipartParts(bodyBuffer, req.headers['content-type']);
      const id = fields.id;
      const files = await readZipMultipartFile(multipartFiles.file?.content);
      assert.ok(id);
      assert.equal(fields.data, undefined);
      assert.equal(fields.files, undefined);
      const submissions = await readMockSubmissions(dataPath);
      submissions[id] = {
        ...submissions[id],
        pendingFiles: files,
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
  await importMarketSkill(withTenant({ workspacePath, name: 'bug-hunter' }));

  const skills = await listSkillMarket(withTenant({ workspacePath }));
  const bugHunter = skills.find((skill) => skill.name === 'bug-hunter');
  const detail = await getSkillMarketDetail(withTenant({ workspacePath, name: 'bug-hunter' }));

  assert.ok(skills.length >= 6);
  assert.ok(bugHunter);
  assert.equal(bugHunter.imported, true);
  assert.equal(bugHunter.importedVersion, 1);
  assert.equal(bugHunter.updateAvailable, false);
  assert.equal(detail.imported, true);
});

test('listSkillMarket returns the OpenAPI skillList request body with page info', async () => {
  const workspacePath = await makeWorkspace();

  const result = await listSkillMarket(withTenant({
    workspacePath,
    searchContent: 'bug',
    page: 2,
    pageSize: 3,
    includePageInfo: true,
  }));

  assert.deepEqual(result.openApiRequestBody, {
    data: {
      hasPublishedVersion: true,
      searchContent: 'bug',
    },
    pageInfo: {
      page: 2,
      pageSize: 3,
    },
  });
});

test('importMarketSkill downloads the mock API skill into .claude/skills and records metadata', async () => {
  const workspacePath = await makeWorkspace();

  const detail = await importMarketSkill(withTenant({
    workspacePath,
    name: 'plan-slicer',
    now: () => new Date('2026-05-14T00:00:00.000Z'),
  }));

  assert.equal(detail.name, 'plan-slicer');
  assert.equal(detail.imported, true);
  assert.equal(detail.targetPath, '.claude/skills/plan-slicer');
  await fs.writeFile(
    path.join(workspacePath, '.claude', 'skills', 'plan-slicer', 'SKILL.md'),
    '# Local Plan Slicer\n',
    'utf8',
  );
  const viewedFile = await viewMarketSkillFile(withTenant({
    workspacePath,
    name: 'plan-slicer',
    filePath: 'SKILL.md',
  }));
  const localDetail = await getSkillMarketDetail(withTenant({ workspacePath, name: 'plan-slicer' }));
  assert.equal(viewedFile.file.content, '# Local Plan Slicer\n');
  assert.equal(
    localDetail.files.find((file) => file.path === 'SKILL.md')?.size,
    Buffer.byteLength('# Local Plan Slicer\n', 'utf8'),
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

test('importMarketSkill uses the downloaded skill archive root as the local directory', async () => {
  const workspacePath = await makeWorkspace();
  const displayName = 'SQL\u751f\u6210';
  const remoteFiles = {
    'sql-generator/SKILL.md': '# SQL Generator\n',
    'sql-generator/references/query.md': '# Query Notes\n',
  };
  const seenSearchContents = [];
  const server = http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const endpoint = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const body = parseJson(bodyBuffer.toString('utf8'));

    assert.equal(req.headers['x-data-agent-tenant'], TEST_TENANT_CODE);
    assert.equal(req.headers['x-account-id'], TEST_ACCOUNT_ID);

    if (endpoint === '/data-agent/api/skill/skillList') {
      seenSearchContents.push(body?.data?.searchContent);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: [{
          id: 'sql-skill',
          skillName: displayName,
          description: 'Generate SQL from natural language.',
          nspPath: 'mock://skills/sql-generator',
          createUserId: TEST_ACCOUNT_ID,
          version: 1,
          published: true,
        }],
      });
      return;
    }

    if (endpoint === '/data-agent/api/skill/preview') {
      sendJson(res, {
        code: 0,
        message: 'success',
        data: {
          directoryTree: buildDirectoryTree(remoteFiles),
          fileContent: body?.data?.filePath ? remoteFiles[body.data.filePath] ?? '' : undefined,
        },
      });
      return;
    }

    if (endpoint === '/data-agent/api/skill/download') {
      sendJson(res, {
        code: 0,
        message: 'success',
        data: {
          files: Object.entries(remoteFiles).map(([filePath, content]) => ({ path: filePath, content })),
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
  try {
    delete process.env.SKILL_MARKET_BASE_URL;
    process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${server.address().port}`;

    const marketList = await listSkillMarket(withTenant({ workspacePath }));
    assert.equal(marketList[0].name, displayName);
    assert.equal(marketList[0].displayName, displayName);

    const previewDetail = await getSkillMarketDetail(withTenant({
      workspacePath,
      name: displayName,
    }));
    assert.equal(previewDetail.targetPath, '.claude/skills/sql-generator');

    const detail = await importMarketSkill(withTenant({
      workspacePath,
      name: displayName,
      now: () => new Date('2026-05-14T00:00:00.000Z'),
    }));

    assert.equal(detail.name, 'sql-generator');
    assert.equal(detail.targetPath, '.claude/skills/sql-generator');
    assert.equal(
      await fs.readFile(path.join(workspacePath, '.claude', 'skills', 'sql-generator', 'SKILL.md'), 'utf8'),
      '# SQL Generator\n',
    );
    await assert.rejects(
      fs.access(path.join(workspacePath, '.claude', 'skills', 'sql\u751f\u6210', 'sql-generator')),
      /ENOENT/,
    );

    const imports = JSON.parse(await fs.readFile(
      path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'),
      'utf8',
    ));
    assert.equal(imports.imports['sql-generator'].id, 'sql-skill');
    assert.equal(imports.imports['sql-generator'].skillName, displayName);

    const oldSkillName = 'sql\u751f\u6210';
    await fs.rm(path.join(workspacePath, '.claude', 'skills', 'sql-generator'), { recursive: true, force: true });
    await fs.mkdir(path.join(workspacePath, '.claude', 'skills', oldSkillName, 'sql-generator'), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, '.claude', 'skills', oldSkillName, 'sql-generator', 'SKILL.md'),
      '# Old Nested SQL Generator\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'),
      JSON.stringify({
        version: 1,
        imports: {
          [oldSkillName]: {
            id: 'sql-skill',
            skillId: 'sql-skill',
            name: oldSkillName,
            skillName: displayName,
            nspPath: 'mock://skills/sql-generator',
            version: 1,
            source: 'skill-market-api',
          },
        },
      }),
      'utf8',
    );

    await importMarketSkill(withTenant({
      workspacePath,
      name: displayName,
      overwrite: true,
    }));
    await assert.rejects(
      fs.access(path.join(workspacePath, '.claude', 'skills', oldSkillName)),
      /ENOENT/,
    );
    const migratedImports = JSON.parse(await fs.readFile(
      path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'),
      'utf8',
    ));
    assert.equal(migratedImports.imports[oldSkillName], undefined);
    assert.equal(migratedImports.imports['sql-generator'].id, 'sql-skill');
    assert.deepEqual(seenSearchContents.slice(0, 3), ['', displayName, displayName]);
    assert.equal(seenSearchContents.includes(displayName.toLowerCase()), false);
  } finally {
    restoreEnv('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousBaseUrl);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('importMarketSkill supports skill names without ASCII letters or numbers', async () => {
  const workspacePath = await makeWorkspace();

  const detail = await importMarketSkill(withTenant({
    workspacePath,
    name: '中文技能',
  }));

  assert.equal(detail.name, '中文技能');
  assert.equal(detail.imported, true);
  assert.equal(detail.targetPath, '.claude/skills/中文技能');
  assert.equal(
    await fs.readFile(path.join(workspacePath, '.claude', 'skills', '中文技能', 'SKILL.md'), 'utf8'),
    '# 中文技能\n',
  );
});

test('submitMarketSkill submits the complete imported skill directory', async () => {
  const workspacePath = await makeWorkspace();
  await importMarketSkill(withTenant({ workspacePath, name: 'test-writer' }));

  const skillPath = path.join(workspacePath, '.claude', 'skills', 'test-writer');
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Custom Test Writer\n', 'utf8');
  await fs.writeFile(path.join(skillPath, 'references', 'test-cases.md'), '# Custom Cases\n', 'utf8');
  await fs.writeFile(path.join(skillPath, 'references', 'extra.md'), '# Extra File\n', 'utf8');

  const submitted = await submitMarketSkill(withTenant({
    workspacePath,
    name: 'test-writer',
    currentUsername: 'j00939207',
    now: () => new Date('2026-05-14T01:00:00.000Z'),
  }));

  assert.equal(submitted.submittedFileCount, 3);
  assert.equal(submitted.skill.updatedAt, submitted.publishedAt);
  assert.equal(submitted.publishedVersion, 2);
  assert.equal(
    (await viewMarketSkillFile(withTenant({
      workspacePath,
      name: 'test-writer',
      filePath: 'references/test-cases.md',
    }))).file.content,
    '# Custom Cases\n',
  );
  assert.equal(
    (await viewMarketSkillFile(withTenant({
      workspacePath,
      name: 'test-writer',
      filePath: 'references/extra.md',
    }))).file.content,
    '# Extra File\n',
  );
});

test('submitMarketSkill preserves empty file content instead of falling back to the mock source', async () => {
  const workspacePath = await makeWorkspace();
  await importMarketSkill(withTenant({ workspacePath, name: 'bug-hunter' }));

  await fs.writeFile(
    path.join(workspacePath, '.claude', 'skills', 'bug-hunter', 'SKILL.md'),
    '',
    'utf8',
  );

  await submitMarketSkill(withTenant({
    workspacePath,
    name: 'bug-hunter',
    currentUsername: 'j00939207',
  }));

  const viewedFile = await viewMarketSkillFile(withTenant({
    workspacePath,
    name: 'bug-hunter',
    filePath: 'SKILL.md',
  }));

  assert.equal(viewedFile.file.content, '');
});

test('submitMarketSkill rejects stale local skills when the remote version has advanced', async () => {
  const staleWorkspacePath = await makeWorkspace();
  const updaterWorkspacePath = await makeWorkspace();
  await importMarketSkill(withTenant({ workspacePath: staleWorkspacePath, name: 'bug-hunter' }));
  await importMarketSkill(withTenant({ workspacePath: updaterWorkspacePath, name: 'bug-hunter' }));

  await fs.writeFile(
    path.join(updaterWorkspacePath, '.claude', 'skills', 'bug-hunter', 'SKILL.md'),
    '# Remote Update\n',
    'utf8',
  );
  await submitMarketSkill(withTenant({
    workspacePath: updaterWorkspacePath,
    name: 'bug-hunter',
    currentUsername: 'j00939207',
  }));

  const staleDetail = await getSkillMarketDetail(withTenant({
    workspacePath: staleWorkspacePath,
    name: 'bug-hunter',
    currentUsername: 'j00939207',
  }));
  assert.equal(staleDetail.importedVersion, 1);
  assert.equal(staleDetail.version, 2);
  assert.equal(staleDetail.updateAvailable, true);
  assert.equal(staleDetail.canPublish, true);

  await assert.rejects(
    submitMarketSkill(withTenant({
      workspacePath: staleWorkspacePath,
      name: 'bug-hunter',
      currentUsername: 'j00939207',
    })),
    /Update the local skill before publishing/,
  );
});

test('submitMarketSkill requires a market-imported local skill', async () => {
  const workspacePath = await makeWorkspace();

  await assert.rejects(
    submitMarketSkill(withTenant({
      workspacePath,
      name: 'bug-hunter',
    })),
    /has not been imported/,
  );
});

test('removeMarketSkill only removes skills imported from the market', async () => {
  const workspacePath = await makeWorkspace();
  await importMarketSkill(withTenant({ workspacePath, name: 'bug-hunter' }));

  await removeMarketSkill({ workspacePath, name: 'bug-hunter' });

  await assert.rejects(
    fs.access(path.join(workspacePath, '.claude', 'skills', 'bug-hunter')),
    /ENOENT/,
  );
  const detail = await getSkillMarketDetail(withTenant({ workspacePath, name: 'bug-hunter' }));
  assert.equal(detail.imported, false);
});

test('manual same-name runtime directories are conflicts instead of removable imports', async () => {
  const workspacePath = await makeWorkspace();
  const manualPath = path.join(workspacePath, '.claude', 'skills', 'frontend-polisher');
  await fs.mkdir(manualPath, { recursive: true });
  await fs.writeFile(path.join(manualPath, 'SKILL.md'), '# Manual Skill', 'utf8');

  const detail = await getSkillMarketDetail(withTenant({ workspacePath, name: 'frontend-polisher' }));

  assert.equal(detail.imported, false);
  assert.equal(detail.conflict, true);
  await assert.rejects(
    importMarketSkill(withTenant({ workspacePath, name: 'frontend-polisher' })),
    /already exists/,
  );
  await assert.rejects(
    removeMarketSkill({ workspacePath, name: 'frontend-polisher' }),
    /has not been imported/,
  );
  assert.equal(await fs.readFile(path.join(manualPath, 'SKILL.md'), 'utf8'), '# Manual Skill');
});

test('uploadAndPublishLocalSkill saves and publishes a local non-market skill with uppercase name', async () => {
  const workspacePath = await makeWorkspace();
  const skillPath = path.join(workspacePath, '.claude', 'skills', 'LocalAuthor');
  await fs.mkdir(path.join(skillPath, 'references'), { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Local Author\n', 'utf8');
  await fs.writeFile(path.join(skillPath, 'references', 'guide.md'), '# Guide\n', 'utf8');

  const publishState = await getMarketSkillPublishState(withTenant({
    workspacePath,
    name: 'LocalAuthor',
    currentUsername: TEST_ACCOUNT_ID,
  }));
  assert.equal(publishState.name, 'LocalAuthor');
  assert.equal(publishState.canUploadAndPublish, true);
  assert.equal(publishState.imported, false);

  let saveBodyIncludesId = false;
  let saveBodyIncludesFile = false;
  let savedFiles = null;
  let publishedId = null;
  const server = http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const endpoint = new URL(req.url || '/', 'http://127.0.0.1').pathname;

    assert.equal(req.headers['x-data-agent-tenant'], TEST_TENANT_CODE);
    assert.equal(req.headers['x-account-id'], TEST_ACCOUNT_ID);

    if (endpoint === '/data-agent/api/skill/save') {
      assert.equal(req.method, 'POST');
      const { fields, files: multipartFiles } = parseMultipartParts(bodyBuffer, req.headers['content-type']);
      saveBodyIncludesId = Object.prototype.hasOwnProperty.call(fields, 'id');
      saveBodyIncludesFile = Boolean(multipartFiles.file);
      savedFiles = await readZipMultipartFile(multipartFiles.file?.content);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: 'saved-local-author',
      });
      return;
    }

    if (endpoint === '/data-agent/api/skill/publish') {
      const body = parseJson(bodyBuffer.toString('utf8'));
      publishedId = body?.data?.id;
      sendJson(res, {
        code: 0,
        message: 'success',
        data: {
          version: 1,
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
  try {
    delete process.env.SKILL_MARKET_BASE_URL;
    process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${server.address().port}`;

    const result = await uploadAndPublishLocalSkill(withTenant({
      workspacePath,
      name: 'LocalAuthor',
      currentUsername: TEST_ACCOUNT_ID,
      now: () => new Date('2026-05-14T02:00:00.000Z'),
    }));

    assert.equal(result.publishedVersion, 1);
    assert.equal(result.submittedFileCount, 2);
    assert.equal(result.skill.id, 'saved-local-author');
    assert.equal(result.skill.name, 'LocalAuthor');
    assert.equal(result.skill.imported, true);
  } finally {
    restoreEnv('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousBaseUrl);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  assert.equal(saveBodyIncludesId, false);
  assert.equal(saveBodyIncludesFile, true);
  assert.deepEqual(savedFiles, {
    'SKILL.md': '# Local Author\n',
    'references/guide.md': '# Guide\n',
  });
  assert.equal(publishedId, 'saved-local-author');

  const imports = JSON.parse(await fs.readFile(
    path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'),
    'utf8',
  ));
  assert.equal(imports.imports.LocalAuthor.id, 'saved-local-author');
  assert.equal(imports.imports.LocalAuthor.version, 1);
});

test('listSkillMarket deduplicates uploaded skills by remote id when names differ', async () => {
  const workspacePath = await makeWorkspace();
  const skillPath = path.join(workspacePath, '.claude', 'skills', 'local-folder');
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Local Folder\n', 'utf8');
  await writeLegacyMarketImport(workspacePath, 'local-folder', {
    name: 'local-folder',
    skillId: 'remote-uploaded-id',
    id: 'remote-uploaded-id',
    skillName: 'Local Folder',
    nspPath: 'mock://skills/remote-uploaded-id',
    createUserId: TEST_ACCOUNT_ID,
    version: 1,
    source: 'skill-market-api',
  });

  const seenSearchContents = [];
  const server = http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const endpoint = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const body = parseJson(bodyBuffer.toString('utf8'));

    assert.equal(req.headers['x-data-agent-tenant'], TEST_TENANT_CODE);
    assert.equal(req.headers['x-account-id'], TEST_ACCOUNT_ID);

    if (endpoint === '/data-agent/api/skill/skillList') {
      seenSearchContents.push(body?.data?.searchContent);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: [{
          id: 'remote-uploaded-id',
          skillName: 'Remote Uploaded Display',
          description: 'Uploaded through the skill microservice.',
          nspPath: 'mock://skills/remote-uploaded-id',
          createUserId: TEST_ACCOUNT_ID,
          version: 1,
          published: true,
        }],
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
  try {
    delete process.env.SKILL_MARKET_BASE_URL;
    process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${server.address().port}`;

    const skills = await listSkillMarket(withTenant({
      workspacePath,
      currentUsername: TEST_ACCOUNT_ID,
    }));
    const detail = await getSkillMarketDetail(withTenant({
      workspacePath,
      name: 'local-folder',
      currentUsername: TEST_ACCOUNT_ID,
    }));

    assert.equal(skills.length, 1);
    assert.equal(skills[0].id, 'remote-uploaded-id');
    assert.equal(skills[0].name, 'local-folder');
    assert.equal(skills[0].displayName, 'Remote Uploaded Display');
    assert.equal(skills[0].imported, true);
    assert.equal(skills[0].importedVersion, 1);
    assert.equal(detail.name, 'local-folder');
    assert.equal(detail.targetPath, '.claude/skills/local-folder');
    assert.equal(detail.files[0].path, 'SKILL.md');
    assert.deepEqual(seenSearchContents, ['', 'remote-uploaded-id']);
  } finally {
    restoreEnv('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousBaseUrl);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('getMarketSkillPublishPreview strips uploaded archive root before diffing files', async () => {
  const workspacePath = await makeWorkspace();
  const skillPath = path.join(workspacePath, '.claude', 'skills', 'local-folder');
  await fs.mkdir(path.join(skillPath, 'references'), { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Local Folder\nchanged\n', 'utf8');
  await fs.writeFile(path.join(skillPath, 'references', 'guide.md'), '# Guide\n', 'utf8');
  await fs.writeFile(path.join(skillPath, 'references', 'asset.bin'), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(skillPath, 'references', 'changed.bin'), Buffer.from([0, 1, 3, 255]));
  await writeLegacyMarketImport(workspacePath, 'local-folder', {
    name: 'local-folder',
    skillId: 'remote-uploaded-id',
    id: 'remote-uploaded-id',
    skillName: 'Local Folder',
    nspPath: 'mock://skills/remote-uploaded-id',
    createUserId: TEST_ACCOUNT_ID,
    version: 1,
    source: 'skill-market-api',
  });

  const remoteFiles = {
    'local-folder/SKILL.md': '# Local Folder\n',
    'local-folder/references/guide.md': '# Guide\n',
    'local-folder/references/asset.bin': '',
    'local-folder/references/changed.bin': '',
  };
  const remoteZip = new JSZip();
  remoteZip.file('local-folder/SKILL.md', '# Local Folder\n');
  remoteZip.file('local-folder/references/guide.md', '# Guide\n');
  remoteZip.file('local-folder/references/asset.bin', Buffer.from([0, 1, 2, 255]));
  remoteZip.file('local-folder/references/changed.bin', Buffer.from([0, 1, 2, 255]));
  const remoteZipBuffer = await remoteZip.generateAsync({ type: 'nodebuffer' });
  const server = http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const endpoint = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const body = parseJson(bodyBuffer.toString('utf8'));

    assert.equal(req.headers['x-data-agent-tenant'], TEST_TENANT_CODE);
    assert.equal(req.headers['x-account-id'], TEST_ACCOUNT_ID);

    if (endpoint === '/data-agent/api/skill/skillList') {
      sendJson(res, {
        code: 0,
        message: 'success',
        data: [{
          id: 'remote-uploaded-id',
          skillName: 'Remote Uploaded Display',
          description: 'Uploaded through the skill microservice.',
          nspPath: 'mock://skills/remote-uploaded-id',
          createUserId: TEST_ACCOUNT_ID,
          version: 1,
          published: true,
        }],
      });
      return;
    }

    if (endpoint === '/data-agent/api/skill/preview') {
      sendJson(res, {
        code: 0,
        message: 'success',
        data: {
          directoryTree: buildDirectoryTree(remoteFiles),
          fileContent: body?.data?.filePath ? remoteFiles[body.data.filePath] ?? '' : undefined,
        },
      });
      return;
    }

    if (endpoint === '/data-agent/api/skill/download') {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(remoteZipBuffer);
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
  try {
    delete process.env.SKILL_MARKET_BASE_URL;
    process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${server.address().port}`;

    const preview = await getMarketSkillPublishPreview(withTenant({
      workspacePath,
      name: 'local-folder',
      currentUsername: TEST_ACCOUNT_ID,
    }));

    assert.deepEqual(preview.changes, [
      {
        path: 'references/changed.bin',
        status: 'modified',
        isBinary: true,
        oldContent: '',
        newContent: '',
      },
      {
        path: 'SKILL.md',
        status: 'modified',
        oldContent: '# Local Folder\n',
        newContent: '# Local Folder\nchanged\n',
      },
    ]);
  } finally {
    restoreEnv('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousBaseUrl);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('getMarketSkillPublishState marks imported skills as uploadable when the remote skill was deleted', async () => {
  const workspacePath = await makeWorkspace();
  const skillPath = path.join(workspacePath, '.claude', 'skills', 'deleted-remote');
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Deleted Remote\n', 'utf8');
  await writeLegacyMarketImport(workspacePath, 'deleted-remote', {
    name: 'deleted-remote',
    skillId: 'remote-deleted-id',
    id: 'remote-deleted-id',
    skillName: 'Deleted Remote',
    nspPath: 'mock://skills/deleted-remote',
    createUserId: TEST_ACCOUNT_ID,
    version: 3,
    source: 'skill-market-api',
  });

  const seenSearchContents = [];
  const server = http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const endpoint = new URL(req.url || '/', 'http://127.0.0.1').pathname;

    assert.equal(req.headers['x-data-agent-tenant'], TEST_TENANT_CODE);
    assert.equal(req.headers['x-account-id'], TEST_ACCOUNT_ID);

    if (endpoint === '/data-agent/api/skill/skillList') {
      const body = parseJson(bodyBuffer.toString('utf8'));
      seenSearchContents.push(body?.data?.searchContent);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: [],
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
  let state;
  try {
    delete process.env.SKILL_MARKET_BASE_URL;
    process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${server.address().port}`;

    state = await getMarketSkillPublishState(withTenant({
      workspacePath,
      name: 'deleted-remote',
      currentUsername: TEST_ACCOUNT_ID,
    }));
  } finally {
    restoreEnv('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousBaseUrl);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  assert.equal(state.remoteDeleted, true);
  assert.equal(state.imported, true);
  assert.equal(state.canPublish, false);
  assert.equal(state.canUploadAndPublish, true);
  assert.equal(state.importedVersion, 3);
  assert.deepEqual(seenSearchContents, ['remote-deleted-id']);
});

test('uploadAndPublishLocalSkill can republish a local skill whose remote binding was deleted', async () => {
  const workspacePath = await makeWorkspace();
  const skillPath = path.join(workspacePath, '.claude', 'skills', 'deleted-remote');
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Republished Remote\n', 'utf8');
  await writeLegacyMarketImport(workspacePath, 'deleted-remote', {
    name: 'deleted-remote',
    skillId: 'old-deleted-remote',
    id: 'old-deleted-remote',
    skillName: 'Deleted Remote',
    nspPath: 'mock://skills/deleted-remote',
    createUserId: TEST_ACCOUNT_ID,
    version: 3,
    source: 'skill-market-api',
    importedAt: '2026-05-14T00:00:00.000Z',
  });

  let savedFiles = null;
  let publishedId = null;
  const seenSearchContents = [];
  const server = http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const endpoint = new URL(req.url || '/', 'http://127.0.0.1').pathname;

    assert.equal(req.headers['x-data-agent-tenant'], TEST_TENANT_CODE);
    assert.equal(req.headers['x-account-id'], TEST_ACCOUNT_ID);

    if (endpoint === '/data-agent/api/skill/skillList') {
      const body = parseJson(bodyBuffer.toString('utf8'));
      seenSearchContents.push(body?.data?.searchContent);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: [],
      });
      return;
    }

    if (endpoint === '/data-agent/api/skill/save') {
      assert.equal(req.method, 'POST');
      const { fields, files: multipartFiles } = parseMultipartParts(bodyBuffer, req.headers['content-type']);
      assert.equal(Object.prototype.hasOwnProperty.call(fields, 'id'), false);
      savedFiles = await readZipMultipartFile(multipartFiles.file?.content);
      sendJson(res, {
        code: 0,
        message: 'success',
        data: 'new-deleted-remote',
      });
      return;
    }

    if (endpoint === '/data-agent/api/skill/publish') {
      const body = parseJson(bodyBuffer.toString('utf8'));
      publishedId = body?.data?.id;
      sendJson(res, {
        code: 0,
        message: 'success',
        data: {
          version: 1,
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
  try {
    delete process.env.SKILL_MARKET_BASE_URL;
    process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${server.address().port}`;

    const result = await uploadAndPublishLocalSkill(withTenant({
      workspacePath,
      name: 'deleted-remote',
      currentUsername: TEST_ACCOUNT_ID,
      now: () => new Date('2026-05-14T03:00:00.000Z'),
    }));

    assert.equal(result.skill.id, 'new-deleted-remote');
    assert.equal(result.publishedVersion, 1);
  } finally {
    restoreEnv('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousBaseUrl);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  assert.deepEqual(savedFiles, {
    'SKILL.md': '# Republished Remote\n',
  });
  assert.equal(publishedId, 'new-deleted-remote');
  const imports = JSON.parse(await fs.readFile(
    path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'),
    'utf8',
  ));
  assert.equal(imports.imports['deleted-remote'].id, 'new-deleted-remote');
  assert.equal(imports.imports['deleted-remote'].importedAt, '2026-05-14T00:00:00.000Z');
  assert.equal(imports.imports['deleted-remote'].version, 1);
  assert.deepEqual(seenSearchContents, ['old-deleted-remote']);
});

test('submitMarketSkill signs update requests without an auth body', async () => {
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
  let updateBodyIncludesData = false;
  let updateBodyIncludesFile = false;
  let updateBodyIncludesFiles = false;

  const server = http.createServer(async (req, res) => {
    const bodyBuffer = await readRequestBuffer(req);
    const bodyText = bodyBuffer.toString('utf8');
    const endpoint = new URL(req.url || '/', 'http://127.0.0.1').pathname;

    assert.equal(req.headers['x-data-agent-tenant'], TEST_TENANT_CODE);
    assert.equal(req.headers['x-account-id'], TEST_ACCOUNT_ID);

    if (endpoint === '/data-agent/api/skill/update') {
      assert.equal(req.method, 'POST');
      const updateBodyText = bodyBuffer.toString('latin1');
      updateBodyIncludesData = updateBodyText.includes('name="data"');
      updateBodyIncludesFile = updateBodyText.includes('name="file"');
      updateBodyIncludesFiles = updateBodyText.includes('name="files"');
      assert.equal(
        req.headers.authorization,
        createExpectedAuthorization({
          endpoint,
          payloadText: '',
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

    if (endpoint === '/data-agent/api/skill/skillList') {
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
    if (endpoint === '/data-agent/api/skill/preview') {
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
    if (endpoint === '/data-agent/api/skill/publish') {
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

    await submitMarketSkill(withTenant({
      workspacePath,
      name: 'auth-skill',
      currentUsername: 'creator',
    }));
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
  assert.equal(updateBodyIncludesData, false);
  assert.equal(updateBodyIncludesFile, true);
  assert.equal(updateBodyIncludesFiles, false);
});

test('listSkillMarket logs diagnostics for non-JSON responses', async () => {
  const server = http.createServer(async (req, res) => {
    assert.equal(new URL(req.url || '/', 'http://127.0.0.1').pathname, '/data-agent/api/skill/skillList');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>gateway login page</body></html>');
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const previousApiUrl = process.env.SKILL_MARKET_API_URL;
  const previousBaseUrl = process.env.SKILL_MARKET_BASE_URL;
  const previousLogLevel = process.env.SKILL_MARKET_LOG_LEVEL;
  const previousWarn = console.warn;
  const warnings = [];

  try {
    process.env.SKILL_MARKET_API_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.SKILL_MARKET_BASE_URL;
    process.env.SKILL_MARKET_LOG_LEVEL = 'warn';
    console.warn = (...args) => warnings.push(args);

    await assert.rejects(
      listSkillMarket(withTenant()),
      /non-JSON response/,
    );
  } finally {
    restoreEnv('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousBaseUrl);
    restoreEnv('SKILL_MARKET_LOG_LEVEL', previousLogLevel);
    console.warn = previousWarn;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  const nonJsonLog = warnings.find((entry) => entry[0] === '[skill-market]' && entry[1] === 'non_json_response');
  assert.ok(nonJsonLog);
  assert.equal(nonJsonLog[2].status, 200);
  assert.match(nonJsonLog[2].contentType, /text\/html/);
  assert.match(nonJsonLog[2].url, /\/data-agent\/api\/skill\/skillList/);
  assert.match(nonJsonLog[2].responseSnippet, /gateway login page/);
});

test('listSkillMarket appends endpoints after preserving a normalized base URL trailing slash', async () => {
  const seenPaths = [];
  const server = http.createServer(async (req, res) => {
    seenPaths.push(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    sendJson(res, {
      code: 0,
      message: 'success',
      data: [{
        id: 'prefixed-skill',
        skillName: 'prefixed-skill',
        description: 'Skill behind a prefixed gateway path.',
        nspPath: 'mock://skills/prefixed-skill',
        createUserId: 'creator',
        version: 1,
        published: true,
      }],
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const previousApiUrl = process.env.SKILL_MARKET_API_URL;
  const previousBaseUrl = process.env.SKILL_MARKET_BASE_URL;

  try {
    process.env.SKILL_MARKET_BASE_URL = `http://127.0.0.1:${server.address().port}/gateway///`;
    delete process.env.SKILL_MARKET_API_URL;

    const skills = await listSkillMarket(withTenant());

    assert.equal(skills[0].name, 'prefixed-skill');
    assert.deepEqual(seenPaths, ['/gateway//data-agent/api/skill/skillList']);
  } finally {
    restoreEnv('SKILL_MARKET_API_URL', previousApiUrl);
    restoreEnv('SKILL_MARKET_BASE_URL', previousBaseUrl);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function writeLegacyMarketImport(workspacePath, skillName, entry) {
  await fs.mkdir(path.join(workspacePath, '.cloudcli', 'skills'), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'),
    JSON.stringify({
      version: 1,
      imports: {
        [skillName]: entry,
      },
    }),
    'utf8',
  );
}

function normalizeMockEndpoint(endpoint) {
  return String(endpoint || '').replace(/^\/data-agent(?=\/)/, '');
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

function parseMultipartParts(buffer, contentType = '') {
  const boundary = String(contentType).match(/boundary=(.+)$/)?.[1];
  if (!boundary) return { fields: {}, files: {} };
  const fields = {};
  const files = {};
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const separatorBuffer = Buffer.from('\r\n\r\n');
  let partStart = buffer.indexOf(boundaryBuffer);

  while (partStart !== -1) {
    partStart += boundaryBuffer.length;
    if (buffer[partStart] === 45 && buffer[partStart + 1] === 45) break;
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2;

    const headerEnd = buffer.indexOf(separatorBuffer, partStart);
    if (headerEnd === -1) break;

    const headers = buffer.subarray(partStart, headerEnd).toString('utf8');
    const name = headers.match(/name="([^"]+)"/)?.[1];
    const filename = headers.match(/filename="([^"]*)"/)?.[1];
    const contentStart = headerEnd + separatorBuffer.length;
    const nextBoundary = buffer.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
    if (!name || nextBoundary === -1) break;

    const content = buffer.subarray(contentStart, nextBoundary);
    if (filename !== undefined) {
      files[name] = { filename, content };
    } else {
      fields[name] = content.toString('utf8');
    }

    partStart = buffer.indexOf(boundaryBuffer, nextBoundary + 2);
  }

  return { fields, files };
}

async function readZipMultipartFile(buffer) {
  assert.ok(buffer, 'update multipart file is required');
  const zip = await JSZip.loadAsync(buffer);
  const topLevelEntries = new Set();
  const files = {};
  await Promise.all(
    Object.values(zip.files).map(async (entry) => {
      if (entry.dir) return;
      const [topLevelEntry, ...fileParts] = entry.name.split('/').filter(Boolean);
      if (topLevelEntry) topLevelEntries.add(topLevelEntry);
      const filePath = fileParts.join('/');
      if (filePath) {
        files[filePath] = await entry.async('string');
      }
    }),
  );
  assert.equal(topLevelEntries.size, 1, 'zip file must contain exactly one top-level folder');
  return files;
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
  method = 'POST',
  endpoint,
  payloadText,
  appid,
  authKey,
  actualAuthorization,
}) {
  const timestamp = String(actualAuthorization).match(/timestamp=([^,]+)/)?.[1];
  assert.ok(timestamp, 'authorization timestamp is required');
  const builder = `${String(method).toUpperCase()}&${endpoint}&&${payloadText}&appid=${appid}&timestamp=${timestamp}`;
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
