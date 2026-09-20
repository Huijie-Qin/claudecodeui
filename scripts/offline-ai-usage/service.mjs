import { createAiUsageAccessService } from '../../server/services/ai-usage-access.js';
import { createAiUsageQueryService } from '../../server/services/ai-usage-query.js';

export class UsageApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function createOfflineService(db) {
  const accessService = createAiUsageAccessService({ db });
  const query = createAiUsageQueryService({ db, getScheduleStatus: () => ({ enabled: false, state: 'idle', timeZone: 'Asia/Shanghai', nextRunAt: null }) });
  return (path, params = {}, userId = 2, body) => {
    // Match the network client's URLSearchParams serialization and validation.
    const filters = Object.fromEntries(Object.entries(params).filter(([, value]) => value != null && value !== '').map(([key, value]) => [key, String(value)]));
    try {
      const access = accessService.resolve({ userId, tenantId: filters.tenantId, scope: filters.scope });
      if (path === 'capabilities') return { ...access, exportConfigured: false, simulation: true };
      if (path === 'status') return query.status(access, filters.batchId);
      if (path === 'exports' && body === undefined) return { jobs: [] };
      if (path.startsWith('exports')) throw new UsageApiError(503, 'exportUnconfigured', '离线演示不运行异步导出服务');
      if (['overview', 'summary', 'trend', 'users', 'skills', 'hooks', 'templates', 'analysis'].includes(path)) return query[path](access, filters);
      if (path === 'hook-field-statistics') return query.hookFieldStatistics(access, filters);
      if (path === 'hook-executions') return query.hookExecutions(access, filters);
      if (path === 'agent-templates') return query.templates(access, filters);
      const match = /^(hooks|hook-executions|templates|agent-templates)\/([^/]+)\/(records|statistics|field-statistics|applications|sessions)$/.exec(path);
      if (match) {
        const [, kind, encodedId, mode] = match;
        const id = decodeURIComponent(encodedId);
        if (kind === 'hooks') {
          if (mode === 'records') return query.hookRecords(access, id, filters);
          if (mode === 'statistics') return query.hookStatistics(access, id, filters);
          if (mode === 'field-statistics') return query.hookStatistics(access, id, filters, true, true);
        }
        if (kind === 'hook-executions' && mode === 'records') return query.hookExecutionRecords(access, id, filters);
        if (kind === 'templates' || kind === 'agent-templates') {
          if (mode === 'applications') return query.templateApplications(access, id, filters);
          if (mode === 'sessions') return query.templateSessions(access, id, filters);
        }
      }
      throw new UsageApiError(404, 'notFound', `Unknown offline report: ${path}`);
    } catch (error) {
      if (error instanceof UsageApiError) throw error;
      throw new UsageApiError(error.statusCode || 500, error.code || 'reportUnavailable', error.message);
    }
  };
}
