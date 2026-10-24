import assert from 'node:assert/strict';
import test from 'node:test';

import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { formatSessionDuration, sessionDetailColumns, sessionDetailSort, sessionSkillNames } from './sessionDetailColumns';
import { workbookSpecs } from './reportWorkbook';
import { SavedReportViews, saveSharedReportFilters } from './savedReportViews';

const t = ((key: string) => key) as TFunction;

test('session detail shows only eight required columns with elapsed active seconds and stable Beijing timestamps', () => {
  const columns = sessionDetailColumns(t);
  assert.deepEqual(columns.map(column => column.key), [
    'userName', 'workspaceName', 'sessionId', 'totalTokens', 'skillList', 'startTime', 'endTime', 'activeDurationSeconds',
  ]);
  for (const [input, expected] of [[3723, '01:02:03'], [90061, '25:01:01'], [0, '00:00:00'], [null, '—'], [-1, '—'], [Number.NaN, '—']] as const) {
    assert.equal(formatSessionDuration(input), expected);
  }
  const row = { startTime: '2026-09-12 09:02:03', endTime: null, activeDurationSeconds: 0 };
  const start = renderToStaticMarkup(createElement('div', null, columns[5].render!(row)));
  assert.match(start, /2026-09-12 09:02:03/);
  assert.match(renderToStaticMarkup(createElement('div', null, columns[6].render!(row))), /—/);
  assert.equal(columns[7].render!(row), '00:00:00');
  const duration = sessionDetailColumns(t, true)[7];
  assert.equal(duration.title, 'sessionDetails.activeDurationSeconds');
  assert.equal(duration.exportValue!({ activeDurationSeconds: 1.25 }), 1.25);
  assert.equal(duration.exportValue!({ activeDurationSeconds: 0 }), 0);
  assert.equal(duration.exportValue!({ activeDurationSeconds: null }), null);
});

test('skill list is deduplicated plain text in display and export, including untrusted names', () => {
  const row = { skillList: [' SQL ', 'SQL', '<img src=x onerror=alert(1)>', '', null, 1] };
  assert.deepEqual(sessionSkillNames(row.skillList), ['SQL', '<img src=x onerror=alert(1)>']);
  const column = sessionDetailColumns(t)[4];
  const html = renderToStaticMarkup(createElement('div', null, column.render!(row)));
  assert.ok(html.includes('SQL\n&lt;img src=x onerror=alert(1)&gt;'));
  assert.doesNotMatch(html, /<img|<script/);
  assert.equal(column.exportValue!(row), 'SQL, <img src=x onerror=alert(1)>');
  assert.equal(column.exportValue!({ skillList: [] }), '');
});

test('session sorting and all-tenant export reuse shared filters without leaking invalid saved sort fields', () => {
  for (const value of [undefined, {}, { sortBy: 'refreshedAt', sortDir: 'asc' }, { sortBy: 'skillList', sortDir: 'asc' }, { sortBy: 'startTime', sortDir: 'invalid' }]) {
    assert.deepEqual(sessionDetailSort(value), { sortBy: 'startTime', sortDir: 'desc' });
  }
  const views = new SavedReportViews();
  saveSharedReportFilters(views, { from: '2026-09-01', to: '2026-09-12', userName: 'alice', workspaceName: 'work' });
  views.set('session-details', { queryKey: 'old', value: { sort: { sortBy: 'totalTokens', sortDir: 'asc' }, page: 4 } });
  const [spec] = workbookSpecs({ tenantId: 'all', batchId: 'snapshot', through: '2026-09-12', views, codeAvailable: true, t });
  assert.equal(spec.endpoint, 'session-details');
  assert.equal(spec.params.tenantId, 'all');
  assert.equal(spec.params.from, '2026-09-01');
  assert.equal(spec.params.userSearch, 'alice');
  assert.equal(spec.params.workspaceSearch, 'work');
  assert.equal(spec.params.sortBy, 'totalTokens');
  assert.equal(spec.params.sortDir, 'asc');
  assert.equal(spec.params.page, undefined);
});
