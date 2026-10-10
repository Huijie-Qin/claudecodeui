import test from 'node:test';
import assert from 'node:assert/strict';
import { demoCodeFacts, filterDemoCode, groupDemoCode, summarizeDemoCode } from './demoCodeData';
import { reportCsv } from './reportExport';

const all = { from: '2026-08-14', to: '2026-09-12', userName: '', workspaceName: '' };
test('synthetic code facts are explicit, stable and use the preview identities', () => {
  assert.equal(demoCodeFacts.length, 1200);
  assert.equal(new Set(demoCodeFacts.map(r => r.id)).size, 1200);
  assert.equal(groupDemoCode(filterDemoCode(all), 'user').length, 40);
  assert.ok(demoCodeFacts.every(row => row.generatedLines === 0), 'No fabricated generated lines');
});
test('code filters intersect dates, user, workspace and repository before aggregation', () => {
  const rows = filterDemoCode({ ...all, from: '2026-09-12', userName: '用户 05', workspaceName: '工作区 5', repository: 'DATA' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userName, '模拟用户 05');
  assert.equal(filterDemoCode({ ...all, userName: '不存在' }).length, 0);
});
test('code quantities reconcile across every grouping without a ratio metric', () => {
  const total = summarizeDemoCode(demoCodeFacts);
  assert.deepEqual(Object.keys(total).sort(), ['commitCount', 'generatedLines', 'submittedLines']);
  for (const group of ['user','workspace','day','week','month'] as const) {
    const rows = groupDemoCode(demoCodeFacts, group);
    assert.equal(rows.reduce((n, r) => n + r.generatedLines, 0), total.generatedLines);
    assert.equal(rows.reduce((n, r) => n + r.submittedLines, 0), total.submittedLines);
    assert.ok(rows.every(row => !('ratio' in row)));
  }
});
test('export uses all filtered groups, not the 20-row table page', () => {
  const rows = groupDemoCode(filterDemoCode(all), 'user');
  const csv = reportCsv([{ key: 'groupLabel', title: '用户' }, { key: 'generatedLines', title: '生成代码行数' }, { key: 'submittedLines', title: '提交代码行数' }], rows);
  assert.equal(csv.trim().split('\r\n').length, 41);
  assert.ok(csv.includes('模拟用户 40'));
  assert.equal(csv.split('\r\n')[0].replace(/^\uFEFF/, ''), '"用户","生成代码行数","提交代码行数"');
  assert.ok(!csv.includes('%'));
});
