import {
  ACQUISITION_CHANNELS,
  CALIBRATION_SOURCES,
  CITY_TIERS,
  DATA_NATURE,
  DEMO_DATASET_VERSION,
  MUSIC_APPS,
  PROFILE_DISTRIBUTIONS,
  PROVINCES,
  REGION_BY_PROVINCE,
} from '../data/agent-graph-demo-calibration.js';

const DAY_MS = 86_400_000;
const COVERAGE_START = '2025-01-01';
const COVERAGE_END = '2026-07-31';
const MAX_REPORT_OPERATIONS = 350_000;
const MAX_REPORT_ROWS = 5_000;
const MAX_AUDIENCE_FILTERS = 12;
const MAX_AUDIENCE_DIMENSIONS = 8;

export const REPORT_DIMENSIONS = Object.freeze([
  'date',
  'week',
  'month',
  'app_id',
  'app_name',
  'app_category',
  'company',
  'platform',
  'province',
  'region',
  'city_tier',
  'acquisition_channel',
]);

export const REPORT_METRICS = Object.freeze([
  'installs',
  'new_users',
  'uninstalls',
  'reinstalls',
  'active_users',
  'paying_users',
  'subscription_starts',
  'subscription_cancels',
  'streams',
  'listening_minutes',
  'd1_retention',
  'd7_retention',
  'd30_retention',
  'uninstall_rate',
  'payer_rate',
  'avg_listening_minutes',
]);

export const REPORT_METRIC_DEFINITIONS = Object.freeze({
  installs: 'Estimated installs during the selected period',
  new_users: 'Estimated first activations during the selected period',
  uninstalls: 'Estimated uninstalls during the selected period',
  reinstalls: 'Estimated reinstalls during the selected period',
  active_users: 'Sum of daily active users (user-days); divide by the selected day count for average DAU',
  paying_users: 'Sum of daily paying users (user-days); divide by the selected day count for an average daily estimate',
  subscription_starts: 'Estimated new paid subscriptions during the selected period',
  subscription_cancels: 'Estimated subscription cancellations during the selected period',
  streams: 'Estimated completed or materially played tracks during the selected period',
  listening_minutes: 'Estimated listening minutes during the selected period',
  d1_retention: 'New-user weighted day-1 retention rate',
  d7_retention: 'New-user weighted day-7 retention rate',
  d30_retention: 'New-user weighted day-30 retention rate',
  uninstall_rate: 'Uninstalls divided by active user-days for the selected period',
  payer_rate: 'Paying user-days divided by active user-days',
  avg_listening_minutes: 'Listening minutes divided by active user-days',
});

const DEFAULT_REPORT_METRICS = Object.freeze([
  'installs',
  'new_users',
  'uninstalls',
  'active_users',
  'paying_users',
  'd1_retention',
  'd7_retention',
  'd30_retention',
  'uninstall_rate',
]);

const BASE_TAGS = Object.freeze([
  ['user_id', '用户样本ID', 'string'],
  ['gender', '性别', 'enum'],
  ['age_band', '年龄段', 'enum'],
  ['province', '所在省份', 'enum'],
  ['region', '所在大区', 'enum'],
  ['city_tier', '城市等级', 'enum'],
  ['education', '学历', 'enum'],
  ['industry', '行业', 'enum'],
  ['occupation', '职业', 'enum'],
  ['income_band', '月收入区间', 'enum'],
  ['device_brand', '手机品牌', 'enum'],
  ['device_price_band', '设备价格区间', 'enum'],
  ['os', '操作系统', 'enum'],
  ['music_preference', '音乐偏好', 'enum'],
  ['listening_scene', '主要听歌场景', 'enum'],
  ['weekly_listening_days', '周听歌天数', 'number'],
  ['daily_listening_minutes', '日均听歌分钟数', 'number'],
  ['music_membership_count', '音乐会员App数量', 'number'],
]);

const APP_TAG_FIELDS = Object.freeze([
  ['status', '安装状态', 'enum'],
  ['installed_days', '安装/持有天数', 'number'],
  ['uninstall_days_ago', '距卸载天数', 'number'],
  ['last_active_days_ago', '距最近活跃天数', 'number'],
  ['membership', '会员状态', 'enum'],
  ['install_channel', '安装渠道', 'enum'],
]);

const FILTER_OPERATORS = Object.freeze([
  'eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'exists',
]);

