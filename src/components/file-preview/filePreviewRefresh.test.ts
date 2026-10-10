import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRefreshFilePreview, type FilePreviewRefreshTarget } from './filePreviewRefresh';

const target: FilePreviewRefreshTarget = {
  path: '/srv/workspaces/team/reports/sample.xlsx',
  displayPath: '/workspace/reports/sample.xlsx',
  projectPath: '/srv/workspaces/team',
  projectName: 'team',
  workspaceId: 42,
};

test('matching workspace root uploads refresh open previews', () => {
  for (const changedPath of ['', '.', '/workspace', '/srv/workspaces/team/']) {
    assert.equal(shouldRefreshFilePreview(target, { projectName: 'team', workspaceId: '42', changedPath, reason: 'upload' }), true, changedPath);
  }
  assert.equal(shouldRefreshFilePreview(target, { workspaceId: 42 }), true);
});

test('other workspaces and projects cannot invalidate a preview', () => {
  assert.equal(shouldRefreshFilePreview(target, { workspaceId: 43, changedPath: '' }), false);
  assert.equal(shouldRefreshFilePreview(target, { projectName: 'other', changedPath: '' }), false);
  assert.equal(shouldRefreshFilePreview(target, { projectName: 'team', workspaceId: 43, changedPath: target.path }), false);
});

test('file and directory notifications match relative, display and real paths', () => {
  for (const changedPath of ['reports/sample.xlsx', './reports/sample.xlsx', '/workspace/reports/sample.xlsx', target.path, 'reports', '/workspace/reports/', '/srv/workspaces/team/reports']) {
    assert.equal(shouldRefreshFilePreview(target, { workspaceId: 42, changedPath }), true, changedPath);
  }
});

test('unrelated files and directory prefixes do not reload a preview', () => {
  for (const changedPath of ['reports/other.xlsx', '/workspace/reports/sample.xlsx.bak', '/workspace/report', 'reports-old', '/srv/workspaces/team-two', 'another-folder']) {
    assert.equal(shouldRefreshFilePreview(target, { workspaceId: 42, changedPath }), false, changedPath);
  }
});

test('spreadsheet tabs can match paths using displayPath without a real project root', () => {
  const tabTarget = { ...target, projectPath: 'team' };
  assert.equal(shouldRefreshFilePreview(tabTarget, { changedPath: 'reports' }), true);
  assert.equal(shouldRefreshFilePreview(tabTarget, { changedPath: '/srv/workspaces/team/reports' }), true);
  assert.equal(shouldRefreshFilePreview(tabTarget, { changedPath: 'team' }), false);
});

test('image and legacy editor previews derive virtual paths from their project root', () => {
  const imageTarget = { ...target, displayPath: undefined };
  assert.equal(shouldRefreshFilePreview(imageTarget, { changedPath: '/workspace/reports' }), true);
  assert.equal(shouldRefreshFilePreview(imageTarget, { changedPath: 'reports/sample.xlsx' }), true);
  assert.equal(shouldRefreshFilePreview({ ...imageTarget, path: '/workspace/reports/sample.xlsx' }, { changedPath: '/srv/workspaces/team/reports' }), true);
  assert.equal(shouldRefreshFilePreview({ ...imageTarget, path: 'reports/sample.xlsx' }, { changedPath: '/workspace/reports' }), true);
});

test('Windows path separators are normalized without changing path case', () => {
  const windowsTarget = { ...target, path: 'C:\\workspaces\\team\\reports\\sample.xlsx', projectPath: 'C:\\workspaces\\team', displayPath: undefined };
  assert.equal(shouldRefreshFilePreview(windowsTarget, { changedPath: 'reports\\sample.xlsx' }), true);
  assert.equal(shouldRefreshFilePreview(windowsTarget, { changedPath: 'C:\\workspaces\\team\\reports' }), true);
  assert.equal(shouldRefreshFilePreview(windowsTarget, { changedPath: 'reports\\other.xlsx' }), false);
});
