import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createOfflineDatabase } from './database.mjs';
import { createOfflineService } from './service.mjs';

const [snapshotFile, sqlFile, htmlFile, screenshotFile] = process.argv.slice(2);
const livePreview = /^https?:\/\//.test(htmlFile || '');
const screenshotPath = screenshotFile || htmlFile + '.qa.png';
const { default: init } = await import(pathToFileURL(sqlFile).href);
const db = createOfflineDatabase(await init(), JSON.parse(await readFile(snapshotFile, 'utf8')));
const request = createOfflineService(db);
let checks = 0;
const check = (value, expected) => { assert.deepEqual(value, expected); checks++; };
const base = { tenantId: 10, scope: 'tenant', from: '2026-08-14', to: '2026-09-12' };
const summary = request('summary', base);
check([summary.sessionCount, summary.publishedSkillCount, summary.dau, summary.mau], [601, 30, 4, 41]);
check(request('summary', { ...base, userSearch: '不存在', from: '2026-09-12' }), summary);
check(request('skills', { ...base, pageSize: 100 }).total, 30);
check(request('skills', { ...base, pageSize: 100 }).items.reduce((total, row) => total + row.invocationCount, 0), 600);
for (const [dataset, primary] of Object.entries({ usage: 'user', hooks: 'hook', hookExecutions: 'hook', templates: 'template' })) {
  for (const groupBy of new Set([primary, 'user', 'workspace', 'day', 'week', 'month'])) {
    const result = request('analysis', { ...base, dataset, groupBy, pageSize: 100 });
    assert.ok(result.total > 0); assert.ok(result.items.length > 0); checks++;
  }
}
const endpoint = 'hooks/hook-sql/field-statistics';
check(request(endpoint, { ...base, fieldKey: 'sqlLineCount', groupBy: 'user' }).total, 40);
check(request(endpoint, { ...base, fieldKey: 'sqlLineCount', groupBy: 'hook' }).items[0].sum, 13800);
check(request(endpoint, { ...base, fieldKey: 'sqlLineCount', groupBy: 'workspace', sortBy: 'groupLabel', sortDir: 'asc' }).items.map((row) => row.sum), [2600, 2680, 2760, 2840, 2920]);
const filter = { ...base, fieldKey: 'sqlLineCount', groupBy: 'user', userSearch: '模拟用户 07', workspaceSearch: '模拟工作区 2' };
const sqlUser = request(endpoint, filter).items[0];
check([sqlUser.sum, sqlUser.average, sqlUser.min, sqlUser.max, sqlUser.validCount], [360, 36, 16, 56, 10]);
check(request('hooks/hook-sql/records', filter).total, 10);
check(request(endpoint, { ...filter, from: '2026-09-12' }).total, 0);
check(request(endpoint, { ...filter, userSearch: '不存在' }).total, 0);
const page1 = request(endpoint, { ...base, groupBy: 'user', pageSize: 1, sortBy: 'sum' });
const page2 = request(endpoint, { ...base, groupBy: 'user', pageSize: 1, sortBy: 'sum', page: 2 });
check(page1.total, 80); assert.notDeepEqual(page1.items, page2.items); checks++;
check(request('hooks/hook-session-a/records', base).total, 400);
check(request('hook-executions/hook-session-a/records', base).total, 400);
check(request('agent-templates/template-1/applications', base).total, 0);
assert.ok(request('agent-templates/template-1/sessions', base).total > 0); checks++;
check(request('status', { tenantId: 20 }).batchId, null);
check(request('capabilities', { tenantId: 10 }, 3).canViewTenant, false);
assert.throws(() => request('analysis', base, 3), { status: 403 }); checks++;
check(request('exports', base), { jobs: [] });
db.close();
console.log('Offline SQLite checks: ' + checks + ' passed');
if (!htmlFile) process.exit(0);