const NUMERIC_BUCKETS = Object.freeze({
  installed_days: [[0, 7], [8, 30], [31, 90], [91, 180], [181, 365], [366, 730], [731, null]],
  uninstall_days_ago: [[0, 7], [8, 30], [31, 90], [91, 180], [181, 365], [366, null]],
  last_active_days_ago: [[0, 1], [2, 7], [8, 30], [31, 90], [91, null]],
  weekly_listening_days: [[0, 1], [2, 3], [4, 5], [6, 7]],
  daily_listening_minutes: [[0, 15], [16, 30], [31, 60], [61, 90], [91, 120], [121, null]],
  music_membership_count: [[0, 0], [1, 1], [2, 2], [3, null]],
});

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function hashFraction(...parts) {
  const text = parts.join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

function multiplier(key, amplitude = 0.05) {
  return 1 - amplitude + hashFraction(key) * amplitude * 2;
}

function normalizeEntries(entries, adjust = () => 1) {
  const weighted = entries.map(([value, weight]) => [value, Math.max(0, weight * adjust(value))]);
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0) || 1;
  return weighted.map(([value, weight]) => ({ value, weight: weight / total }));
}

function pickWeighted(entries, fraction, adjust = () => 1) {
  const normalized = normalizeEntries(entries, adjust);
  let cursor = fraction;
  for (const entry of normalized) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.value;
  }
  return normalized.at(-1)?.value;
}

function parseList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value !== 'string') return [...fallback];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parseDate(value, fallback, field) {
  const normalized = String(value || fallback);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw createHttpError(`${field} must use YYYY-MM-DD format`);
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw createHttpError(`${field} is not a valid date`);
  }
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function weekKey(date) {
  const monday = new Date(date);
  const day = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - day + 1);
  return formatDate(monday);
}

function reportDimensionValues(dimension, app) {
  if (dimension === 'platform') {
    const iosWeight = app.id === 'apple-music' ? 0.88 : app.id === 'spotify' ? 0.44 : 0.18;
    return normalizeEntries([['Android', 1 - iosWeight], ['iOS', iosWeight]]);
  }
  if (dimension === 'province') {
    return normalizeEntries(PROVINCES, (province) => multiplier(`${app.id}:province:${province}`, 0.13));
  }
  if (dimension === 'region') {
    const regionWeights = new Map();
    for (const [province, weight] of PROVINCES) {
      const region = REGION_BY_PROVINCE[province];
      regionWeights.set(region, (regionWeights.get(region) || 0) + weight);
    }
    return normalizeEntries([...regionWeights.entries()], (region) => multiplier(`${app.id}:region:${region}`, 0.08));
  }
  if (dimension === 'city_tier') {
    return normalizeEntries(CITY_TIERS, (tier) => {
      if (app.id === 'apple-music' || app.id === 'spotify') {
        return ['一线', '新一线'].includes(tier) ? 1.42 : 0.82;
      }
      if (['kugou-music', 'kuwo-music', 'bodian-music'].includes(app.id)) {
        return ['三线', '四线', '五线及以下'].includes(tier) ? 1.18 : 0.92;
      }
      return multiplier(`${app.id}:tier:${tier}`, 0.08);
    });
  }
  if (dimension === 'acquisition_channel') {
    return normalizeEntries(ACQUISITION_CHANNELS, (channel) => {
      if (app.id === 'soda-music' && channel === '短视频内容') return 1.65;
      if (app.id === 'migu-music' && channel === '运营商渠道') return 2.2;
      if (app.id === 'apple-music' && channel === '设备预装') return 2.4;
      return multiplier(`${app.id}:channel:${channel}`, 0.08);
    });
  }
  return [{ value: null, weight: 1 }];
}

function expandSegments(segmentDimensions, app) {
  let combinations = [{ values: {}, weight: 1 }];
  for (const dimension of segmentDimensions) {
    const values = reportDimensionValues(dimension, app);
    combinations = combinations.flatMap((combination) => values.map((entry) => ({
      values: { ...combination.values, [dimension]: entry.value },
      weight: combination.weight * entry.weight,
    })));
  }
  return combinations;
}

