import type { WorkbookSheet } from './reportWorkbook';

const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const span = (value: unknown) => Math.max(0, ...String(value ?? '').split('\n').map(line => [...line]
  .reduce((size, char) => size + (char.charCodeAt(0) > 255 ? 2 : 1), 0)));

// SheetJS CE serializes literal values reliably but does not write rich cell
// styles or frozen panes. Decorate ONLY our newly created workbook's OOXML,
// using the existing JSZip dependency; never reserialize untrusted cell values.
const font = (color: string, bold = false, size = 11) => `<font><sz val="${size}"/><color rgb="FF${color}"/><name val="Arial"/>${bold ? '<b/>' : ''}</font>`;
const fill = (color: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`;
const border = (color: string) => `<border>${['left', 'right', 'top', 'bottom'].map(edge => `<${edge} style="thin"><color rgb="FF${color}"/></${edge}>`).join('')}</border>`;
const xf = (fontId = 0, fillId = 0, numFmtId = 0, align = 'left', borderId = 0, wrap = true) =>
  `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="${align}" vertical="center" wrapText="${wrap ? 1 : 0}"/></xf>`;
const formats = [
  xf(), xf(3, 0, 0, 'left', 0, false), xf(4), xf(0), xf(1, 2, 0, 'center', 2),
  xf(0, 0, 0, 'left', 1), xf(0, 3, 0, 'left', 1),
  xf(0, 0, 3, 'right', 1, false), xf(0, 3, 3, 'right', 1, false),
  xf(0, 0, 164, 'right', 1, false), xf(0, 3, 164, 'right', 1, false),
  xf(0, 0, 165, 'center', 1, false), xf(0, 3, 165, 'center', 1, false),
  xf(0, 0, 166, 'center', 1, false), xf(0, 3, 166, 'center', 1, false),
  xf(4, 4, 0, 'left', 1), xf(2, 4, 3, 'left', 1, false), xf(2, 4, 164, 'left', 1, false),
  xf(2, 0, 0, 'left', 3, false), xf(0, 0, 0, 'left', 3), xf(0, 0, 165, 'left', 0, false),
];
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${namespace}">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.########"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>
<fonts count="5">${font('243247')}${font('FFFFFF', true)}${font('244CA0', true)}${font('19345B', true, 16)}${font('64748B')}</fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fill('294B7A')}${fill('F4F7FC')}${fill('EDF3FC')}</fills>
<borders count="4"><border/>${border('CAD5E3')}${border('CAD5E3')}<border><bottom style="thin"><color rgb="FFCAD7EB"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${formats.length}">${formats.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/>
</styleSheet>`;

export async function styledWorkbookBytes(sheets: WorkbookSheet[]): Promise<ArrayBuffer> {
  const [XLSX, { default: JSZip }] = await Promise.all([import('xlsx'), import('jszip')]);
  const book = XLSX.utils.book_new();
  const used = new Set<string>();
  const layouts: { styles: Map<string, number>; blankCells: Set<string>; freeze: number; columns: number }[] = [];
  book.Props = { Title: 'AI Reports', Author: 'AI Dashboard' };
  book.Workbook = { Names: [] };
  for (const [index, sheet] of sheets.entries()) {
    const base = sheet.title.replace(/[\[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').slice(0, 31) || 'Report';
    let name = base;
    for (let suffix = 2; used.has(name.toLowerCase()); suffix++) name = `${base.slice(0, 26)} (${suffix})`;
    used.add(name.toLowerCase());
    const width = sheet.rows.reduce((n, row) => Math.max(n, row.length), 1);
    const offset = 3;
    const rows = [[], [sheet.title], Array<string>(width).fill(''), ...sheet.rows.map(row => [...row])];
    const dates = new Map<string, boolean>();
    for (const { row, col, dateOnly } of sheet.dateCells || []) {
      const address = XLSX.utils.encode_cell({ r: row + offset, c: col });
      const value = rows[row + offset]?.[col];
      if (dateOnly && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const milliseconds = Date.parse(`${value}T00:00:00Z`);
        if (Number.isFinite(milliseconds)) rows[row + offset][col] = milliseconds / 86_400_000 + 25569;
      }
      if (typeof rows[row + offset]?.[col] === 'number') dates.set(address, Boolean(dateOnly));
    }
    // Work in loops: spreading 50,000-row datasets into Math.max can overflow.
    const widths = Array<number>(width).fill(18);
    for (const [r, row] of rows.entries()) {
      if (r < offset || sheet.sectionRows?.includes(r - offset)) continue;
      for (const [c, value] of row.entries()) {
        const date = dates.get(XLSX.utils.encode_cell({ r, c }));
        const length = date !== undefined ? date ? 14 : 24 : typeof value === 'number' ? Math.max(16, span(value) + 3) : span(value) + 4;
        widths[c] = Math.min(48, Math.max(widths[c], length));
      }
    }
    const headers = new Set(sheet.headerRows);
    const summaryHeaders = new Set(sheet.summaryHeaderRows);
    const summaryValues = new Set(sheet.summaryHeaderRows?.map(row => row + 1));
    const metadataHeaders = new Set(sheet.metadataHeaderRows);
    const metadataValues = new Set(sheet.metadataHeaderRows?.map(row => row + 1));
    const mainHeader = sheet.detailHeaderRow ?? sheet.headerRows[0];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map(wch => ({ wch }));
    ws['!rows'] = rows.map((row, r) => {
      const sourceRow = r - offset;
      const lines = row.reduce<number>((n, value, c) => Math.max(n, Math.ceil(span(value) / Math.max(1, widths[c] - 3)), String(value ?? '').split('\n').length), 1);
      const hpt = offset && r === 0 ? 20 : offset && r === 1 ? Math.max(32, Math.ceil(span(sheet.title) / widths.reduce((a, b) => a + b, 0)) * 22)
        : offset && r === 2 ? 20 : !row.length ? 20 : summaryHeaders.has(sourceRow) ? 24
          : summaryValues.has(sourceRow) ? 32 : sheet.sectionRows?.includes(sourceRow) ? 30
            : headers.has(sourceRow) ? Math.max(30, lines * 16 + 8) : Math.max(25, lines * 15 + 8);
      return { hpt: Math.min(409, hpt) };
    });
    const cells = new Map<string, number>();
    const blankCells = new Set<string>();
    let activeHeader = -1;
    for (const [r, row] of rows.entries()) {
      const sourceRow = r - offset;
      if (sheet.sectionRows?.includes(sourceRow)) activeHeader = -1;
      if (headers.has(sourceRow)) activeHeader = sourceRow;
      const band = activeHeader >= 0 && (sourceRow - activeHeader) % 2 === 0 ? 1 : 0;
      // Materialize visually blank cells only inside real table boundaries so
      // missing values keep their borders without becoming zero or extra columns.
      const tableWidth = activeHeader >= 0 && row.length ? sheet.rows[activeHeader].length
        : summaryValues.has(sourceRow) ? sheet.rows[sourceRow - 1].length : 0;
      for (let c = 0; c < Math.max(row.length, tableWidth); c++) {
        const address = XLSX.utils.encode_cell({ r, c });
        const value = row[c];
        if (value == null) {
          if (c >= tableWidth) continue;
          ws[address] = { t: 's', v: '' };
          blankCells.add(address);
        }
        let style = typeof value === 'number' ? (Number.isInteger(value) ? 7 : 9) + band : 5 + band;
        if (dates.has(address)) style = (dates.get(address) ? 11 : 13) + band;
        if (offset && r === 1) style = 1;
        else if (offset && r === 2) style = 19;
        else if (sheet.sectionRows?.includes(sourceRow)) style = 18;
        else if (headers.has(sourceRow)) style = 4;
        else if (summaryHeaders.has(sourceRow)) style = 15;
        else if (summaryValues.has(sourceRow)) style = typeof value === 'number' && !Number.isInteger(value) ? 17 : 16;
        else if (metadataHeaders.has(sourceRow)) style = 2;
        else if (metadataValues.has(sourceRow)) style = dates.has(address) ? 20 : 3;
        else if (activeHeader < 0) style = dates.has(address) ? 20 : c % 2 === 0 ? 2 : 3;
        cells.set(address, style);
      }
    }
    if (mainHeader != null && (sheet.detailRowCount ?? 0) > 0) {
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: mainHeader + offset, c: 0 },
        e: { r: mainHeader + offset + sheet.detailRowCount!, c: sheet.rows[mainHeader].length - 1 } }) };
    }
    ws['!margins'] = { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 };
    const quotedName = `'${name.replace(/'/g, "''")}'`;
    book.Workbook.Names!.push({ Name: '_xlnm.Print_Area', Sheet: index, Ref: `${quotedName}!$A$1:$${XLSX.utils.encode_col(width - 1)}$${rows.length}` });
    if (sheet.detailHeaderRow != null) book.Workbook.Names!.push({ Name: '_xlnm.Print_Titles', Sheet: index, Ref: `${quotedName}!$${mainHeader! + offset + 1}:$${mainHeader! + offset + 1}` });
    layouts.push({ styles: cells, blankCells, freeze: sheet.detailHeaderRow != null && sheet.rows.length > 25 ? mainHeader + offset + 1 : 0, columns: width });
    XLSX.utils.book_append_sheet(book, ws, name);
  }
  const zip = await JSZip.loadAsync(XLSX.write(book, { bookType: 'xlsx', type: 'array' }));
  zip.file('xl/styles.xml', styles);
  for (const [index, layout] of layouts.entries()) {
    const path = `xl/worksheets/sheet${index + 1}.xml`;
    const part = zip.file(path);
    if (!part) throw new Error('exportFailed');
    let xml = await part.async('string');
    // Keep missing data truly empty in Excel (e.g. COUNTA must not count it),
    // while retaining a serializable cell on which to place the border.
    xml = xml.replace(/<c\b([^>]*)><v><\/v><\/c>/g, (full, attrs: string) => {
      const address = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      return address && layout.blankCells.has(address) ? `<c r="${address}"/>` : full;
    });
    xml = xml.replace(/<c\b([^>]*?)(\/?>)/g, (full, attrs: string, close: string) => {
      const address = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const style = address ? layout.styles.get(address) : undefined;
      return style === undefined ? full : `<c${attrs.replace(/\s+s="\d+"/, '')} s="${style}"${close}`;
    });
    const frozenColumn = layout.freeze && layout.columns > 6;
    const firstCell = `${frozenColumn ? 'B' : 'A'}${layout.freeze + 1}`;
    const pane = frozenColumn ? 'bottomRight' : 'bottomLeft';
    const view = `<sheetViews><sheetView showGridLines="0" workbookViewId="0">${layout.freeze
      ? `<pane ${frozenColumn ? 'xSplit="1" ' : ''}ySplit="${layout.freeze}" topLeftCell="${firstCell}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${firstCell}" sqref="${firstCell}"/>`
      : '<selection activeCell="A1" sqref="A1"/>'}</sheetView></sheetViews>`;
    xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, view);
    const properties = `<sheetPr><tabColor rgb="FF${index === 0 ? '19345B' : '6B8CBF'}"/><pageSetUpPr fitToPage="1"/></sheetPr>`;
    xml = xml.replace(/(<worksheet\b[^>]*>)/, `$1${properties}`);
    // CT_Worksheet is an ordered sequence: pageSetup follows pageMargins and
    // must precede ignoredErrors. Appending it at the end makes Excel repair
    // the workbook even though tolerant readers can still load the values.
    const pageMargins = /<pageMargins\b[^>]*\/>/.exec(xml)?.[0];
    if (!pageMargins) throw new Error('exportFailed');
    xml = xml.replace(pageMargins, `${pageMargins}<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>`);
    zip.file(path, xml);
  }
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}
