import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodeHubMcpService } from './codehub-mcp.js';

function createJsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null),
    },
    text: async () => JSON.stringify(body),
  };
}

function createTextResponse(text, { status = 200, contentType = 'text/event-stream' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null),
    },
    text: async () => text,
  };
}

function withMcpEnv(fn) {
  return async () => {
    const previousUrl = process.env.CODEHUB_MCP_URL;
    const previousHost = process.env.CODEHUB_HOST;
    process.env.CODEHUB_MCP_URL = 'https://mcp.example.test/mcp';
    process.env.CODEHUB_HOST = 'https://gitlab.example.test';
    try {
      await fn();
    } finally {
      if (previousUrl === undefined) {
        delete process.env.CODEHUB_MCP_URL;
      } else {
        process.env.CODEHUB_MCP_URL = previousUrl;
      }
      if (previousHost === undefined) {
        delete process.env.CODEHUB_HOST;
      } else {
        process.env.CODEHUB_HOST = previousHost;
      }
    }
  };
}

test('CodeHub MCP requests accept JSON and event-stream responses', withMcpEnv(async () => {
  let acceptHeader = '';
  const service = createCodeHubMcpService({
    headerResolver: async () => ({ Authorization: 'Bearer test-token' }),
    fetchImpl: async (_url, init) => {
      acceptHeader = init.headers.Accept;
      return createJsonResponse({
        result: {
          content: [{ json: { id: 123, http_url_to_repo: 'https://gitlab.example.test/group/repo.git' } }],
        },
      });
    },
  });

  const result = await service.getProjectInfo({
    userId: 1,
    gitUrl: 'https://gitlab.example.test/group/repo.git',
  });

  assert.equal(acceptHeader, 'application/json, text/event-stream');
  assert.equal(result.id, 123);
}));

test('CodeHub MCP parses streamable HTTP event-stream tool results', withMcpEnv(async () => {
  const service = createCodeHubMcpService({
    headerResolver: async () => ({}),
    fetchImpl: async () => createTextResponse([
      'event: message',
      'data: {"jsonrpc":"2.0","id":"1","result":{"content":[{"json":{"id":456,"iid":7,"state":"opened"}}]}}',
      '',
      '',
    ].join('\n')),
  });

  const result = await service.createMergeRequest({
    userId: 1,
    projectId: 123,
    sourceBranch: 'feature/test',
    targetBranch: 'develop',
    title: 'Test MR',
    description: 'Test description',
  });

  assert.deepEqual(result, {
    id: 456,
    iid: 7,
    state: 'opened',
  });
}));
