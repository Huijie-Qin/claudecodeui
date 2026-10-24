import type { TFunction } from 'i18next';

import type { ReportColumn } from './ReportTable';

export function formatIntegrationDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

export function integrationDetailColumns(t: TFunction, exporting = false): ReportColumn[] {
  const column = (key: string, title: string): ReportColumn => ({ key, title: t(title), sortKey: key });
  return [
    column('statDate', 'integration.statDate'), column('userName', 'userName'), column('workspaceName', 'workspaceName'),
    { key: 'aiActiveDurationMs', title: t(exporting ? 'workbook.durationSeconds' : 'activeDurationMs'), sortKey: 'aiActiveDurationMs', numeric: true,
      render: row => formatIntegrationDuration(row.aiActiveDurationMs),
      exportValue: row => typeof row.aiActiveDurationMs === 'number' ? row.aiActiveDurationMs / 1000 : null },
    column('generatedSqlLines', 'codeReport.generated'), column('submittedCodeLines', 'codeReport.realSubmitted'),
    column('skillName', 'skillName'), column('skillPublishCount', 'integration.skillPublishCount'),
    column('skillCallCount', 'skillInvocationCount'), column('publisherUserName', 'publisher'),
    column('occurredAt', 'integration.occurredAt'), column('refreshedAt', 'integration.refreshedAt'),
    column('id', 'integration.id'), column('tenantId', 'integration.tenantId'), column('userId', 'integration.userId'),
    column('workspaceId', 'integration.workspaceId'), column('aiSessionId', 'integration.aiSessionId'),
    column('hasAiInteraction', 'integration.hasAiInteraction'), column('skillId', 'integration.skillId'),
    column('publisherUserId', 'integration.publisherUserId'), column('sqlRecordId', 'integration.sqlRecordId'),
    column('codeSubmissionId', 'integration.codeSubmissionId'), column('repositoryUrl', 'integration.repositoryUrl'),
    column('commitSha', 'integration.commitSha'),
  ];
}
