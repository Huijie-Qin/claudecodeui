import { read, utils, type CellObject } from 'xlsx';

export const SPREADSHEET_MAX_BYTES = 10 * 1024 * 1024;
export const SPREADSHEET_MAX_ROWS = 1000;
export const SPREADSHEET_MAX_COLUMNS = 100;
const MAX_CELL_CHARACTERS = 2000;
const MAX_PREVIEW_CHARACTERS = 2_000_000;

export type SpreadsheetSheetPreview = {
  name: string;
  index: number;
  rows: string[][];
  columnLabels: string[];
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
  hasUncachedFormulas: boolean;
};

export function getSpreadsheetSheetNames(buffer: ArrayBuffer): string[] {
  if (buffer.byteLength > SPREADSHEET_MAX_BYTES) throw new Error('文件超过 10 MB 预览上限，请下载原文件查看。');
  // XLSX is a ZIP container. Reject encrypted Office containers and disguised text files.
  const signature = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4));
  if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
    throw new Error('无法读取此 xlsx 文件：文件可能已损坏、加密，或格式不受支持。');
  }
  const workbook = read(buffer, { type: 'array', bookSheets: true, bookProps: false });
  if (!workbook.SheetNames?.length) throw new Error('此文件没有可预览的工作表。');
  return workbook.SheetNames;
}

/** Parse only the requested worksheet and cap rows before building the display grid. */
export function getSpreadsheetSheetPreview(buffer: ArrayBuffer, index: number, sheetNames: string[]): SpreadsheetSheetPreview {
  if (!Number.isInteger(index) || index < 0 || index >= sheetNames.length) throw new Error('工作表不存在。');
  const workbook = read(buffer, {
    type: 'array', sheets: index, sheetRows: SPREADSHEET_MAX_ROWS,
    cellHTML: false, cellText: true, cellFormula: true, cellStyles: false,
    bookVBA: false, cellDates: false,
  });
  const name = sheetNames[index];
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error('无法读取此工作表。');
  const range = sheet['!fullref'] || sheet['!ref'];
  const bounds = range ? utils.decode_range(range) : null;
  const totalRows = bounds ? bounds.e.r + 1 : 0;
  const totalColumns = bounds ? bounds.e.c + 1 : 0;
  const rowCount = Math.min(totalRows, SPREADSHEET_MAX_ROWS);
  const columnCount = Math.min(totalColumns, SPREADSHEET_MAX_COLUMNS);
  let truncated = totalRows > rowCount || totalColumns > columnCount;
  let hasUncachedFormulas = false;
  let characters = 0;
  const rows = Array.from({ length: rowCount }, (_, row) => (
    Array.from({ length: columnCount }, (_, column) => {
      const cell = sheet[utils.encode_cell({ r: row, c: column })] as CellObject | undefined;
      if (!cell) return '';
      let value: string;
      if (cell.f && cell.v == null) {
        hasUncachedFormulas = true;
        value = `=${cell.f}`;
      } else {
        value = cell.w ?? utils.format_cell(cell);
      }
      const remaining = Math.max(0, Math.min(MAX_CELL_CHARACTERS, MAX_PREVIEW_CHARACTERS - characters));
      if (value.length > remaining) {
        value = `${value.slice(0, remaining)}…`;
        truncated = true;
      }
      characters += value.length;
      return value;
    })
  ));
  return {
    name, index, rows, totalRows, totalColumns, truncated, hasUncachedFormulas,
    columnLabels: Array.from({ length: columnCount }, (_, column) => utils.encode_col(column)),
  };
}