function createDailyMetrics(app, date, weight, segmentKey) {
  const coverageAnchor = Date.UTC(2026, 0, 1);
  const yearsFromAnchor = (date.getTime() - coverageAnchor) / (365.25 * DAY_MS);
  const trend = Math.max(0.65, 1 + app.annualTrend * yearsFromAnchor);
  const dayOfYear = Math.floor((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS);
  const weekday = date.getUTCDay();
  const seasonality = 1 + 0.045 * Math.sin((dayOfYear / 365) * Math.PI * 2 - 0.8);
  const weekend = weekday === 0 || weekday === 6 ? 1.055 : 0.985;
  const activityNoise = multiplier(`${app.id}:${formatDate(date)}:activity`, 0.025);
  const acquisitionNoise = multiplier(`${app.id}:${formatDate(date)}:acquisition`, 0.045);
  const segmentNoise = multiplier(`${app.id}:${segmentKey}`, 0.018);
  const activeUsers = app.baseDau * trend * seasonality * weekend * activityNoise * weight * segmentNoise;
  const installs = app.dailyInstalls * Math.max(0.55, 1 + app.annualTrend * yearsFromAnchor * 1.8)
    * seasonality * (weekend > 1 ? 1.08 : 0.98) * acquisitionNoise * weight * segmentNoise;
  const newUsers = installs * (0.76 + hashFraction(app.id, formatDate(date), 'activation') * 0.12);
  const uninstalls = activeUsers * app.uninstallRate * multiplier(`${app.id}:${formatDate(date)}:uninstall`, 0.06);
  const payingUsers = activeUsers * app.payingRate * multiplier(`${app.id}:${formatDate(date)}:paying`, 0.025);
  const d1 = Math.min(0.78, 0.45 + app.payingRate * 0.28 + hashFraction(app.id, 'd1') * 0.045);
  const d7 = Math.min(d1 - 0.08, d1 * (0.62 + hashFraction(app.id, 'd7') * 0.06));
  const d30 = Math.min(d7 - 0.05, d7 * (0.58 + hashFraction(app.id, 'd30') * 0.08));

  return {
    installs,
    new_users: newUsers,
    uninstalls,
    reinstalls: installs * (0.055 + hashFraction(app.id, 'reinstall') * 0.045),
    active_users: activeUsers,
    paying_users: payingUsers,
    subscription_starts: newUsers * Math.min(0.34, app.payingRate * 0.52),
    subscription_cancels: payingUsers * (0.0016 + hashFraction(app.id, 'cancel') * 0.0018),
    streams: activeUsers * app.tracksPerActive * multiplier(`${app.id}:${formatDate(date)}:streams`, 0.025),
    listening_minutes: activeUsers * app.minutesPerActive * multiplier(`${app.id}:${formatDate(date)}:minutes`, 0.025),
    d1_retention: d1,
    d7_retention: d7,
    d30_retention: d30,
  };
}

function resolveReportDimensionValue(dimension, app, date, segmentValues) {
  if (dimension === 'date') return formatDate(date);
  if (dimension === 'week') return weekKey(date);
  if (dimension === 'month') return formatDate(date).slice(0, 7);
  if (dimension === 'app_id') return app.id;
  if (dimension === 'app_name') return app.name;
  if (dimension === 'app_category') return app.category;
  if (dimension === 'company') return app.company;
  return segmentValues[dimension];
}

function emptyReportAccumulator(dimensions) {
  return {
    dimensions,
    installs: 0,
    new_users: 0,
    uninstalls: 0,
    reinstalls: 0,
    active_users: 0,
    paying_users: 0,
    subscription_starts: 0,
    subscription_cancels: 0,
    streams: 0,
    listening_minutes: 0,
    retention_d1_numerator: 0,
    retention_d7_numerator: 0,
    retention_d30_numerator: 0,
  };
}

function addDailyMetrics(accumulator, metrics) {
  for (const metric of REPORT_METRICS.slice(0, 10)) {
    accumulator[metric] += metrics[metric];
  }
  accumulator.retention_d1_numerator += metrics.d1_retention * metrics.new_users;
  accumulator.retention_d7_numerator += metrics.d7_retention * metrics.new_users;
  accumulator.retention_d30_numerator += metrics.d30_retention * metrics.new_users;
}

function roundMetric(metric, value) {
  if (['d1_retention', 'd7_retention', 'd30_retention', 'uninstall_rate', 'payer_rate'].includes(metric)) {
    return Number(value.toFixed(4));
  }
  if (metric === 'avg_listening_minutes') return Number(value.toFixed(2));
  return Math.round(value);
}

function finalizeReportRow(accumulator, metrics) {
  const derived = {
    ...accumulator,
    d1_retention: accumulator.new_users ? accumulator.retention_d1_numerator / accumulator.new_users : 0,
    d7_retention: accumulator.new_users ? accumulator.retention_d7_numerator / accumulator.new_users : 0,
    d30_retention: accumulator.new_users ? accumulator.retention_d30_numerator / accumulator.new_users : 0,
    uninstall_rate: accumulator.active_users ? accumulator.uninstalls / accumulator.active_users : 0,
    payer_rate: accumulator.active_users ? accumulator.paying_users / accumulator.active_users : 0,
    avg_listening_minutes: accumulator.active_users ? accumulator.listening_minutes / accumulator.active_users : 0,
  };
  return {
    ...accumulator.dimensions,
    ...Object.fromEntries(metrics.map((metric) => [metric, roundMetric(metric, derived[metric] || 0)])),
  };
}

function resolveApps(input) {
  const requested = parseList(input);
  if (requested.length === 0) return [...MUSIC_APPS];
  const normalized = new Set(requested.map((value) => value.toLowerCase()));
  const apps = MUSIC_APPS.filter((app) => normalized.has(app.id.toLowerCase()) || normalized.has(app.name.toLowerCase()));
  if (apps.length !== normalized.size) {
    const resolved = new Set(apps.flatMap((app) => [app.id.toLowerCase(), app.name.toLowerCase()]));
    const unknown = requested.filter((value) => !resolved.has(value.toLowerCase()));
    if (unknown.length > 0) throw createHttpError(`Unknown music app: ${unknown.join(', ')}`);
  }
  return apps;
}

export function queryMusicReports(input = {}) {
  const startDate = parseDate(input.startDate ?? input.start_date, '2026-05-01', 'startDate');
  const endDate = parseDate(input.endDate ?? input.end_date, COVERAGE_END, 'endDate');
  const coverageStart = parseDate(COVERAGE_START, COVERAGE_START, 'coverageStart');
  const coverageEnd = parseDate(COVERAGE_END, COVERAGE_END, 'coverageEnd');
  if (startDate < coverageStart || endDate > coverageEnd || startDate > endDate) {
    throw createHttpError(`Date range must stay between ${COVERAGE_START} and ${COVERAGE_END}`);
  }

  const dimensions = parseList(input.dimensions, ['month', 'app_name']);
  const metrics = parseList(input.metrics, DEFAULT_REPORT_METRICS);
  const unknownDimensions = dimensions.filter((dimension) => !REPORT_DIMENSIONS.includes(dimension));
  const unknownMetrics = metrics.filter((metric) => !REPORT_METRICS.includes(metric));
  if (unknownDimensions.length > 0) throw createHttpError(`Unknown dimensions: ${unknownDimensions.join(', ')}`);
  if (unknownMetrics.length > 0) throw createHttpError(`Unknown metrics: ${unknownMetrics.join(', ')}`);
  if (new Set(dimensions).size !== dimensions.length || new Set(metrics).size !== metrics.length) {
    throw createHttpError('Dimensions and metrics must not contain duplicates');
  }
  const timeDimensions = dimensions.filter((dimension) => ['date', 'week', 'month'].includes(dimension));
  if (timeDimensions.length > 1) throw createHttpError('Use only one of date, week, or month');
  if (dimensions.includes('province') && dimensions.includes('region')) {
    throw createHttpError('province and region cannot be grouped together');
  }

  const apps = resolveApps(input.apps ?? input.app_ids);
  const segmentDimensions = dimensions.filter((dimension) => ['platform', 'province', 'region', 'city_tier', 'acquisition_channel'].includes(dimension));
  const days = Math.floor((endDate - startDate) / DAY_MS) + 1;
  const combinationsPerApp = segmentDimensions.reduce((count, dimension) => count * reportDimensionValues(dimension, apps[0]).length, 1);
  const operations = days * apps.length * combinationsPerApp;
  if (operations > MAX_REPORT_OPERATIONS) {
    throw createHttpError(`Query is too detailed (${operations.toLocaleString()} scan cells). Shorten the date range or remove a segment dimension.`);
  }

  const groups = new Map();
  for (let cursor = new Date(startDate); cursor <= endDate; cursor = new Date(cursor.getTime() + DAY_MS)) {
    for (const app of apps) {
      for (const segment of expandSegments(segmentDimensions, app)) {
        const dimensionValues = Object.fromEntries(dimensions.map((dimension) => [
          dimension,
          resolveReportDimensionValue(dimension, app, cursor, segment.values),
        ]));
        const groupKey = dimensions.map((dimension) => `${dimension}=${dimensionValues[dimension]}`).join('|') || 'all';
        if (!groups.has(groupKey)) groups.set(groupKey, emptyReportAccumulator(dimensionValues));
        addDailyMetrics(
          groups.get(groupKey),
          createDailyMetrics(app, cursor, segment.weight, JSON.stringify(segment.values)),
        );
      }
    }
  }

  if (groups.size > MAX_REPORT_ROWS) {
    throw createHttpError(`Query would return ${groups.size.toLocaleString()} rows; the maximum is ${MAX_REPORT_ROWS.toLocaleString()}.`);
  }
  const rows = [...groups.values()]
    .map((accumulator) => finalizeReportRow(accumulator, metrics))
    .sort((left, right) => dimensions.map((dimension) => String(left[dimension])).join('|')
      .localeCompare(dimensions.map((dimension) => String(right[dimension])).join('|'), 'zh-CN'));

  return {
    dataset: 'music_app_report_panel',
    version: DEMO_DATASET_VERSION,
    coverage: { startDate: COVERAGE_START, endDate: COVERAGE_END },
    query: {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate),
      apps: apps.map((app) => app.id),
      dimensions,
      metrics,
    },
    rowCount: rows.length,
    dataNature: DATA_NATURE,
    rows,
  };
}

