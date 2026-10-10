import { getSpreadsheetSheetNames, getSpreadsheetSheetPreview } from './spreadsheetPreviewModel';

let buffer: ArrayBuffer | null = null;
let sheetNames: string[] = [];

self.onmessage = (event: MessageEvent<{ type: 'open'; buffer: ArrayBuffer } | { type: 'sheet'; index: number }>) => {
  try {
    const message = event.data;
    if (message.type === 'open') {
      buffer = message.buffer;
      sheetNames = getSpreadsheetSheetNames(buffer);
      self.postMessage({ type: 'loaded', sheetNames, sheet: getSpreadsheetSheetPreview(buffer, 0, sheetNames) });
    } else if (message.type === 'sheet' && buffer) {
      self.postMessage({ type: 'sheet', sheet: getSpreadsheetSheetPreview(buffer, message.index, sheetNames) });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '无法解析此工作簿，请下载原文件查看。' });
  }
};
