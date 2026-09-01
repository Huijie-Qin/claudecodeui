import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeAudience,
  getAudienceSchema,
  getDemoDataCatalog,
  queryMusicReports,
  sampleAudience,
} from './agent-graph-demo-data.js';

test('music report queries are deterministic and expose coherent operating metrics', () => {
  const input = {
    startDate: '2026-07-01',
    endDate: '2026-07-07',
    apps: ['soda-music'],
    dimensions: ['date', 'app_name'],
    metrics: ['installs', 'new_users', 'uninstalls', 'active_users', 'd30_retention', 'uninstall_rate'],
  };
  const first = queryMusicReports(input);
  const second = queryMusicReports(input);

  assert.deepEqual(first, second);
  assert.equal(first.rowCount, 7);
  assert.equal(first.rows[0].app_name, '汽水音乐');
  for (const row of first.rows) {
    assert.ok(row.installs > row.new_users);
    assert.ok(row.active_users > row.installs);
    assert.ok(row.uninstalls > 0);
    assert.ok(row.d30_retention > 0 && row.d30_retention < 1);
    assert.ok(row.uninstall_rate > 0 && row.uninstall_rate < 1);
  }
});

test('music report queries support natural segment breakdowns without changing total scale', () => {
  const total = queryMusicReports({
    startDate: '2026-07-01',
    endDate: '2026-07-31',
    apps: ['netease-cloud-music'],
    dimensions: ['month', 'app_id'],
    metrics: ['installs', 'active_users'],
  });
  const platforms = queryMusicReports({
    startDate: '2026-07-01',
    endDate: '2026-07-31',
    apps: ['netease-cloud-music'],
    dimensions: ['month', 'app_id', 'platform'],
    metrics: ['installs', 'active_users'],
  });

  assert.equal(platforms.rowCount, 2);
  const segmentedInstalls = platforms.rows.reduce((sum, row) => sum + row.installs, 0);
  const segmentedActive = platforms.rows.reduce((sum, row) => sum + row.active_users, 0);
  assert.ok(Math.abs(segmentedInstalls - total.rows[0].installs) / total.rows[0].installs < 0.03);
  assert.ok(Math.abs(segmentedActive - total.rows[0].active_users) / total.rows[0].active_users < 0.03);
});

test('audience analysis supports the Soda Music installed-over-30-days cohort', () => {
  const result = analyzeAudience({
    filters: [
      { tag: 'app.soda-music.status', operator: 'eq', value: '已安装' },
      { tag: 'app.soda-music.installed_days', operator: 'gt', value: 30 },
    ],
    dimensions: ['industry', 'occupation', 'province', 'app.soda-music.uninstall_days_ago'],
    topN: 10,
  }, { populationSize: 5_000 });

  assert.equal(result.populationSize, 5_000);
  assert.ok(result.cohort.size > 100);
  assert.ok(result.cohort.size < result.populationSize);
  assert.equal(result.analyses.length, 4);
  assert.ok(result.analyses.every((analysis) => analysis.values.length > 0));
  assert.equal(result.analyses[3].values[0].value, '无/不适用');
});

test('audience samples contain only requested tags and never expose real personal information', () => {
  const result = sampleAudience({
    filters: [{ tag: 'industry', operator: 'eq', value: '信息技术与互联网' }],
    tags: ['user_id', 'industry', 'app.qq-music.status'],
    limit: 5,
  }, { populationSize: 2_000 });

  assert.equal(result.rowCount, 5);
  assert.deepEqual(Object.keys(result.rows[0]), ['user_id', 'industry', 'app.qq-music.status']);
  assert.match(result.rows[0].user_id, /^U\d{6}$/);
  assert.equal(result.dataNature.containsPersonalInformation, false);
});

test('catalog documents both datasets, public calibration sources, and full audience tag inventory', () => {
  const catalog = getDemoDataCatalog();
  const audienceSchema = getAudienceSchema();

  assert.deepEqual(catalog.datasets.map((dataset) => dataset.id), [
    'music_app_report_panel',
    'music_user_profile_panel',
  ]);
  assert.ok(catalog.sources.length >= 5);
  assert.ok(audienceSchema.tags.length >= 80);
  assert.equal(catalog.dataNature.isRealUserData, false);
});

test('invalid and excessive report queries fail before generating data', () => {
  assert.throws(
    () => queryMusicReports({ dimensions: ['not-a-dimension'] }),
    /Unknown dimensions/,
  );
  assert.throws(
    () => queryMusicReports({
      startDate: '2025-01-01',
      endDate: '2026-07-31',
      dimensions: ['date', 'province', 'platform', 'acquisition_channel'],
    }),
    /too detailed/,
  );
});