function adjustEducation(profile, value) {
  if (profile.age_band === '15-17') return value === '高中/中专' ? 4 : value === '本科' ? 0.05 : 0.4;
  if (['一线', '新一线'].includes(profile.city_tier) && ['本科', '硕士及以上'].includes(value)) return 1.35;
  if (['四线', '五线及以下'].includes(profile.city_tier) && value === '初中及以下') return 1.28;
  return 1;
}

function adjustIndustry(profile, value) {
  if (profile.age_band === '15-17') return value === '学生' ? 12 : 0.18;
  if (profile.age_band === '18-24' && value === '学生') return 3.2;
  if (['本科', '硕士及以上'].includes(profile.education) && ['信息技术与互联网', '金融', '教育'].includes(value)) return 1.45;
  if (['四线', '五线及以下'].includes(profile.city_tier) && ['制造业', '农业'].includes(value)) return 1.35;
  return 1;
}

const OCCUPATION_INDUSTRY_AFFINITY = Object.freeze({
  学生: ['学生'],
  教师: ['教育'],
  医护人员: ['医疗健康'],
  '物流与驾驶人员': ['交通运输与物流'],
  '生产制造人员': ['制造业', '建筑与房地产'],
  '商业服务人员': ['批发零售', '住宿餐饮与生活服务'],
  '专业技术人员': ['信息技术与互联网', '金融', '医疗健康', '文化传媒与娱乐'],
  '农业从业者': ['农业'],
});

