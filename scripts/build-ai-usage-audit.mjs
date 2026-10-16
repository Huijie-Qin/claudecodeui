#!/usr/bin/env node
// Build the read-only audit as a standalone ESM file. No service modules are
// imported at execution time; the server's native better-sqlite3 remains external.
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: {
  'out-dir': { type: 'string' }, esbuild: { type: 'string' },
  'with-tests': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log(`Build the standalone read-only AI usage audit.

node scripts/build-ai-usage-audit.mjs [--out-dir artifacts/ai-usage-audit-v4] [--with-tests]

Requires esbuild in development dependencies; --esbuild /absolute/esbuild/lib/main.js
can select an existing build dependency. The deployed audit only needs Node.js and
the server's better-sqlite3 package, never esbuild or server/services source files.`);
} else {
  const outDir = path.resolve(values['out-dir'] || path.join(root, 'artifacts/ai-usage-audit-v4'));
  const outputName = 'audit-ai-usage-user.mjs';
  const auditOutput = path.join(outDir, outputName);
  if (auditOutput === path.join(root, 'scripts', outputName)) {
    throw new Error('Output directory must not overwrite the source audit script');
  }
  let esbuildPath = values.esbuild ? path.resolve(values.esbuild) : null;
  if (!esbuildPath) {
    try { esbuildPath = require.resolve('esbuild'); }
    catch {
      // Vite also supplies esbuild when dependency installation is not hoisted.
      try { esbuildPath = createRequire(require.resolve('vite')).resolve('esbuild'); }
      catch { throw new Error('Install development dependencies or pass --esbuild /absolute/esbuild/lib/main.js'); }
    }
  }
  const esbuild = await import(pathToFileURL(esbuildPath).href);
  const shared = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm',
    target: 'node20', packages: 'external', minify: false, legalComments: 'inline',
    write: false, metafile: true };
  function validateImports(result, allowAuditImport = false) {
    for (const output of Object.values(result.metafile.outputs)) {
      for (const dependency of output.imports) {
        const allowed = dependency.path.startsWith('node:') || dependency.path === 'better-sqlite3'
          || (allowAuditImport && dependency.path === `./${outputName}`);
        if (!dependency.external || !allowed) throw new Error(`Unexpected delivery dependency: ${dependency.path}`);
      }
    }
  }
  const audit = await esbuild.build({ ...shared, entryPoints: ['scripts/audit-ai-usage-user.mjs'],
    outfile: auditOutput,
    banner: { js: '// CCUI AI usage audit standalone delivery v4.\n// Repository calculation modules are bundled; only Node.js and better-sqlite3 are external.\n// Read-only: no application database initialization, migrations, or report writes.' },
  });
  validateImports(audit);
  const results = [audit];
  if (values['with-tests']) {
    const tests = await esbuild.build({ ...shared, entryPoints: ['scripts/audit-ai-usage-user.test.mjs'],
      outfile: path.join(outDir, 'audit-ai-usage-user.test.mjs'),
      plugins: [{ name: 'test-delivered-audit', setup(build) {
        build.onResolve({ filter: /^\.\/audit-ai-usage-user\.mjs$/ },
          () => ({ path: `./${outputName}`, external: true }));
      } }],
    });
    validateImports(tests, true);
    results.push(tests);
  }
  await mkdir(outDir, { recursive: true });
  const files = [];
  for (const result of results) {
    for (const file of result.outputFiles) {
      await writeFile(file.path, file.contents);
      files.push({ path: path.basename(file.path), bytes: file.contents.length,
        sha256: createHash('sha256').update(file.contents).digest('hex') });
    }
  }
  await chmod(auditOutput, 0o755);
  const inputs = [];
  for (const input of Object.keys(audit.metafile.inputs)) {
    inputs.push({ path: input, sha256: createHash('sha256')
      .update(await readFile(path.resolve(root, input))).digest('hex') });
  }
  const manifest = { deliveryVersion: 4, esbuildVersion: esbuild.version, target: 'node20',
    files, inputs, externalImports: [...new Set(Object.values(audit.metafile.outputs)
      .flatMap(output => output.imports.map(dependency => dependency.path)))].sort() };
  await writeFile(path.join(outDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ directory: outDir, ...manifest }, null, 2));
}
