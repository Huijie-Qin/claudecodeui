export type UsageScope = 'self' | 'tenant';
export type ReportTab = 'usage' | 'skills' | 'hookExecutions' | 'hooks' | 'templates';
export type AnalysisTab = Exclude<ReportTab, 'skills'>;
export type Coverage = string | { status?: string; pendingTurns?: number; [key: string]: unknown };
export type UsageCapabilities = { userId?: number; canViewDefinitions?: boolean; canViewTenant: boolean; canExport: boolean; exportConfigured: boolean; defaultScope?: UsageScope; simulation?: boolean; codeReportAvailable?: boolean };
export type UsageStatus = {
  batchId: string | null; dataThrough?: string; dataThroughDate?: string; generatedAt?: string;
  lastSucceededAt?: string; nextRunAt?: string; state?: string; timeZone?: string;
  runAt?: string; coverage?: Coverage; calculationVersion?: string;
};
export type UsageRow = {
  [key: string]: unknown;
  userId?: number | string; displayName?: string; username?: string; date?: string;
  userName?: string | null; user_name?: string | null; workspaceName?: string | null;
  sessionCount?: number | null; activeDurationMs?: number | null;
  publishedSkillCount?: number | null; skillInvocationCount?: number | null;
  dau?: number | null; mau?: number | null; activeUserCount?: number | null;
  hookId?: number | string; hookName?: string; postActionId?: string; hookVersion?: number;
  recordType?: string; recordSource?: string; recordCount?: number; fields?: Record<string, unknown> | Array<{ key?: string; label?: string; type?: string; value?: unknown; unit?: string }>;
  templateId?: number | string; templateName?: string; applicationCount?: number;
  coverage?: Coverage;
};
export type UsageList = { batchId: string; items: UsageRow[]; total: number; page: number; pageSize: number; groupBy?: string; numericStatisticsVersion?: number };
export type ExportJob = { id?: string; jobId?: string; status?: string; state?: string; createdAt?: string; error?: string; reportType?: string; dataset?: string; downloadReady?: boolean };