// Dedicated headless browser/profile; never changes the live preview.
const profile = await mkdtemp('/tmp/ccui-offline-browser-');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--remote-debugging-pipe', '--user-data-dir=' + profile, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let sequence = 0; let buffer = ''; let sessionId;
const pending = new Map(); const errors = []; const network = []; const downloads = new Map();
const send = (method, params = {}, browser = false) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...sessionId && !browser ? { sessionId } : {} }) + '\0');
});
chrome.stdio[4].on('data', (data) => {
  buffer += data.toString();
  let index;
  while ((index = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    if (message.id) {
      const item = pending.get(message.id);
      if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); }
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
    if (message.method === 'Browser.downloadWillBegin') downloads.set(message.params.guid, { ...message.params, state: 'started' });
    if (message.method === 'Browser.downloadProgress') downloads.set(message.params.guid, { ...downloads.get(message.params.guid), ...message.params });
  }
});
chrome.stderr.on('data', () => {});
const evaluate = async (expression) => {
  const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
  return value.result.value;
};
const waitFor = async (expression) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('UI timeout: ' + expression + '\n' + await evaluate('document.body.innerText'));
};
const click = async (text, selector = 'button') => evaluate(
  '(() => { const scope=document.querySelector("[role=dialog]") || document; const el=[...scope.querySelectorAll(' + JSON.stringify(selector) + ')].find(el=>el.checkVisibility() && el.textContent.trim()===' + JSON.stringify(text) + '); if(!el)throw Error("Missing control"); el.click(); })()');
const field = async (label, value, tag = 'select', scope = 'document') => evaluate(
  '(() => { const el=[...' + scope + '.querySelectorAll("label")].find(el=>el.textContent.trim().startsWith(' + JSON.stringify(label) + '))?.querySelector(' + JSON.stringify(tag) + '); if(!el)throw Error("Missing field"); Object.getOwnPropertyDescriptor(' + (tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement') + '.prototype,"value").set.call(el,' + JSON.stringify(value) + '); el.dispatchEvent(new Event(' + JSON.stringify(tag === 'select' ? 'change' : 'input') + ',{bubbles:true})); })()');
