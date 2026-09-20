import assert from 'node:assert/strict';
import test from 'node:test';

import { IMAGE_FILE_EXTENSIONS } from '../file-tree/constants/constants';

import { resolveFilePreviewLink } from './filePreviewLinks';

test('local image and workbook links use the supported preview types', () => {
  for (const extension of [...IMAGE_FILE_EXTENSIONS, 'xlsx']) {
    const path = `/workspace/output/preview.${extension.toUpperCase()}`;
    assert.equal(resolveFilePreviewLink(path), path);
  }
});

test('absolute and relative file paths retain their workspace meaning', () => {
  for (const path of ['/Users/demo/project/report.xlsx', '/workspace/chart.png', 'report.xlsx', './output/chart.svg', '../output/chart.webp']) {
    assert.equal(resolveFilePreviewLink(path), path);
  }
  assert.equal(resolveFilePreviewLink('output\\chart.png'), 'output/chart.png');
});

test('encoded Chinese names and spaces are decoded without losing literal filename punctuation', () => {
  assert.equal(resolveFilePreviewLink('/workspace/%E4%B8%AD%E6%96%87%20%E6%8A%A5%E8%A1%A8.xlsx'), '/workspace/中文 报表.xlsx');
  assert.equal(resolveFilePreviewLink('/workspace/销售 报表.xlsx'), '/workspace/销售 报表.xlsx');
  assert.equal(resolveFilePreviewLink('/workspace/chart%23final.png'), '/workspace/chart#final.png');
  assert.equal(resolveFilePreviewLink('/workspace/chart%3Ffinal.png'), '/workspace/chart?final.png');
});

test('link suffixes are excluded from the file path', () => {
  assert.equal(resolveFilePreviewLink('  ./report.xlsx?download=1#Sheet1  '), './report.xlsx');
  assert.equal(resolveFilePreviewLink('chart.png#preview'), 'chart.png');
});

test('external links, schemes, network paths and anchors are never intercepted', () => {
  for (const link of [
    'https://example.com/chart.png', 'HTTP://example.com/report.xlsx', '//example.com/chart.png',
    '\\\\example.com\\chart.png', '/\\example.com/chart.png', 'mailto:chart.png',
    'file:///workspace/report.xlsx', 'javascript:chart.png', 'data:image/png;base64,chart.png',
    'custom:report.xlsx', '#chart.png', '?file=report.xlsx',
    '%68ttps%3A%2F%2Fexample.com/chart.png', '%2F%2Fexample.com/chart.png',
    '%20javascript%3Achart.png', '%20%2F%2Fexample.com/chart.png',
  ]) {
    assert.equal(resolveFilePreviewLink(link), null, link);
  }
});

test('unsupported files, extensionless names and invalid paths keep normal link behavior', () => {
  for (const link of [undefined, '', ' ', 'png', 'xlsx', 'report.xls', 'report.csv', 'report.pdf',
    'chart.png.zip', '/workspace/chart.png/', 'report%ZZ.xlsx', '/workspace/bad%00.xlsx',
    '/workspace/bad\n.xlsx', '/workspace/bad%7F.xlsx']) {
    assert.equal(resolveFilePreviewLink(link), null, String(link));
  }
});
