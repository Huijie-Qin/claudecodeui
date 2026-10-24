import { createElement } from 'react';
import type { TFunction } from 'i18next';

import type { ReportColumn, ReportSort } from './ReportTable';
import { displayReportValue } from './usageUtils';

const sortKeys = ['userName', 'workspaceName', 'sessionId', 'totalTokens', 'startTime', 'endTime', 'activeDurationSeconds'];

export function sessionDetailSort(value: unknown): ReportSort {
  const sort = value && typeof value === 'object' ? value as Partial<ReportSort> : {};
  return sortKeys.includes(String(sort.sortBy)) && (sort.sortDir === 'asc' || sort.sortDir === 'desc')
    ? { sortBy: String(sort.sortBy), sortDir: sort.sortDir } : { sortBy: 'startTime', sortDir: 'desc' };
}

export function formatSessionDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

export function sessionSkillNames(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((skill): skill is string => typeof skill === 'string')
    .map(skill => skill.trim()).filter(Boolean))] : [];
}

export function sessionDetailColumns(t: TFunction, exporting = false): ReportColumn[] {
  const timeColumn = (key: string): ReportColumn => ({ key, title: t(`sessionDetails.${key}`), sortKey: key,
    render: row => createElement('span', { className: 'whitespace-nowrap' }, displayReportValue(row[key])) });
  return [
    { key: 'userName', title: t('userName'), sortKey: 'userName' },
    { key: 'workspaceName', title: t('workspaceName'), sortKey: 'workspaceName' },
    { key: 'sessionId', title: t('sessionDetails.sessionId'), sortKey: 'sessionId' },
    { key: 'totalTokens', title: t('sessionDetails.totalTokens'), sortKey: 'totalTokens', numeric: true },
    { key: 'skillList', title: t('sessionDetails.skills'),
      render: row => createElement('span', { className: 'whitespace-pre-line' }, sessionSkillNames(row.skillList).join('\n') || '—'),
      exportValue: row => sessionSkillNames(row.skillList).join(', ') },
    timeColumn('startTime'), timeColumn('endTime'),
    { key: 'activeDurationSeconds', title: t(exporting ? 'sessionDetails.activeDurationSeconds' : 'sessionDetails.activeDuration'),
      sortKey: 'activeDurationSeconds', numeric: true, render: row => formatSessionDuration(row.activeDurationSeconds),
      exportValue: row => typeof row.activeDurationSeconds === 'number' && Number.isFinite(row.activeDurationSeconds) && row.activeDurationSeconds >= 0 ? row.activeDurationSeconds : null },
  ];
}
