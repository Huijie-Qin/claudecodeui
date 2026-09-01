import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseShowInternalConfigFiles,
  shouldHideWorkspaceInternalEntry,
} from './workspace-file-visibility.js';

test('workspace internal config entries are hidden at the project root by default', () => {
  for (const name of ['.cloudcli', '.mcp.json']) {
    assert.equal(shouldHideWorkspaceInternalEntry({
      name,
      currentDepth: 0,
      showInternalConfigFiles: false,
    }), true);
  }

  for (const name of ['.gitignore', '.env', 'src']) {
    assert.equal(shouldHideWorkspaceInternalEntry({
      name,
      currentDepth: 0,
      showInternalConfigFiles: false,
    }), false);
  }
});

test('workspace internal config entries are visible when explicitly enabled', () => {
  assert.equal(shouldHideWorkspaceInternalEntry({
    name: '.cloudcli',
    currentDepth: 0,
    showInternalConfigFiles: true,
  }), false);
  assert.equal(shouldHideWorkspaceInternalEntry({
    name: '.mcp.json',
    currentDepth: 0,
    showInternalConfigFiles: true,
  }), false);
});

test('workspace internal config filtering is scoped to the project root', () => {
  assert.equal(shouldHideWorkspaceInternalEntry({
    name: '.mcp.json',
    currentDepth: 1,
    showInternalConfigFiles: false,
  }), false);
});

test('showInternalConfigFiles only accepts the explicit true query value', () => {
  assert.equal(parseShowInternalConfigFiles('true'), true);
  assert.equal(parseShowInternalConfigFiles('false'), false);
  assert.equal(parseShowInternalConfigFiles(true), false);
  assert.equal(parseShowInternalConfigFiles(undefined), false);
});
