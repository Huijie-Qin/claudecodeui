import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const bundle = fileURLToPath(new URL('../examples/report-quality/', import.meta.url));
const checker = '.claude/skills/check-html-report/scripts/check_report.py';
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'report-quality-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.cp(bundle, workspace, { recursive: true });
  const reference = await fs.readFile(path.join(workspace, 'reports/example.html'), 'utf8');
  const source = JSON.parse(await fs.readFile(path.join(workspace, 'reports/data.json'), 'utf8'));
  let report = reference;
  for (const [key, value] of Object.entries(source.fields)) {
    report = report.replace(new RegExp(`(data-field="${key}">)[^<]*(<)`), `$1${escapeHtml(value)}$2`);
  }
  report = report.replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>${source.tables['regional-results'].rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody>`);
  const reportPath = path.join(workspace, 'reports/report.html');
  const writeReport = (text = report) => fs.writeFile(reportPath, text);
  const execute = async (token = 'challenge-1') => {
    let stdout, code = 0;
    try {
      ({ stdout } = await run(process.env.PYTHON || 'python3', [checker, '--config', '.ccui/report-quality.json', '--session-id', 'session-123', '--attempt-token', token], { cwd: workspace }));
    } catch (error) {
      if (!error.stdout) throw error;
      stdout = error.stdout;
      code = error.code;
    }
    return { result: JSON.parse(stdout), code };
  };
  return { workspace, reference, source, report, reportPath, writeReport, execute };
}

test('the bundle starts without a report and the checker cannot pass missing output', async (t) => {
  const { workspace, execute } = await fixture(t);
  const { result, code } = await execute();
  assert.equal(code, 1);
  assert.equal(result.passed, false);
  assert.equal(result.fingerprints.report, null);
  await assert.rejects(fs.stat(path.join(workspace, 'reports/report.html')), { code: 'ENOENT' });
});

test('a real report moves from incomplete to passed after repair, with all six raw-file hashes', async (t) => {
  const { workspace, report, writeReport, execute } = await fixture(t);
  await writeReport(report.replace(/<section id="overview"[\s\S]*?<\/section>/, ''));
  const initial = await execute();
  assert.equal(initial.result.passed, false);
  assert.equal(initial.result.checks.structure, false);
  assert.equal(initial.result.checks.completeness, false);
  await writeReport();
  const { result, code } = await execute('challenge-2');
  assert.equal(code, 0);
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks, { structure: true, completeness: true, data: true });
  assert.equal(result.sessionId, 'session-123');
  assert.equal(result.attemptToken, 'challenge-2');
  const paths = { reference: 'reports/example.html', report: 'reports/report.html', source: 'reports/data.json', config: '.ccui/report-quality.json', checkerSkill: '.claude/skills/check-html-report/SKILL.md', checkerScript: checker };
  for (const [key, relative] of Object.entries(paths)) {
    assert.equal(result.fingerprints[key], hash(await fs.readFile(path.join(workspace, relative))), key);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace, '.ccui/report-quality-result.json'), 'utf8')), result);
});

test('changed current source fails data validation despite matching historical template structure', async (t) => {
  const { workspace, source, writeReport, execute } = await fixture(t);
  await writeReport();
  assert.equal((await execute()).result.passed, true);
  source.fields['total-revenue'] = '9999.00';
  await fs.writeFile(path.join(workspace, 'reports/data.json'), JSON.stringify(source));
  const { result } = await execute();
  assert.equal(result.passed, false);
  assert.equal(result.checks.structure, true);
  assert.equal(result.checks.data, false);
});

test('zero is valid, while blank and technical placeholder cells cannot pass', async (t) => {
  const { report, writeReport, execute } = await fixture(t);
  await writeReport();
  assert.equal((await execute()).result.passed, true);
  for (const cell of ['&nbsp;', 'undefined', 'NaN', 'TODO']) {
    await writeReport(report.replace('<td>0</td>', `<td>${cell}</td>`));
    const { result } = await execute();
    assert.equal(result.passed, false, cell);
    assert.equal(result.checks.completeness, false, cell);
  }
});

test('missing source never passes and changed report bytes produce a different fingerprint', async (t) => {
  const { workspace, report, writeReport, execute } = await fixture(t);
  await writeReport();
  const before = (await execute()).result;
  await writeReport(report + '\n');
  const after = (await execute()).result;
  assert.equal(after.passed, true);
  assert.notEqual(after.fingerprints.report, before.fingerprints.report);
  await fs.rm(path.join(workspace, 'reports/data.json'));
  const missing = (await execute()).result;
  assert.equal(missing.passed, false);
  assert.equal(missing.checks.data, false);
  assert.equal(missing.fingerprints.source, null);
});

test('extra or malformed rows, duplicate fields, and removed template CSS fail', async (t) => {
  const { report, writeReport, execute } = await fixture(t);
  const broken = [
    report.replace('</tbody>', '<tr><td>额外地区</td><td>0</td><td>0</td></tr></tbody>'),
    report.replace('<td>1234.50</td>', ''),
    report.replace('</main>', '<span data-field="total-orders">3</span></main>'),
    report.replace(/<style>[\s\S]*?<\/style>/, ''),
    report.replace('id="overview" class="report-section"', 'id="overview" class="report-section" hidden'),
  ];
  for (const candidate of broken) {
    await writeReport(candidate);
    assert.equal((await execute()).result.passed, false);
  }
});

test('table rowspan expands to the source logical grid rather than silently losing a cell', async (t) => {
  const { workspace, source, report, writeReport, execute } = await fixture(t);
  source.tables['regional-results'].rows = [['华东', '1234.50', 3], ['华东', '0.00', 0]];
  await fs.writeFile(path.join(workspace, 'reports/data.json'), JSON.stringify(source));
  const spanning = report.replace('<td>华东</td>', '<td rowspan="2">华东</td>').replace('<td>华南</td>', '');
  await writeReport(spanning);
  assert.equal((await execute()).result.passed, true);
  await writeReport(spanning.replace('rowspan="2"', 'rowspan="3"'));
  assert.equal((await execute()).result.passed, false);
});

test('empty tables need explicit current-source explanation and keep the required header', async (t) => {
  const { workspace, source, report, writeReport, execute } = await fixture(t);
  source.tables['regional-results'].rows = [];
  source.tables['regional-results'].emptyText = '当前范围内无区域数据';
  await fs.writeFile(path.join(workspace, 'reports/data.json'), JSON.stringify(source));
  const empty = report.replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody></tbody>');
  await writeReport(empty);
  assert.equal((await execute()).result.passed, false);
  await writeReport(empty.replace('</table>', '</table><p data-empty-for="regional-results">当前范围内无区域数据</p>'));
  assert.equal((await execute()).result.passed, true);
});

test('historical reference values are not accepted in place of current-source values', async (t) => {
  const { reference, writeReport, execute } = await fixture(t);
  await writeReport(reference);
  const { result } = await execute();
  assert.equal(result.checks.structure, true);
  assert.equal(result.checks.completeness, true);
  assert.equal(result.checks.data, false);
  assert.equal(result.passed, false);
});

test('a verdict cannot overwrite protected inputs through direct paths, dot aliases, or symlinks', async (t) => {
  const { workspace, writeReport, execute } = await fixture(t);
  await writeReport();
  const configPath = path.join(workspace, '.ccui/report-quality.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const sourceBefore = await fs.readFile(path.join(workspace, 'reports/data.json'));
  const referenceBefore = await fs.readFile(path.join(workspace, 'reports/example.html'));
  const scriptBefore = await fs.readFile(path.join(workspace, checker));
  await fs.symlink('../reports/data.json', path.join(workspace, '.ccui/source-alias.json'));
  for (const verdict of ['reports/example.html', './reports/data.json', 'reports/../reports/example.html', '.ccui/source-alias.json', checker, '.ccui/report-quality.json']) {
    await fs.writeFile(configPath, JSON.stringify({ ...config, verdict }));
    const configBefore = await fs.readFile(configPath);
    const { code, result } = await execute();
    assert.equal(code, 1, verdict);
    assert.equal(result.passed, false, verdict);
    assert.match(result.issues[0].message, /must not overwrite/, verdict);
    assert.deepEqual(await fs.readFile(path.join(workspace, 'reports/data.json')), sourceBefore, verdict);
    assert.deepEqual(await fs.readFile(path.join(workspace, 'reports/example.html')), referenceBefore, verdict);
    assert.deepEqual(await fs.readFile(path.join(workspace, checker)), scriptBefore, verdict);
    assert.deepEqual(await fs.readFile(configPath), configBefore, verdict);
    await assert.rejects(fs.stat(path.join(workspace, '.ccui/report-quality-result.json')), { code: 'ENOENT' });
  }
});

test('inline styles, misplaced classes, layout order, and deleted static paragraphs fail structure', async (t) => {
  const { workspace, report, reference, writeReport, execute } = await fixture(t);
  // Add a static paragraph to both artifacts to establish a template requirement.
  const note = '<p>报表说明：本报告按区域展示经营数据。</p>';
  const referenceWithNote = reference.replace('</main>', `${note}</main>`);
  const reportWithNote = report.replace('</main>', `${note}</main>`);
  await fs.writeFile(path.join(workspace, 'reports/example.html'), referenceWithNote);
  await writeReport(reportWithNote);
  assert.equal((await execute()).result.passed, true);
  const broken = [
    reportWithNote.replace('<body>', '<body style="font-size:1px">'),
    reportWithNote.replace('class="report-header"', 'class="report-header" style="display:flex"'),
    reportWithNote.replace('<main>', '<main class="metrics">').replace('<div class="metrics">', '<div>'),
    reportWithNote.replace('<div class="metrics">', '<article class="metrics">').replace('</div>\n  </section>', '</article>\n  </section>'),
    reportWithNote.replace(note, ''),
    reportWithNote.replace('<td>1234.50</td>', '<td style="font-size:1px">1234.50</td>'),
    reportWithNote.replace('<td>华东</td>', '<td><span>华东</span></td>'),
  ];
  for (const candidate of broken) {
    await writeReport(candidate);
    const { result } = await execute();
    assert.equal(result.passed, false);
    assert.equal(result.checks.structure, false);
  }
});

test('dynamic table row count may change while its template row markup remains intact', async (t) => {
  const { workspace, source, report, writeReport, execute } = await fixture(t);
  source.tables['regional-results'].rows.push(['华北', '0.00', 0]);
  await fs.writeFile(path.join(workspace, 'reports/data.json'), JSON.stringify(source));
  await writeReport(report.replace('</tbody>', '<tr><td>华北</td><td>0.00</td><td>0</td></tr></tbody>'));
  assert.equal((await execute()).result.passed, true);
});

test('an optional checkerScript fingerprints the actual script executed at the configured path', async (t) => {
  const { workspace, writeReport } = await fixture(t);
  await writeReport();
  const configPath = path.join(workspace, '.ccui/report-quality.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const alternative = '.claude/skills/check-html-report/scripts/custom-checker.py';
  await fs.copyFile(path.join(workspace, checker), path.join(workspace, alternative));
  await fs.writeFile(configPath, JSON.stringify({ ...config, checkerScript: alternative }));
  const { stdout } = await run(process.env.PYTHON || 'python3', [alternative, '--config', '.ccui/report-quality.json', '--session-id', 'custom-session', '--attempt-token', 'custom-token'], { cwd: workspace });
  const result = JSON.parse(stdout);
  assert.equal(result.passed, true);
  assert.equal(result.fingerprints.checkerScript, hash(await fs.readFile(path.join(workspace, alternative))));
});

test('the 2 MiB file limit includes both source and config', async (t) => {
  const { workspace, writeReport, execute } = await fixture(t);
  await writeReport();
  await fs.writeFile(path.join(workspace, 'reports/data.json'), ' '.repeat(2 * 1024 * 1024 + 1));
  const sourceFailure = (await execute()).result;
  assert.equal(sourceFailure.passed, false);
  assert.equal(sourceFailure.fingerprints.source, null);
  await fs.writeFile(path.join(workspace, '.ccui/report-quality.json'), ' '.repeat(2 * 1024 * 1024 + 1));
  const configFailure = (await execute()).result;
  assert.equal(configFailure.passed, false);
  assert.match(configFailure.issues[0].message, /2 MiB/);
});