function adjustOccupation(profile, value) {
  if (profile.industry === '学生') return value === '学生' ? 18 : 0.12;
  if (OCCUPATION_INDUSTRY_AFFINITY[value]?.includes(profile.industry)) return 3.2;
  if (value === '管理人员' && ['本科', '硕士及以上'].includes(profile.education)) return 1.45;
  return 0.92;
}

function adjustIncome(profile, value) {
  const highIncome = ['10000-19999元', '20000-39999元', '40000元以上'].includes(value);
  const lowIncome = ['3000元以下', '3000-5999元'].includes(value);
  if (profile.occupation === '学生') return lowIncome ? 2.2 : highIncome ? 0.12 : 0.8;
  if (['管理人员', '专业技术人员'].includes(profile.occupation)) return highIncome ? 1.6 : lowIncome ? 0.65 : 1;
  if (['一线', '新一线'].includes(profile.city_tier)) return highIncome ? 1.25 : 0.9;
  return 1;
}

function adjustDevicePrice(profile, value) {
  const highIncome = ['20000-39999元', '40000元以上'].includes(profile.income_band);
  const lowerIncome = ['3000元以下', '3000-5999元'].includes(profile.income_band);
  if (highIncome) return ['4000-5999元', '6000元以上'].includes(value) ? 1.75 : 0.65;
  if (lowerIncome) return ['1000元以下', '1000-1999元'].includes(value) ? 1.55 : value === '6000元以上' ? 0.25 : 0.9;
  return 1;
}

function adjustDeviceBrand(profile, value) {
  if (profile.device_price_band === '6000元以上') return value === '苹果' ? 2.4 : ['华为', '荣耀'].includes(value) ? 1.25 : 0.55;
  if (['1000元以下', '1000-1999元'].includes(profile.device_price_band)) {
    return ['小米', 'OPPO', 'vivo', '荣耀'].includes(value) ? 1.25 : value === '苹果' ? 0.12 : 1;
  }
  return 1;
}

function createProfile(userNumber) {
  const key = `profile:${userNumber}`;
  const profile = {
    user_id: `U${String(userNumber).padStart(6, '0')}`,
    gender: pickWeighted(PROFILE_DISTRIBUTIONS.gender, hashFraction(key, 'gender')),
    age_band: pickWeighted(PROFILE_DISTRIBUTIONS.age_band, hashFraction(key, 'age')),
    province: pickWeighted(PROVINCES, hashFraction(key, 'province')),
    city_tier: pickWeighted(CITY_TIERS, hashFraction(key, 'city-tier')),
  };
  profile.region = REGION_BY_PROVINCE[profile.province];
  profile.education = pickWeighted(PROFILE_DISTRIBUTIONS.education, hashFraction(key, 'education'), (value) => adjustEducation(profile, value));
  profile.industry = pickWeighted(PROFILE_DISTRIBUTIONS.industry, hashFraction(key, 'industry'), (value) => adjustIndustry(profile, value));
  profile.occupation = pickWeighted(PROFILE_DISTRIBUTIONS.occupation, hashFraction(key, 'occupation'), (value) => adjustOccupation(profile, value));
  profile.income_band = pickWeighted(PROFILE_DISTRIBUTIONS.income_band, hashFraction(key, 'income'), (value) => adjustIncome(profile, value));
  profile.device_price_band = pickWeighted(PROFILE_DISTRIBUTIONS.device_price_band, hashFraction(key, 'device-price'), (value) => adjustDevicePrice(profile, value));
  profile.device_brand = pickWeighted(PROFILE_DISTRIBUTIONS.device_brand, hashFraction(key, 'device-brand'), (value) => adjustDeviceBrand(profile, value));
  profile.os = profile.device_brand === '苹果' ? 'iOS' : 'Android';
  profile.music_preference = pickWeighted(PROFILE_DISTRIBUTIONS.music_preference, hashFraction(key, 'music-preference'));
  profile.listening_scene = pickWeighted(PROFILE_DISTRIBUTIONS.listening_scene, hashFraction(key, 'listening-scene'));
  profile.weekly_listening_days = 1 + Math.floor(hashFraction(key, 'weekly-days') * 7);
  profile.daily_listening_minutes = Math.round(8 + Math.pow(hashFraction(key, 'daily-minutes'), 0.72) * 155);
  profile.music_membership_count = Math.min(4, Math.floor(Math.pow(hashFraction(key, 'membership-count'), 2.2) * 6));
  Object.defineProperty(profile, '_number', { value: userNumber, enumerable: false });
  Object.defineProperty(profile, '_apps', { value: new Map(), enumerable: false });
  return profile;
}

