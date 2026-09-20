import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import JSZip from 'jszip';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node validate-single-file.mjs HTML_FILE');
const html = await readFile(filename, 'utf8');
const checks = [];
const check = (name, action) => { action(); checks.push(name); };
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
check('All scripts and styles are inline', () => {
  assert.equal(scripts.length, 4);
  assert.ok(scripts.every(([, attributes]) => !/\bsrc\s*=/i.test(attributes)));
  assert.ok(!/<link\b[^>]*\b(?:href|rel)\s*=/i.test(html));
  assert.ok(!/<(?:iframe|object|embed)\b/i.test(html));
  assert.ok(!html.includes('<!--OFFLINE_EMBEDDED_PACKAGE-->'));
});
check('Network connections are prohibited by the packaged CSP', () => {
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("form-action 'none'"));
});
check('CSS does not require external assets', () => {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match => match[1]).join('\n');
  assert.ok(!/@import\b/i.test(css));
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map(match => match[1]);
  assert.ok(urls.every(url => url.startsWith('data:') || url.startsWith('#')), JSON.stringify(urls));
});
check('Both inline executable scripts have valid JavaScript syntax', () => {
  const executable = scripts.filter(([, attributes]) => !/application\/json/i.test(attributes));
  assert.equal(executable.length, 2);
  for (const [, , code] of executable) new Script(code);
});
const snapshot = JSON.parse(scripts.find(([, attributes]) => attributes.includes('offline-snapshot'))[2]);
const attachments = JSON.parse(scripts.find(([, attributes]) => attributes.includes('offline-package'))[2]);
check('Only the fixed synthetic report snapshot is embedded', () => {
  assert.equal(snapshot.kind, 'ai-usage-synthetic-only');
  assert.equal(snapshot.dataThrough, '2026-09-12');
  assert.equal(snapshot.counts.businessRows, 3556);
  assert.deepEqual(snapshot.tables.map(table => table.name).sort(), [
    'tenants','users','tenant_users','workspaces','ai_usage_batches','ai_usage_tenant_state',
    'ai_usage_report_rows','ai_usage_suppressed_rows',
  ].sort());
});
const zip = await JSZip.loadAsync(Buffer.from(attachments.sourceZip, 'base64'), { checkCRC32: true });
const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
check('Embedded source and license archive is complete and contains no business database or environment files', () => {
  for (const name of ['LICENSE','THIRD-PARTY-NOTICES.txt','统计口径说明.md','使用说明.txt',
    'source/package.json','source/snapshot.json','source/vendor/sql-asm.js','source/LICENSE-SQLJS',
    'source/scripts/offline-ai-usage/build.mjs','source/scripts/offline-ai-usage/service.mjs',
    'source/src/components/ai-usage/DemoCodeReport.tsx','source/src/components/ai-usage/ReportGrouping.tsx']) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(names.every(name => !/(^|\/)(\.env(?:\.|$)|\.git\/)|\.(db|sqlite|sqlite3)$|(^|\/)\.\.(\/|$)/i.test(name)));
});
const sourceSnapshot = JSON.parse(await zip.file('source/snapshot.json').async('string'));
check('Embedded source snapshot matches the runtime snapshot', () => assert.deepEqual(sourceSnapshot, snapshot));
const definitions = await zip.file('统计口径说明.md').async('string');
check('Downloadable metric definitions match the embedded document', () => assert.equal(definitions, attachments.definitions));
const metricSource = await zip.file('source/src/components/ai-usage/analysisState.ts').async('string');
const offlineService = await zip.file('source/scripts/offline-ai-usage/service.mjs').async('string');
check('Latest template metrics and fixture-only code tab are packaged', () => {
  assert.ok(metricSource.includes("templates: ['activeUserCount', 'sessionCount']"));
  assert.ok(offlineService.includes('simulation: true'));
  assert.ok(html.includes('活跃使用人数') && html.includes('会话次数') && html.includes('代码产出'));
});
const summaryComponent = await zip.file('source/src/components/ai-usage/SummaryCards.tsx').async('string');
const summaryState = await zip.file('source/src/components/ai-usage/summaryState.ts').async('string');
const labels = JSON.parse(await zip.file('source/src/i18n/locales/zh-CN/aiUsage.json').async('string'));
check('Overview periods and cutoff are explicit and use the snapshot dates', () => {
  assert.ok(summaryComponent.includes('summaryPeriods(current)'));
  assert.ok(summaryComponent.includes('periods.cutoff'));
  assert.ok(summaryState.includes('range(summary?.mauFrom, summary?.to)'));
  assert.ok(!summaryState.includes('new Date('));
  assert.deepEqual(labels.summaryPeriod, { rolling: '近 30 天', cumulative: '历史累计', day: '当日' });
  assert.ok(html.includes('近 30 天以数据截止日为终点'));
});
console.log(JSON.stringify({ file: filename, bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex'),
  checks, sourceFiles: names.length, externalRuntimeAssets: 0, browserFileOpenTested: false }, null, 2));