const region = (name) => 'document.querySelector(' + JSON.stringify('section[aria-label="' + name + '"]') + ')';
const exportCsv = async (selector, expectedRows) => {
  const before = new Set(downloads.keys());
  await click('导出当前统计', selector + ' button');
  let file;
  for (let attempt = 0; attempt < 90; attempt++) {
    file = [...downloads.values()].find((download) => !before.has(download.guid) && download.state === 'completed');
    if (file) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(file, 'CSV download completed: ' + await evaluate('document.body.innerText'));
  const bytes = await readFile(profile + '/' + file.guid);
  check([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = bytes.toString('utf8');
  check(csv.trimEnd().split('\r\n').length, expectedRows + 1);
  assert.ok(file.suggestedFilename.endsWith('.csv')); checks++;
  assert.ok(!csv.includes('进入统计') && !csv.includes('执行记录</')); checks++;
  return csv;
};
try {
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: profile, eventsEnabled: true }, true);
  const target = await send('Target.createTarget', { url: 'about:blank' }, true);
  sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, true)).sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  if (!livePreview) await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await send('Emulation.setDeviceMetricsOverride', { width: 1214, height: 1178, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: livePreview ? htmlFile : pathToFileURL(htmlFile).href });
  await waitFor('document.body.innerText.includes("模拟用户 05")');
  check(await evaluate('location.protocol'), livePreview ? 'http:' : 'file:');
  check(await evaluate('document.querySelectorAll("[role=tab]").length'), 5);
  if (!livePreview) check(await evaluate('document.body.innerText.includes("离线版不自动更新")'), true);
  const usageCsv = await exportCsv('section[aria-label="AI 使用统计表"]', 43);
  assert.ok(usageCsv.includes('"用户","会话次数"') && usageCsv.includes('模拟用户 40')); checks++;
  assert.ok(!usageCsv.includes('发布 Skill') && !usageCsv.includes('Skill 调用次数')); checks++;
  check(await evaluate(region('AI 使用统计表') + '.querySelectorAll("thead th").length'), 4);
  await field('分组维度', 'month');
  await waitFor('document.body.innerText.includes("2026-08") && !document.body.innerText.includes("正在加载")');
  const monthCsv = await exportCsv('section[aria-label="AI 使用统计表"]', 2);
  assert.ok(monthCsv.includes('"自然月"') && monthCsv.includes('"2026-08","360"')); checks++;
  await click('Skill 发布与调用', '[role="tab"]');
  await waitFor('document.body.innerText.includes("首次发布时间") && !document.body.innerText.includes("正在加载")');
  const skillsCsv = await exportCsv('section[aria-label="Skill 发布与调用"]', 30);
  assert.ok(skillsCsv.includes('"发布者"') && skillsCsv.includes('SQL 分析')); checks++;
  assert.ok(skillsCsv.includes('期间新增发布数')); checks++;
  check(await evaluate('document.querySelector("form[aria-label=公共筛选]").innerText.includes("发布者用户名")'), true);
  await click('下一页', 'section[aria-label="Skill 发布与调用"] button');
  await waitFor(region('Skill 发布与调用') + '.innerText.includes("第 2 页") && !document.body.innerText.includes("正在加载")');
  await click('AI 使用', '[role="tab"]');
  await waitFor(region('AI 使用统计表') + '?.innerText.includes("2026-08")');
  await click('Skill 发布与调用', '[role="tab"]');
  await waitFor(region('Skill 发布与调用') + '?.innerText.includes("第 2 页") && !document.body.innerText.includes("正在加载")');
  check(await evaluate(region('Skill 发布与调用') + '.querySelectorAll("tbody tr").length'), 10);
  await field('每页条数', '50', 'select', region('Skill 发布与调用'));
  await waitFor(region('Skill 发布与调用') + '.querySelectorAll("tbody tr").length === 30');
  await field('分组维度', 'publisher');
  await waitFor(region('Skill 发布与调用') + '.innerText.includes("共 2 条") && !document.body.innerText.includes("正在加载")');
  const publishersCsv = await exportCsv('section[aria-label="Skill 发布与调用"]', 2);
  assert.ok(publishersCsv.includes('"发布者","期间新增发布数","Skill 调用次数","调用人数"')); checks++;
  await field('Skill 名称', 'SQL', 'input'); await click('应用筛选', 'section[aria-label="Skill 发布与调用"] button');
  await waitFor('!document.body.innerText.includes("正在加载")');
  await click('AI 使用', '[role="tab"]');
  await waitFor(region('AI 使用统计表') + '?.innerText.includes("2026-08")');
  check(await evaluate(region('AI 使用统计表') + '.querySelector("select").value'), 'month');
  await click('Skill 发布与调用', '[role="tab"]');
  await waitFor(region('Skill 发布与调用') + '?.innerText.includes("共 2 条")');
  check(await evaluate(region('Skill 发布与调用') + '.querySelector("select").value'), 'publisher');
  check(await evaluate(region('Skill 发布与调用') + '.querySelector("input").value'), 'SQL');
  check(await evaluate(region('Skill 发布与调用') + '.querySelector("select[aria-label=每页条数]").value'), '50');
  await evaluate(region('Skill 发布与调用') + '.scrollIntoView({block:"start"})');
  await writeFile(screenshotPath + '.skills.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate(region('Skill 发布与调用') + '.scrollIntoView({block:"start"})');
  check(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await writeFile(screenshotPath + '.skills-mobile.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1214, height: 1178, deviceScaleFactor: 1, mobile: false });
  await field('Skill 名称', '没有此 Skill', 'input'); await click('应用筛选', 'section[aria-label="Skill 发布与调用"] button');
  await waitFor('document.body.innerText.includes("该筛选范围没有记录")');
  await exportCsv('section[aria-label="Skill 发布与调用"]', 0);
  await click('Hook 执行统计', '[role="tab"]');
  await waitFor('document.body.innerText.includes("1,200") && document.body.innerText.includes("539.21 ms")');
  const executionsCsv = await exportCsv('section[aria-label="Hook 执行统计表"]', 3);
  assert.ok(executionsCsv.includes('"400","360","20","20"')); checks++;
  await click('执行记录'); await waitFor('document.querySelector("[role=dialog]")?.innerText.includes("共 400 条")');
  await exportCsv('section[aria-label="执行记录"]', 400);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await waitFor('!document.querySelector("[role=dialog]")');
  await click('Agent 模板使用', '[role="tab"]');
  await waitFor('document.body.innerText.includes("需求分析 Agent")');
  await exportCsv('section[aria-label="Agent 模板使用统计表"]', 5);
  check(await evaluate(region('Agent 模板使用统计表') + '.querySelectorAll("select").length'), 1);
  await click('查看使用分析');
  await waitFor('document.querySelector("[role=dialog]")?.innerText.includes("共 9 条") && !document.querySelector("[role=dialog]")?.innerText.includes("正在加载")');
  check(await evaluate('document.querySelector("[role=dialog]").getAttribute("aria-label")'), '需求分析 Agent · 模板使用分析');
  const templateCsv = await exportCsv('[role=dialog] section[aria-label="Agent 模板使用统计表"]', 9);
  assert.ok(!templateCsv.includes('查看使用分析')); checks++;
  await field('分组维度', 'workspace', 'select', 'document.querySelector("[role=dialog]")');
  await waitFor('document.querySelector("[role=dialog]").innerText.includes("共 1 条")');
  await exportCsv('[role=dialog] section[aria-label="Agent 模板使用统计表"]', 1);
  await writeFile(screenshotPath + '.template.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  check(await evaluate('(()=>{const r=document.querySelector("[role=dialog]").getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()'), true);
  await writeFile(screenshotPath + '.template-mobile.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1214, height: 1178, deviceScaleFactor: 1, mobile: false });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await waitFor('!document.querySelector("[role=dialog]")');
  await click('Hook 业务统计', '[role="tab"]');
  await waitFor('document.body.innerText.includes("SQL 产出记录")');
  await field('Hook 名称', 'SQL', 'input', region('Hook 业务统计列表'));
  await click('应用筛选', 'section[aria-label="Hook 业务统计列表"] button');
  await waitFor(region('Hook 业务统计列表') + '.innerText.includes("共 1 条")');
  const hookCsv = await exportCsv('section[aria-label="Hook 业务统计列表"]', 1);
  assert.ok(hookCsv.includes('SQL 产出记录') && !hookCsv.includes('会话记录 Hook')); checks++;
  await evaluate('window.hookTrigger=[...document.querySelectorAll("tr")].find(el=>el.textContent.includes("SQL 产出记录")).querySelector("button"); window.hookTrigger.scrollIntoView({block:"center"}); window.hookTrigger.focus({preventScroll:true}); window.hookPageY=scrollY; window.hookTrigger.click()');
  await waitFor(region('单个 Hook 统计') + ' && ' + region('数值字段统计') + '?.innerText.includes("模拟用户 01")');
  check(await evaluate('document.querySelector("[role=dialog]").getAttribute("aria-modal")'), 'true');
  check(await evaluate('document.querySelector("#ai-usage-tab-panel").contains(document.querySelector("[role=dialog]"))'), false);
  check(await evaluate('document.querySelector("[role=dialog]").getAttribute("aria-label")'), 'SQL 产出记录 · 单个 Hook 统计');
  check(await evaluate('document.body.style.overflow'), 'hidden');
  check(await evaluate('scrollY === window.hookPageY'), true);
  check(await evaluate('document.activeElement.getAttribute("aria-label")'), '关闭');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8 });
  check(await evaluate('document.querySelector("[role=dialog]").contains(document.activeElement)'), true);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
  check(await evaluate('document.activeElement.getAttribute("aria-label")'), '关闭');
  await field('数值字段', 'sqlLineCount');
  await waitFor(region('数值字段统计') + '.innerText.includes("共 40 条")');
  const sqlCsv = await exportCsv('section[aria-label="数值字段统计"]', 40);
  assert.ok(sqlCsv.includes('"模拟用户 40"') && !/"[\d.,]+ (?:行|条)"/.test(sqlCsv)); checks++;
  await field('用户名', '模拟用户 07', 'input', region('单个 Hook 统计'));
  await field('工作区名称', '模拟工作区 2', 'input', region('单个 Hook 统计'));
  await click('应用筛选');
  const numericResults = region('数值字段统计') + '.querySelector("tbody td:last-child")?.textContent.trim()';
  await waitFor(numericResults + ' === "360" && ' + region('记录明细') + '.innerText.includes("共 10 条")');
  for (const [metric, expected] of [['average', '36'], ['min', '16'], ['max', '56'], ['sum', '360']]) {
    await field('统计方式', metric);
    await waitFor(numericResults + ' === ' + JSON.stringify(expected));
    const selectedCsv = await exportCsv('section[aria-label="数值字段统计"]', 1);
    assert.ok(selectedCsv.includes('"模拟用户 07","SQL 行数","record-sql","' + expected + '"')); checks++;
    checks++;
  }
  await field('分组维度', 'workspace');
  await waitFor(region('数值字段统计') + '.innerText.includes("模拟工作区 2") && ' + numericResults + ' === "360"');
  await field('开始日期', '2026-09-12', 'input', region('单个 Hook 统计'));
  await click('应用筛选');
  await waitFor(region('记录明细') + '.innerText.includes("共 0 条")');
  await click('重置筛选');
  await waitFor(region('记录明细') + '.innerText.includes("共 400 条")');
  await field('数值字段', 'sqlLineCount'); await field('分组维度', 'user');
  await waitFor(region('数值字段统计') + '.innerText.includes("共 40 条")');
  await evaluate('document.querySelector("[role=dialog] > div").scrollTop=0');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  check(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  await evaluate('document.querySelector("[role=dialog] > div").scrollTop=1000');
  check(await evaluate('scrollY === window.hookPageY'), true);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await waitFor('!document.querySelector("[role=dialog]")');
  check(await evaluate('document.activeElement === window.hookTrigger'), true);
  check(await evaluate('document.body.style.overflow'), '');
  check(await evaluate('scrollY === window.hookPageY'), true);
  check(await evaluate(region('Hook 业务统计列表') + '.querySelector("input").value'), 'SQL');
  await evaluate('window.hookTrigger.click()');
  await waitFor(region('数值字段统计') + '?.innerText.includes("共 80 条")');
  await evaluate('document.querySelector("[role=dialog] button[aria-label=关闭]").click()');
  await waitFor('!document.querySelector("[role=dialog]")');
  await evaluate('window.hookTrigger.click()');
  await waitFor(region('数值字段统计') + '?.innerText.includes("共 80 条")');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  check(await evaluate('(() => { const r=document.querySelector("[role=dialog]").getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight; })()'), true);
  check(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 });
  await waitFor('!document.querySelector("[role=dialog]")');
  await send('Emulation.setDeviceMetricsOverride', { width: 1214, height: 1178, deviceScaleFactor: 1, mobile: false });
  check(errors.length, 0);
  if (!livePreview) check(network.filter((url) => /^https?:/i.test(url)), []);
  await evaluate('document.querySelector("[aria-label=预览租户]").value="20"; document.querySelector("[aria-label=预览租户]").dispatchEvent(new Event("change",{bubbles:true}))');
  await waitFor('document.body.innerText.includes("尚无统计数据")');
  await evaluate('document.querySelector("[aria-label=预览租户]").value="10"; document.querySelector("[aria-label=预览租户]").dispatchEvent(new Event("change",{bubbles:true}))');
  await waitFor('document.body.innerText.includes("模拟用户 05")');
  await click('深色'); check(await evaluate('document.documentElement.classList.contains("dark")'), true);
  await evaluate('document.querySelector("[aria-label=预览身份]").value="3"; document.querySelector("[aria-label=预览身份]").dispatchEvent(new Event("change",{bubbles:true}))');
  await waitFor('document.querySelector("[role=alert]") && !document.querySelector("[role=tab]")');
  console.log(JSON.stringify({ checks, browser: livePreview ? 'Chrome headless, live preview' : 'Chrome headless, file://, network offline', runtimeErrors: errors.length, httpRequests: network.filter((url) => /^https?:/i.test(url)).length, screenshot: screenshotPath, profile }, null, 2));
} finally {
  await send('Browser.close', {}, true).catch(() => {});
  chrome.kill();
}