function appAffinity(profile, app) {
  let affinity = 1;
  if (app.id === 'soda-music' && ['15-17', '18-24', '25-34'].includes(profile.age_band)) affinity *= 1.34;
  if (app.id === 'netease-cloud-music' && ['本科', '硕士及以上'].includes(profile.education)) affinity *= 1.20;
  if (['kugou-music', 'kuwo-music'].includes(app.id) && ['三线', '四线', '五线及以下'].includes(profile.city_tier)) affinity *= 1.18;
  if (app.id === 'migu-music' && profile.os === 'Android') affinity *= 1.16;
  if (app.id === 'apple-music') affinity *= profile.os === 'iOS' ? 4.4 : 0.025;
  if (app.id === 'spotify' && ['一线', '新一线'].includes(profile.city_tier)) affinity *= 1.5;
  if (['ximalaya', 'qingting-fm'].includes(app.id) && profile.music_preference === '播客/有声书') affinity *= 2.25;
  return affinity;
}

function dateDaysAgo(daysAgo) {
  const date = new Date(`${COVERAGE_END}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return formatDate(date);
}

function getAppState(profile, appId) {
  if (profile._apps.has(appId)) return profile._apps.get(appId);
  const app = MUSIC_APPS.find((entry) => entry.id === appId);
  if (!app) throw createHttpError(`Unknown app tag namespace: ${appId}`);
  const key = `${profile.user_id}:${app.id}`;
  const basePenetration = Math.min(0.62, 0.075 + Math.sqrt(app.baseDau / 100_000_000) * 0.53);
  const installedProbability = Math.min(0.88, basePenetration * appAffinity(profile, app));
  const everInstalled = hashFraction(key, 'ever-installed') < installedProbability;
  let state;
  if (!everInstalled) {
    state = {
      status: '从未安装',
      installed_days: 0,
      uninstall_days_ago: null,
      last_active_days_ago: null,
      membership: '非会员',
      install_channel: null,
      install_date: null,
      uninstall_date: null,
    };
  } else {
    const totalAgeDays = 1 + Math.floor(Math.pow(hashFraction(key, 'age-days'), 1.55) * 1_420);
    const churnProbability = Math.min(0.48, 0.13 + app.uninstallRate * 48 + (totalAgeDays < 30 ? 0.08 : 0));
    const uninstalled = hashFraction(key, 'churn') < churnProbability;
    const installChannel = pickWeighted(ACQUISITION_CHANNELS, hashFraction(key, 'channel'));
    const memberProbability = Math.min(0.76, app.payingRate * (profile.music_membership_count > 0 ? 1.65 : 0.72));
    if (uninstalled) {
      const installedDays = Math.max(1, Math.floor(totalAgeDays * (0.18 + hashFraction(key, 'tenure-share') * 0.68)));
      const uninstallDaysAgo = Math.max(0, totalAgeDays - installedDays);
      state = {
        status: '已卸载',
        installed_days: installedDays,
        uninstall_days_ago: uninstallDaysAgo,
        last_active_days_ago: uninstallDaysAgo + Math.floor(hashFraction(key, 'pre-churn-inactive') * 21),
        membership: hashFraction(key, 'member') < memberProbability ? '历史会员' : '非会员',
        install_channel: installChannel,
        install_date: dateDaysAgo(totalAgeDays),
        uninstall_date: dateDaysAgo(uninstallDaysAgo),
      };
    } else {
      const lastActiveDays = Math.floor(Math.pow(hashFraction(key, 'last-active'), 3.2) * 75);
      state = {
        status: '已安装',
        installed_days: totalAgeDays,
        uninstall_days_ago: null,
        last_active_days_ago: lastActiveDays,
        membership: hashFraction(key, 'member') < memberProbability ? '当前会员' : '非会员',
        install_channel: installChannel,
        install_date: dateDaysAgo(totalAgeDays),
        uninstall_date: null,
      };
    }
  }
  profile._apps.set(appId, state);
  return state;
}

function buildAudienceTagCatalog() {
  const base = BASE_TAGS.map(([id, name, type]) => ({ id, name, type }));
  const appTags = MUSIC_APPS.flatMap((app) => APP_TAG_FIELDS.map(([field, name, type]) => ({
    id: `app.${app.id}.${field}`,
    name: `${app.name}${name}`,
    type,
    appId: app.id,
    appName: app.name,
  })));
  return [...base, ...appTags];
}

export const AUDIENCE_TAGS = Object.freeze(buildAudienceTagCatalog());
const AUDIENCE_TAG_MAP = new Map(AUDIENCE_TAGS.map((tag) => [tag.id, tag]));

function getTagValue(profile, tagId) {
  if (!AUDIENCE_TAG_MAP.has(tagId)) throw createHttpError(`Unknown audience tag: ${tagId}`);
  if (!tagId.startsWith('app.')) return profile[tagId];
  const [, appId, field] = tagId.split('.');
  return getAppState(profile, appId)[field];
}

function compareFilter(actual, filter) {
  const operator = filter.operator || filter.op || 'eq';
  const expected = filter.value;
  if (!FILTER_OPERATORS.includes(operator)) throw createHttpError(`Unknown filter operator: ${operator}`);
  if (operator === 'exists') return expected === false ? actual == null : actual != null;
  if (operator === 'eq') return actual === expected;
  if (operator === 'neq') return actual !== expected;
  if (operator === 'in') return Array.isArray(expected) && expected.includes(actual);
  if (operator === 'not_in') return Array.isArray(expected) && !expected.includes(actual);
  if (operator === 'contains') return typeof actual === 'string' && actual.includes(String(expected ?? ''));
  if (actual == null) return false;
  if (operator === 'gt') return Number(actual) > Number(expected);
  if (operator === 'gte') return Number(actual) >= Number(expected);
  if (operator === 'lt') return Number(actual) < Number(expected);
  if (operator === 'lte') return Number(actual) <= Number(expected);
  if (operator === 'between') {
    return Array.isArray(expected) && expected.length === 2
      && Number(actual) >= Number(expected[0]) && Number(actual) <= Number(expected[1]);
  }
  return false;
}

function normalizeAudienceInput(input = {}) {
  const filters = Array.isArray(input.filters) ? input.filters : [];
  const dimensions = parseList(input.dimensions, ['industry', 'occupation', 'province']);
  const match = input.match === 'any' ? 'any' : 'all';
  const topN = Math.min(50, Math.max(1, Number(input.topN ?? input.top_n ?? 15) || 15));
  if (filters.length > MAX_AUDIENCE_FILTERS) throw createHttpError(`A maximum of ${MAX_AUDIENCE_FILTERS} filters is allowed`);
  if (dimensions.length > MAX_AUDIENCE_DIMENSIONS) throw createHttpError(`A maximum of ${MAX_AUDIENCE_DIMENSIONS} dimensions is allowed`);
  for (const filter of filters) {
    if (!filter?.tag || !AUDIENCE_TAG_MAP.has(filter.tag)) throw createHttpError(`Unknown audience tag: ${filter?.tag || ''}`);
  }
  for (const dimension of dimensions) {
    if (!AUDIENCE_TAG_MAP.has(dimension)) throw createHttpError(`Unknown audience dimension: ${dimension}`);
  }
  return { filters, dimensions, match, topN };
}

function profileMatches(profile, filters, match) {
  if (filters.length === 0) return true;
  const results = filters.map((filter) => compareFilter(getTagValue(profile, filter.tag), filter));
  return match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

function formatBucket(min, max) {
  if (max == null) return `${min}+`;
  if (min === max) return String(min);
  return `${min}-${max}`;
}

function bucketTagValue(tagId, value) {
  if (value == null) return '无/不适用';
  const field = tagId.split('.').at(-1);
  const buckets = NUMERIC_BUCKETS[field];
  if (!buckets || typeof value !== 'number') return String(value);
  const bucket = buckets.find(([min, max]) => value >= min && (max == null || value <= max));
  return bucket ? formatBucket(bucket[0], bucket[1]) : String(value);
}

function incrementDistribution(map, value) {
  map.set(value, (map.get(value) || 0) + 1);
}

function toDistribution(tagId, cohortCounts, baselineCounts, cohortTotal, populationSize, topN) {
  return [...cohortCounts.entries()]
    .map(([value, count]) => {
      const percentage = cohortTotal ? count / cohortTotal : 0;
      const baselineCount = baselineCounts.get(value) || 0;
      const baselinePercentage = populationSize ? baselineCount / populationSize : 0;
      return {
        value,
        count,
        percentage: Number(percentage.toFixed(4)),
        baselinePercentage: Number(baselinePercentage.toFixed(4)),
        lift: baselinePercentage ? Number((percentage / baselinePercentage).toFixed(3)) : null,
      };
    })
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, 'zh-CN'))
    .slice(0, topN)
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}

export function analyzeAudience(input = {}, { populationSize = DATA_NATURE.audienceProfiles } = {}) {
  const normalized = normalizeAudienceInput(input);
  const baseline = new Map(normalized.dimensions.map((dimension) => [dimension, new Map()]));
  const cohort = new Map(normalized.dimensions.map((dimension) => [dimension, new Map()]));
  let cohortSize = 0;

  for (let userNumber = 1; userNumber <= populationSize; userNumber += 1) {
    const profile = createProfile(userNumber);
    const matched = profileMatches(profile, normalized.filters, normalized.match);
    if (matched) cohortSize += 1;
    for (const dimension of normalized.dimensions) {
      const value = bucketTagValue(dimension, getTagValue(profile, dimension));
      incrementDistribution(baseline.get(dimension), value);
      if (matched) incrementDistribution(cohort.get(dimension), value);
    }
  }

  return {
    dataset: 'music_user_profile_panel',
    version: DEMO_DATASET_VERSION,
    populationSize,
    cohort: {
      size: cohortSize,
      share: Number((cohortSize / populationSize).toFixed(4)),
      match: normalized.match,
      filters: normalized.filters,
    },
    analyses: normalized.dimensions.map((dimension) => ({
      tag: dimension,
      name: AUDIENCE_TAG_MAP.get(dimension).name,
      values: toDistribution(
        dimension,
        cohort.get(dimension),
        baseline.get(dimension),
        cohortSize,
        populationSize,
        normalized.topN,
      ),
    })),
    dataNature: DATA_NATURE,
  };
}

export function sampleAudience(input = {}, { populationSize = DATA_NATURE.audienceProfiles } = {}) {
  const normalized = normalizeAudienceInput(input);
  const tags = parseList(input.tags, [
    'user_id', 'age_band', 'gender', 'province', 'city_tier', 'industry', 'occupation', 'music_preference',
  ]);
  for (const tag of tags) {
    if (!AUDIENCE_TAG_MAP.has(tag)) throw createHttpError(`Unknown audience sample tag: ${tag}`);
  }
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 20));
  const rows = [];
  for (let userNumber = 1; userNumber <= populationSize && rows.length < limit; userNumber += 1) {
    const profile = createProfile(userNumber);
    if (!profileMatches(profile, normalized.filters, normalized.match)) continue;
    rows.push(Object.fromEntries(tags.map((tag) => [tag, getTagValue(profile, tag)])));
  }
  return {
    dataset: 'music_user_profile_panel',
    version: DEMO_DATASET_VERSION,
    filters: normalized.filters,
    rowCount: rows.length,
    rows,
    dataNature: DATA_NATURE,
  };
}

export function getDemoDataCatalog() {
  return {
    version: DEMO_DATASET_VERSION,
    dataNature: DATA_NATURE,
    sources: CALIBRATION_SOURCES,
    datasets: [
      {
        id: 'music_app_report_panel',
        name: '音乐App经营报表面板',
        coverage: { startDate: COVERAGE_START, endDate: COVERAGE_END },
        apps: MUSIC_APPS.map(({ id, name, category, company }) => ({ id, name, category, company })),
        dimensions: REPORT_DIMENSIONS,
        metrics: REPORT_METRICS,
        metricDefinitions: REPORT_METRIC_DEFINITIONS,
      },
      {
        id: 'music_user_profile_panel',
        name: '音乐用户画像标签面板',
        populationSize: DATA_NATURE.audienceProfiles,
        operators: FILTER_OPERATORS,
        tags: AUDIENCE_TAGS,
      },
    ],
  };
}

export function getMusicReportSchema() {
  const dataset = getDemoDataCatalog().datasets.find((entry) => entry.id === 'music_app_report_panel');
  return { ...dataset, dataNature: DATA_NATURE, sources: CALIBRATION_SOURCES };
}

export function getAudienceSchema() {
  const dataset = getDemoDataCatalog().datasets.find((entry) => entry.id === 'music_user_profile_panel');
  return { ...dataset, dataNature: DATA_NATURE, sources: CALIBRATION_SOURCES };
}

export const agentGraphDemoDataService = Object.freeze({
  analyzeAudience,
  getAudienceSchema,
  getDemoDataCatalog,
  getMusicReportSchema,
  queryMusicReports,
  sampleAudience,
});
