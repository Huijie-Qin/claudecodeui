import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import { isTimeGroup, reportGroupLabel, splitReportGroups } from './groupingState';
import { analysisMetrics, visibleAnalysisMetrics, visibleAnalysisSort } from './analysisState';
import { reportCsv } from './reportExport';
import ReportGrouping from './ReportGrouping';

test('entity choices are separate from time intervals', () => {
  assert.deepEqual(splitReportGroups(['user','workspace','day','week','month']), { objects: ['user','workspace'], periods: ['day','week','month'] });
  assert.equal(isTimeGroup('hook'), false);
  assert.equal(isTimeGroup('week'), true);
});
test('a person table omits 0/1 distinct-user columns without removing summary metrics', () => {
  assert.deepEqual(visibleAnalysisMetrics('usage', 'user'), ['sessionCount','activeDurationMs']);
  assert.ok(analysisMetrics.usage.includes('activeUserCount'));
  for (const group of ['workspace','day','week','month']) assert.ok(visibleAnalysisMetrics('usage', group).includes('activeUserCount'));
  assert.deepEqual(visibleAnalysisMetrics('templates', 'user'), ['sessionCount']);
  assert.deepEqual(visibleAnalysisMetrics('templates', 'workspace'), ['activeUserCount','sessionCount']);
  assert.deepEqual(visibleAnalysisMetrics('hooks', 'user'), ['recordCount','workspaceCount']);
  assert.deepEqual(visibleAnalysisSort('usage','user',{sortBy:'activeUserCount',sortDir:'desc'}), {sortBy:'activeDurationMs',sortDir:'desc'});
  assert.deepEqual(visibleAnalysisSort('usage','workspace',{sortBy:'activeUserCount',sortDir:'asc'}), {sortBy:'activeUserCount',sortDir:'asc'});
});
test('template exports and sort fallback cannot bring back removed metrics', () => {
  const removed = ['applicationCount','applicationUserCount','activeDurationMs'];
  for (const group of ['template','user','workspace','day','week','month']) {
    const metrics = visibleAnalysisMetrics('templates', group);
    const csv = reportCsv([{key:'groupLabel',title:'对象'}, ...metrics.map(key => ({key,title:key}))],
      [{groupLabel:'测试模板',activeUserCount:5,sessionCount:20,applicationCount:1,applicationUserCount:1,activeDurationMs:5000}]);
    for (const metric of removed) {
      assert.ok(!csv.includes(metric));
      const sort = visibleAnalysisSort('templates', group, {sortBy:metric,sortDir:'asc'});
      assert.deepEqual(sort, {sortBy:group === 'user' ? 'sessionCount' : 'activeUserCount',sortDir:'desc'});
    }
  }
  assert.deepEqual(visibleAnalysisSort('templates','user',{sortBy:'activeUserCount',sortDir:'desc'}), {sortBy:'sessionCount',sortDir:'desc'});
});
test('period labels reflect exact selected dates, including partial weeks and months', () => {
  const range = { from:'2026-08-14', to:'2026-09-12' };
  assert.equal(reportGroupLabel('user','用户 05', range), '用户 05');
  assert.equal(reportGroupLabel('day','2026-09-12', range), '2026/09/12');
  assert.equal(reportGroupLabel('week','2026-08-10', range), '2026/08/14 — 2026/08/16');
  assert.equal(reportGroupLabel('week','2026-09-07', range), '2026/09/07 — 2026/09/12');
  assert.equal(reportGroupLabel('week','2026-08-17', range), '2026/08/17 — 2026/08/23');
  assert.equal(reportGroupLabel('month','2026-08', range), '2026/08 (08/14–08/31)');
  assert.equal(reportGroupLabel('month','2026-09', range), '2026/09 (09/01–09/12)');
  assert.equal(reportGroupLabel('month','2024-02',{from:'2024-02-01',to:'2024-02-29'}), '2024/02');
  assert.equal(reportGroupLabel('week','2025-12-29'), '2025/12/29 — 2026/01/04');
});
test('CSV exports the visible metrics and the same date-range labels', () => {
  const columns = [{key:'groupLabel',title:'用户'}, ...visibleAnalysisMetrics('usage','user').map(key => ({key,title:key}))];
  const csv = reportCsv(columns, [{groupLabel:'零使用用户', sessionCount:0, activeDurationMs:0, activeUserCount:0}]);
  assert.ok(!csv.includes('activeUserCount'));
  assert.ok(csv.includes('零使用用户'));
  const periods = reportCsv([{key:'groupLabel',title:'统计日期区间',exportValue: row => reportGroupLabel('week',row.groupLabel,{from:'2026-08-14',to:'2026-08-16'})}], [{groupLabel:'2026-08-10'}]);
  assert.ok(periods.includes('2026/08/14 — 2026/08/16'));
});
test('grouping controls present only the choices for the selected view', async () => {
  const i18n = i18next.createInstance();
  await i18n.init({ lng:'en', resources:{en:{aiUsage:{ grouping:{view:'View mode', objects:'By entity',time:'By time',object:'Entity',granularity:'Time interval',day:'Daily',week:'Weekly',month:'Monthly'}, group:{user:'User',workspace:'Workspace'} }}} });
  const render = (value: string, options = ['user','workspace','day','week','month']) => renderToStaticMarkup(createElement(I18nextProvider,{i18n}, createElement(ReportGrouping,{value,options,onChange:()=>{}})));
  const objects = render('user');
  assert.ok(objects.includes('aria-pressed="true"'));
  assert.ok(objects.includes('value="workspace"'));
  assert.ok(!objects.includes('value="week"'));
  const weeks = render('week');
  assert.ok(weeks.includes('Time interval'));
  assert.ok(weeks.includes('value="week" selected=""'));
  assert.ok(!weeks.includes('value="user"'));
  assert.ok(!render('user',['user','workspace']).includes('By time'));
  assert.equal(render('template',['template']), '');
});
