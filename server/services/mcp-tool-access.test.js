import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveUserWorkspaceMcpToolAccess } from './mcp-tool-access.js';

test('MCP tool access allows all tools when no user preference exists', () => {
  const access = resolveUserWorkspaceMcpToolAccess({
    tenantId: 1,
    workspaceId: 2,
    userId: 3,
    multitenancy: {
      mcpToolPreferences: { listForUser: () => [] },
    },
  });

  assert.equal(access.configured, false);
  assert.deepEqual(access.disallowedTools, []);
  assert.equal(access.isAllowed('mcp__knowledge__delete_docs'), true);
});

test('MCP tool access disables known unselected tools and denies newly discovered tools', () => {
  const access = resolveUserWorkspaceMcpToolAccess({
    tenantId: 1,
    workspaceId: 2,
    userId: 3,
    multitenancy: {
      mcpToolPreferences: {
        listForUser: () => [{
          server_name: 'knowledge',
          allowedToolNames: ['search_docs'],
          presetTools: [{ name: 'search_docs' }, { name: 'delete_docs' }],
          installedTools: [{ name: 'search_docs' }, { name: 'archive_docs' }],
        }],
      },
    },
  });

  assert.deepEqual(access.disallowedTools.sort(), [
    'mcp__knowledge__archive_docs',
    'mcp__knowledge__delete_docs',
  ]);
  assert.equal(access.isAllowed('mcp__knowledge__search_docs'), true);
  assert.equal(access.isAllowed('mcp__knowledge__new_tool'), false);
  assert.equal(access.isAllowed('mcp__other__new_tool'), true);
  assert.equal(access.isAllowed('Read'), true);
});

test('MCP tool access handles server names containing double underscores', () => {
  const access = resolveUserWorkspaceMcpToolAccess({
    tenantId: 1,
    workspaceId: 2,
    userId: 3,
    multitenancy: {
      mcpToolPreferences: {
        listForUser: () => [{
          server_name: 'data__source',
          allowedToolNames: ['query'],
          presetTools: [{ name: 'query' }, { name: 'drop' }],
          installedTools: [],
        }],
      },
    },
  });

  assert.equal(access.isAllowed('mcp__data__source__query'), true);
  assert.equal(access.isAllowed('mcp__data__source__drop'), false);
});

test('MCP tool access uses template defaults until the user saves an explicit preference', () => {
  const templateDefault = resolveUserWorkspaceMcpToolAccess({
    tenantId: 1,
    workspaceId: 2,
    userId: 3,
    multitenancy: {
      mcpToolPreferences: { listForUser: () => [] },
      mcpInstalls: {
        listInstallsForWorkspace: () => [{
          preset_id: 7,
          name: 'knowledge',
          toolSettings: { allowedToolNames: ['search_docs'] },
          presetTools: [{ name: 'search_docs' }, { name: 'delete_docs' }],
          tools: [],
        }],
      },
    },
  });
  assert.equal(templateDefault.isAllowed('mcp__knowledge__search_docs'), true);
  assert.equal(templateDefault.isAllowed('mcp__knowledge__delete_docs'), false);

  const explicitPreference = resolveUserWorkspaceMcpToolAccess({
    tenantId: 1,
    workspaceId: 2,
    userId: 3,
    multitenancy: {
      mcpToolPreferences: {
        listForUser: () => [{
          preset_id: 7,
          server_name: 'knowledge',
          allowedToolNames: ['delete_docs'],
          presetTools: [{ name: 'search_docs' }, { name: 'delete_docs' }],
          installedTools: [],
        }],
      },
      mcpInstalls: {
        listInstallsForWorkspace: () => [{
          preset_id: 7,
          name: 'knowledge',
          toolSettings: { allowedToolNames: ['search_docs'] },
          presetTools: [{ name: 'search_docs' }, { name: 'delete_docs' }],
          tools: [],
        }],
      },
    },
  });
  assert.equal(explicitPreference.isAllowed('mcp__knowledge__search_docs'), false);
  assert.equal(explicitPreference.isAllowed('mcp__knowledge__delete_docs'), true);
});
