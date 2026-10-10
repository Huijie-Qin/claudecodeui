import type { WorkbookSheet } from './reportWorkbook';

const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const span = (value: unknown) => Math.max(0, ...String(value ?? '').split('\n').map(line => [...line]
  .reduce((size, char) => size + (char.charCodeAt(0) > 255 ? 2 : 1), 0)));

// SheetJS CE writes typed, literal values but not cell borders or frozen panes.
// Add only a plain grid and necessary date formats to our own generated OOXML.
// Never reserialize untrusted cell values or treat text as formulas.
const xf = (borderId: number, numFmtId = 0, information = false) =>
  `<xf numFmtId="${numFmtId}" fontId="0" fillId="0" borderId="${borderId}" xfId="0" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment ${information ? 'horizontal="left" vertical="top"' : 'vertical="center"'} wrapText="1"/></xf>`;
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${namespace}">
<numFmts count="2"><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>
<fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Arial"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border/><border>${['left', 'right', 'top', 'bottom'].map(edge => `<${edge} style="thin"><color rgb="FF000000"/></${edge}>`).join('')}</border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">${xf(0)}${xf(1)}${xf(1, 165)}${xf(1, 166)}${xf(1, 0, true)}</cellXfs>
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

    const sourceHeader = sheet.detailHeaderRow ?? sheet.headerRows[0];
    const sections = new Set(sheet.sectionRows);
    const sourceDates = new Map((sheet.dateCells || []).map(date => [`${date.row}:${date.col}`, date.dateOnly]));
    const infoValue = (r: number, c: number) => {
      const value = sheet.rows[r]?.[c];
      if (typeof value === 'number' && sourceDates.has(`${r}:${c}`)) {
        return XLSX.SSF.format(sourceDates.get(`${r}:${c}`) ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss', value);
      }
      return String(value ?? '');
    };
    const information: string[] = [];
    const informationHeaders = new Set([...(sheet.metadataHeaderRows || []), ...(sheet.summaryHeaderRows || [])]);
    for (let r = 0; r < sourceHeader; r++) {
      if (sections.has(r) || !sheet.rows[r].length) continue;
      if (informationHeaders.has(r) && r + 1 < sourceHeader) {
        information.push(sheet.rows[r].map((label, c) => `${label}：${infoValue(r + 1, c)}`).join('；'));
        r++;
      } else {
        // The overview and older layouts store metadata as label/value pairs.
        const parts: string[] = [];
        for (let c = 0; c < sheet.rows[r].length; c += 2) {
          parts.push(`${infoValue(r, c)}${c + 1 < sheet.rows[r].length ? `：${infoValue(r, c + 1)}` : ''}`);
        }
        information.push(parts.join('；'));
      }
    }
    const infoText = information.join('\n');
    if (infoText.length > 32767) throw new Error('exportTooLarge');
    const hasInformation = Boolean(infoText);
    const firstSourceRow = hasInformation ? sourceHeader : 0;
    const width = sheet.rows.slice(firstSourceRow).reduce((n, row) => Math.max(n, row.length), 1);
    // Size columns from the detail table, not from the combined information.
    const widths = Array<number>(width).fill(18);
    for (let r = firstSourceRow; r < sheet.rows.length; r++) {
      if (sections.has(r)) continue;
      for (const [c, value] of sheet.rows[r].entries()) {
        const key = `${r}:${c}`;
        const length = sourceDates.has(key) ? sourceDates.get(key) ? 14 : 24 : span(value) + 4;
        widths[c] = Math.min(48, Math.max(widths[c], length));
      }
    }
    // Excel does not reliably AutoFit merged cells. Persist enough height for
    // explicit line breaks and wrapping, with space for font fallback on Windows.
    const infoLineWidth = Math.max(1, (widths.reduce((sum, value) => sum + value, 0) - 4) * 0.9);
    const infoHeight = hasInformation ? infoText.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(span(line) / infoLineWidth)), 0) * 18 + 12 : 0;
    // Very long filters still occupy one merged cell, across more than one row
    // if necessary, instead of clipping at Excel's per-row height limit.
    const infoRows = Math.ceil(infoHeight / 400);
    const rows: WorkbookSheet['rows'] = Array.from({ length: infoRows }, (_, r) => r === 0 ? [infoText] : []);
    const rowMap = new Map<number, number>();
    for (const [r, row] of sheet.rows.entries()) {
      if (r < firstSourceRow || sections.has(r)) continue;
      const isDetail = sheet.detailHeaderRow != null && r > sheet.detailHeaderRow
        && r <= sheet.detailHeaderRow + (sheet.detailRowCount ?? 0);
      if (!isDetail && !row.length && (!rows.length || !rows.at(-1)!.length)) continue;
      rowMap.set(r, rows.length);
      rows.push([...row]);
    }
    if (!rows.length) rows.push([]);
    const dates = new Map<string, boolean>();
    for (const { row, col, dateOnly } of sheet.dateCells || []) {
      const r = rowMap.get(row);
      if (r == null) continue;
      const address = XLSX.utils.encode_cell({ r, c: col });
      const value = rows[r]?.[col];
      if (dateOnly && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const milliseconds = Date.parse(`${value}T00:00:00Z`);
        if (Number.isFinite(milliseconds)) rows[r][col] = milliseconds / 86_400_000 + 25569;
      }
      if (typeof rows[r]?.[col] === 'number') dates.set(address, Boolean(dateOnly));
    }
    const mainHeader = rowMap.get(sourceHeader);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: width - 1 } });
    if (hasInformation && (width > 1 || infoRows > 1)) ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: infoRows - 1, c: width - 1 } }];
    ws['!cols'] = widths.map(wch => ({ wch }));
    ws['!rows'] = rows.map((row, r) => {
      if (r < infoRows) return { hpt: Math.ceil(infoHeight / infoRows) };
      const lines = row.reduce<number>((n, value, c) => Math.max(n, Math.ceil(span(value) / Math.max(1, widths[c] - 3)), String(value ?? '').split('\n').length), 1);
      return { hpt: Math.min(409, Math.max(20, lines * 15 + 5)) };
    });
    const cells = new Map<string, number>();
    const blankCells = new Set<string>();
    for (const [r, row] of rows.entries()) {
      // Border the entire used rectangle, including missing values, unused
      // summary cells and separators. Do not format millions of empty rows.
      for (let c = 0; c < width; c++) {
        const address = XLSX.utils.encode_cell({ r, c });
        if (row[c] == null) {
          ws[address] = { t: 's', v: '' };
          blankCells.add(address);
        }
        cells.set(address, hasInformation && r === 0 && c === 0 ? 4 : dates.has(address) ? dates.get(address) ? 2 : 3 : 1);
      }
    }
    if (mainHeader != null && (sheet.detailRowCount ?? 0) > 0) {
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: mainHeader, c: 0 },
        e: { r: mainHeader + sheet.detailRowCount!, c: sheet.rows[sourceHeader].length - 1 } }) };
    }
    ws['!margins'] = { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 };
    const quotedName = `'${name.replace(/'/g, "''")}'`;
    book.Workbook.Names!.push({ Name: '_xlnm.Print_Area', Sheet: index, Ref: `${quotedName}!$A$1:$${XLSX.utils.encode_col(width - 1)}$${rows.length}` });
    if (sheet.detailHeaderRow != null && mainHeader != null) book.Workbook.Names!.push({ Name: '_xlnm.Print_Titles', Sheet: index, Ref: `${quotedName}!$${mainHeader + 1}:$${mainHeader + 1}` });
    layouts.push({ styles: cells, blankCells, freeze: sheet.detailHeaderRow != null && mainHeader != null && rows.length > 25 ? mainHeader + 1 : 0, columns: width });
    XLSX.utils.book_append_sheet(book, ws, name);
  }
  const zip = await JSZip.loadAsync(XLSX.write(book, { bookType: 'xlsx', type: 'array' }));
  zip.file('xl/styles.xml', styles);
  for (const [index, layout] of layouts.entries()) {
    const path = `xl/worksheets/sheet${index + 1}.xml`;
    const part = zip.file(path);
    if (!part) throw new Error('exportFailed');
    let xml = await part.async('string');
    // SheetJS adds xml:space to enclosing row/c/v tags when a value contains
    // line breaks. SpreadsheetML permits it on text runs, not these elements;
    // remove only those attributes and leave the actual string untouched.
    xml = xml.replace(/<(?:row|c|v)\b[^>]*>/g, tag => tag.replace(/\s+xml:space="preserve"/g, ''));
    // A bordered missing value must remain truly blank, not zero or a string
    // that Excel COUNTA would count as a populated cell.
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
    const view = `<sheetViews><sheetView showGridLines="1" workbookViewId="0">${layout.freeze
      ? `<pane ${frozenColumn ? 'xSplit="1" ' : ''}ySplit="${layout.freeze}" topLeftCell="${firstCell}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${firstCell}" sqref="${firstCell}"/>`
      : '<selection activeCell="A1" sqref="A1"/>'}</sheetView></sheetViews>`;
    xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, view);
    xml = xml.replace(/(<worksheet\b[^>]*>)/, '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    // Excel requires pageSetup after pageMargins and before ignoredErrors.
    const pageMargins = /<pageMargins\b[^>]*\/>/.exec(xml)?.[0];
    if (!pageMargins) throw new Error('exportFailed');
    xml = xml.replace(pageMargins, `${pageMargins}<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>`);
    zip.file(path, xml);
  }
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}
