import assert from 'node:assert/strict';
import test from 'node:test';

import { utils, write, type WorkSheet } from 'xlsx';

import { getSpreadsheetSheetNames, getSpreadsheetSheetPreview, SPREADSHEET_MAX_BYTES } from './spreadsheetPreviewModel';

function workbook(...sheets: [string, WorkSheet][]): ArrayBuffer {
  const book = utils.book_new();
  for (const [name, sheet] of sheets) utils.book_append_sheet(book, sheet, name);
  return write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

test('xlsx preview preserves sheet names, formatted values, empty cells and cached formula results', () => {
  const sheet = utils.aoa_to_sheet([
    ['名称', '金额', '比例', '日期', '启用', '公式', '备注'],
    ['示例', 1234.5, 0.125, 45292, true, null, '<script>alert(1)</script>'],
    ['空白', null, 0, null, false],
  ]);
  sheet.B2.z = '#,##0.00';
  sheet.C2.z = '0.0%';
  sheet.D2.z = 'yyyy-mm-dd';
  sheet.F2 = { t: 'n', f: 'SUM(B2,1)', v: 1235.5 };
  const data = workbook(['经营数据', sheet], ['空表', {}]);
  const names = getSpreadsheetSheetNames(data);
  assert.deepEqual(names, ['经营数据', '空表']);
  const preview = getSpreadsheetSheetPreview(data, 0, names);
  assert.deepEqual(preview.columnLabels, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.deepEqual(preview.rows[1], ['示例', '1,234.50', '12.5%', '2024-01-01', 'TRUE', '1235.5', '<script>alert(1)</script>']);
  assert.equal(preview.rows[2][1], '');
  assert.equal(preview.rows[2][2], '0');
  assert.equal(preview.rows[2][4], 'FALSE');
  assert.equal(preview.truncated, false);
  assert.equal(preview.hasUncachedFormulas, false);
  const empty = getSpreadsheetSheetPreview(data, 1, names);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.totalRows, 0);
});

test('formula without a saved result is shown as a formula instead of fabricated output', () => {
  const data = workbook(['Sheet1', { A1: { t: 'n', f: '1+2' }, '!ref': 'A1' }]);
  const preview = getSpreadsheetSheetPreview(data, 0, getSpreadsheetSheetNames(data));
  assert.equal(preview.rows[0][0], '=1+2');
  assert.equal(preview.hasUncachedFormulas, true);
});

test('large ranges are bounded with actual extent and Excel column labels retained', () => {
  const sheet = utils.aoa_to_sheet([['start']]);
  sheet.CV1100 = { t: 's', v: 'outside preview' };
  sheet['!ref'] = 'A1:CV1100';
  const data = workbook(['宽表', sheet]);
  const preview = getSpreadsheetSheetPreview(data, 0, getSpreadsheetSheetNames(data));
  assert.equal(preview.rows.length, 1000);
  assert.equal(preview.rows[0].length, 100);
  assert.equal(preview.columnLabels.at(-1), 'CV');
  assert.equal(preview.totalRows, 1100);
  assert.equal(preview.totalColumns, 100);
  assert.equal(preview.truncated, true);
});

test('column limit and long-cell truncation are visible, and leading rows keep their coordinates', () => {
  const data = workbook(['Sheet1', {
    C3: { t: 's', v: '位置正确' },
    A4: { t: 's', v: 'x'.repeat(2100) },
    DF4: { t: 's', v: 'outside columns' },
    '!ref': 'A1:DF4',
  }]);
  const preview = getSpreadsheetSheetPreview(data, 0, getSpreadsheetSheetNames(data));
  assert.equal(preview.totalColumns, 110);
  assert.equal(preview.columnLabels.length, 100);
  assert.equal(preview.rows[0][0], '');
  assert.equal(preview.rows[2][2], '位置正确');
  assert.equal(preview.rows[3][0], `${'x'.repeat(2000)}…`);
  assert.equal(preview.truncated, true);
});

test('invalid, disguised text, encrypted and over-limit workbooks fail clearly', () => {
  for (const data of [new ArrayBuffer(0), new TextEncoder().encode('a,b\n1,2').buffer, new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer]) {
    assert.throws(() => getSpreadsheetSheetNames(data), /损坏、加密/);
  }
  assert.throws(() => getSpreadsheetSheetNames(new ArrayBuffer(SPREADSHEET_MAX_BYTES + 1)), /10 MB/);
  const data = workbook(['Sheet1', {}]);
  assert.throws(() => getSpreadsheetSheetPreview(data, 2, ['Sheet1']), /不存在/);
});
