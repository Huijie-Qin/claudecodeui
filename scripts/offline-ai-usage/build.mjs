import { readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const [snapshotPath, sqlPath, target] = process.argv.slice(2);
if (!target || !snapshotPath || !sqlPath) throw new Error('Usage: node scripts/offline-ai-usage/build.mjs SNAPSHOT.json SQL-ASM.js OUTPUT_DIR');
const destination = path.resolve(target);
if (destination === root || destination === path.parse(destination).root) throw new Error('Choose a dedicated output directory');
const snapshotText = await readFile(snapshotPath, 'utf8');
const snapshot = JSON.parse(snapshotText);
if (snapshot.kind !== 'ai-usage-synthetic-only') throw new Error('Only synthetic snapshots may be packaged');
const includedModules = new Set();
const result = await build({
  root, configFile: false, envFile: false, envDir: false, publicDir: false,
  plugins: [react(), {
    name: 'offline-report-client', enforce: 'pre',
    resolveId(id, importer) {
      if (importer?.includes('/src/components/ai-usage/') && id === './client') return path.join(root, 'scripts/offline-ai-usage/client.ts');
      if (importer?.includes('/src/components/ai-usage/') && id === '../../shared/view/ui') return path.join(root, 'src/shared/view/ui/Button.tsx');
      return null;
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) if (output.type === 'chunk') {
        for (const [id, module] of Object.entries(output.modules)) if (module.renderedLength > 0) includedModules.add(id.split('?')[0]);
      }
    },
  }],
  define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { '@': path.join(root, 'src') } },
  build: {
    write: false, target: 'es2022', cssCodeSplit: false, minify: 'esbuild',
    lib: { entry: path.join(root, 'scripts/offline-ai-usage/entry.tsx'), name: 'OfflineAiUsage', formats: ['iife'] },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
const chunks = outputs.filter((item) => item.type === 'chunk');
if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) throw new Error('Offline page must have exactly one standalone script');
const css = outputs.filter((item) => item.type === 'asset' && item.fileName.endsWith('.css')).map((item) => item.source).join('\n');
const unexpectedAssets = outputs.filter((item) => item.type === 'asset' && !item.fileName.endsWith('.css'));
if (unexpectedAssets.length) throw new Error('Unexpected external assets: ' + unexpectedAssets.map((item) => item.fileName).join(','));
const sql = await readFile(sqlPath, 'utf8');
let sqlLicensePath = path.resolve(path.dirname(sqlPath), '../LICENSE-SQLJS');
try { await stat(sqlLicensePath); } catch { sqlLicensePath = path.resolve(path.dirname(sqlPath), '../LICENSE'); }
const scriptSafe = (text) => text.replace(/<\/script/gi, '<\\/script');
let html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>AI 看板 · 单文件离线版</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head>
<body><div id="root"><p style="padding:24px">正在初始化离线模拟报表…</p></div><noscript>请使用启用 JavaScript 的浏览器打开本文件。</noscript>
<script id="offline-snapshot" type="application/json">${snapshotText.replaceAll('<', '\\u003c')}</script>
<!--OFFLINE_EMBEDDED_PACKAGE-->
<script>${scriptSafe(sql)}</script><script>${scriptSafe(chunks[0].code)}</script>
</body></html>`;
await mkdir(destination, { recursive: true });
const readme = `AI 统计报表 — 离线模拟演示

使用方法
1. 将单个 HTML 文件复制到另一台电脑，无需其他配套文件；若收到 ZIP，先解压再打开。
2. 双击 HTML 文件；如果系统没有自动用浏览器打开，请右键选择 Chrome、Edge、Firefox 或 Safari。
3. 无需安装 Node.js、数据库或其他软件；不需要联网，也不需要启动服务器。
   index.html 自带页面、样式、模拟数据和查询引擎，单独复制这个文件也能使用。

包含功能
- AI 使用、代码产出、Skill 发布与调用、Hook 执行统计、Hook 业务统计、Agent 模板使用六个 Tab。
- 日期、用户名、工作区名称及各表的名称筛选；分组、排序和分页。
- Skill 发布与调用可按 Skill 或发布者分组；AI 使用页仅展示使用指标。
- Agent 模板页先比较模板，点击“查看使用分析”后，在弹窗中按用户/工作区/日/周/月分组。
- Agent 模板只保留活跃使用人数和会话次数；按用户查看时隐藏重复的人数列，合计保留。
- 按对象和按时间分开展示，时间粒度支持按天/按周/按月，周及部分月份显示实际日期范围。
- 代码产出：生成量仅汇总 SQL Hook 的 sqlLineCount，CodeHub 提交量是单独的模拟记录，无占比指标。
- Hook 业务统计：先进入某个 Hook 的统计弹窗，再筛选并按用户/工作区/日/周/月/整体统计。
- number 字段可选求和、平均值、最小值、最大值；统计覆盖筛选后的全部记录，不限当前页。
- 各表的“导出当前统计”可离线下载 CSV，导出当前已应用筛选和分组下的全部匹配结果，不限当前页。
- 切换 Tab 保留各自的分组、名称筛选、排序和分页；更改公共筛选或批次时页码回到第一页。
- 顶部四张概览卡固定口径，不受下方交互筛选影响。
- 深浅色切换、模拟空租户/普通用户权限状态。

快速验证示例
Hook 业务统计 → SQL 产出记录 → 进入统计 → 数值字段选“SQL 行数”。
默认日期范围 2026-08-14 至 2026-09-12；按用户分组可看每个人的 SQL 行数。
用户名填“模拟用户 07”、工作区名称填“模拟工作区 2”并应用：共 10 条记录，
求和 360、平均值 36、最小值 16、最大值 56。统计结果不额外追加单位。

边界说明
- 包含专门生成的 3,556 条模拟业务数据及其统计结果，另有 1,200 条确定性 CodeHub 提交演示记录；均不是真实业务报表。
- 模拟数据截至 2026-09-12；不自动接收真实数据、夜间更新或运行后台异步导出任务。页面直接下载 CSV 不受此限制。
- 刷新只会重新读取本地快照，关闭/重新打开会恢复默认筛选。
- 普通用户选项用于展示权限不足状态；查看完整演示请选择“租户管理员”。
- 页面通过安全策略禁止网络连接。它不依赖 127.0.0.1:4401 或原电脑在线。
- “离线说明”中可下载内嵌的统计口径及相关源码/许可；其中生产系统定时任务描述在离线版中不运行。

目录
index.html：双击打开的完整演示。
统计口径说明.md：统计定义和边界，可用文本编辑器打开。
source/：本离线版本的相关源码、已生成模拟快照和构建依赖清单（仅供开发者使用）。
LICENSE、THIRD-PARTY-NOTICES.txt：开源许可说明。
manifest.json：数据版本、体积和 SHA-256 校验。

本离线封装沿用项目 AGPL-3.0-or-later 许可；附相关源码及第三方许可。
`;
await writeFile(path.join(destination, '使用说明.txt'), readme);
await copyFile(path.join(root, 'docs/ai-usage-metric-definitions.md'), path.join(destination, '统计口径说明.md'));
await copyFile(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));

// Include corresponding source for this narrowly scoped program, never a whole
// working tree, .env, credentials, business database, or unrelated source files.
const sourceRoot = path.join(destination, 'source');
const sourceFiles = new Set([...includedModules].filter((file) => file.startsWith(root) && !file.includes('/node_modules/')));
for (const name of await readdir(path.join(root, 'src/components/ai-usage'))) sourceFiles.add(path.join(root, 'src/components/ai-usage', name));
for (const name of ['build.mjs', 'entry.tsx', 'client.ts', 'database.mjs', 'service.mjs']) sourceFiles.add(path.join(root, 'scripts/offline-ai-usage', name));
for (const name of ['src/index.css', 'tailwind.config.js', 'postcss.config.js', 'LICENSE', 'docs/ai-usage-metric-definitions.md']) sourceFiles.add(path.join(root, name));
for (const file of sourceFiles) {
  if (!(await stat(file)).isFile()) continue;
  const targetFile = path.join(sourceRoot, path.relative(root, file));
  await mkdir(path.dirname(targetFile), { recursive: true });
  await copyFile(file, targetFile);
}
await mkdir(path.join(sourceRoot, 'vendor'), { recursive: true });
await copyFile(sqlPath, path.join(sourceRoot, 'vendor/sql-asm.js'));
await copyFile(snapshotPath, path.join(sourceRoot, 'snapshot.json'));
const dependencyNames = ['react', 'react-dom', 'i18next', 'react-i18next', 'lucide-react', 'class-variance-authority', 'clsx', 'tailwind-merge',
  'vite', '@vitejs/plugin-react', 'tailwindcss', '@tailwindcss/typography', 'postcss', 'autoprefixer', 'jszip'];
const dependencies = {};
let notices = 'Offline AI Usage Report\nProject: AGPL-3.0-or-later (see LICENSE).\nSQLite: public domain. SQL.js: MIT.\n';
const packageRoots = new Set();
for (const file of includedModules) {
  if (!file.includes('/node_modules/')) continue;
  let directory = path.dirname(file);
  while (directory.includes('/node_modules')) {
    try { await stat(path.join(directory, 'package.json')); packageRoots.add(directory); break; } catch { directory = path.dirname(directory); }
  }
}
for (const name of dependencyNames) {
  let directory = path.dirname(require.resolve(name));
  let pkg;
  while (directory !== path.dirname(directory)) {
    try {
      const candidate = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (candidate.name === name) { pkg = candidate; break; }
    } catch { /* Search the enclosing package root when exports hide package.json. */ }
    directory = path.dirname(directory);
  }
  if (!pkg) throw new Error(`Package metadata unavailable: ${name}`);
  dependencies[name] = pkg.version;
  packageRoots.add(directory);
}
for (const directory of packageRoots) {
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  notices += `\n\n--- ${pkg.name} ${pkg.version} (${pkg.license || 'see license'}) ---\n`;
  for (const name of await readdir(directory)) if (/^(licen[sc]e|notice|copyright)(\.|$)/i.test(name) && (await stat(path.join(directory, name))).isFile()) notices += await readFile(path.join(directory, name), 'utf8') + '\n';
}
notices += '\n\n--- SQL.js 1.13.0 ---\n' + await readFile(sqlLicensePath, 'utf8');
await writeFile(path.join(destination, 'THIRD-PARTY-NOTICES.txt'), notices);
await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'ai-report-offline-source', private: true, type: 'module', license: 'AGPL-3.0-or-later', scripts: { build: 'node scripts/offline-ai-usage/build.mjs snapshot.json vendor/sql-asm.js ../rebuilt-offline' }, dependencies }, null, 2));
await writeFile(path.join(sourceRoot, 'README.md'), '# 离线版本源码\n\n普通使用只需打开上一级 index.html。开发者重新构建需 Node.js 22.12+：先 npm install，再 npm run build。联网仅用于安装开发依赖，成品无需联网。snapshot.json 是固定模拟快照，不读取业务库。源码客户端通过构建插件替换为本地查询。\n');
// Retain the vendored SQL.js license in the same relative location for rebuilds.
await copyFile(sqlLicensePath, path.join(sourceRoot, 'LICENSE-SQLJS'));
// Embed the optional documentation/source companion as well: the one delivered
// HTML remains complete even when no sibling files or original computer exist.
const embeddedZip = new JSZip();
async function collectDirectory(zipFile, directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${item.name}`;
    if (item.isDirectory()) await collectDirectory(zipFile, path.join(directory, item.name), `${name}/`);
    else if (item.isFile()) zipFile.file(name, await readFile(path.join(directory, item.name)));
  }
}
await collectDirectory(embeddedZip, sourceRoot, 'source/');
for (const name of ['使用说明.txt', '统计口径说明.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) embeddedZip.file(name, await readFile(path.join(destination, name)));
const embeddedSource = await embeddedZip.generateAsync({ type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 9 } });
const packageData = JSON.stringify({ definitions: await readFile(path.join(destination, '统计口径说明.md'), 'utf8'), sourceZip: embeddedSource }).replaceAll('<', '\\u003c');
html = html.replace('<!--OFFLINE_EMBEDDED_PACKAGE-->', `<script id="offline-package" type="application/json">${packageData}</script>`);
await writeFile(path.join(destination, 'index.html'), html);
const manifest = { kind: snapshot.kind, packagedAt: new Date().toISOString(), dataThrough: snapshot.dataThrough, counts: snapshot.counts,
  entry: 'index.html', bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex'), offline: true, networkRequired: false, singleFile: true, embeddedSource: true };
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
const zip = new JSZip();
await collectDirectory(zip, destination);
const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
await writeFile(`${destination}.zip`, archive);
console.log(JSON.stringify({ directory: destination, zip: `${destination}.zip`, zipBytes: archive.length, ...manifest }, null, 2));
