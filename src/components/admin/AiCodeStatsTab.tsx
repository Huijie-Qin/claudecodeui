import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCode2, GitMerge, LineChart, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';
import { api } from '../../utils/api';

type AdminTenant = {
  id: number;
  code: string;
  name: string;
};

type AdminUser = {
  id: number;
  username: string;
};

type AiCodeSummary = {
  mergedMrCount: number;
  additions: number;
  deletions: number;
  changedLines: number;
  filesChanged: number;
  binaryFilesChanged: number;
};

type AiCodeGroup = {
  tenant_id?: number;
  tenant_name?: string | null;
  tenant_code?: string | null;
  user_id?: number;
  username?: string | null;
  merged_mr_count: number;
  additions: number;
  deletions: number;
  files_changed: number;
  binary_files_changed: number;
};

type AiCodeStats = {
  summary: AiCodeSummary;
  byTenant: AiCodeGroup[];
  byUser: AiCodeGroup[];
};

type AiCodeSubmission = {
  id: number;
  tenant_id: number;
  tenant_name?: string | null;
  tenant_code?: string | null;
  user_id: number;
  username?: string | null;
  repo_relative_path: string;
  source_branch: string;
  target_branch: string;
  commit_sha: string;
  mr_id?: string | null;
  mr_iid?: string | null;
  ticket_no: string;
  additions: number;
  deletions: number;
  files_changed: number;
  status: string;
  mr_state?: string | null;
  merged_at?: string | null;
  created_at?: string | null;
  last_error?: string | null;
};

type AiCodeStatsPayload = {
  stats?: AiCodeStats;
  error?: string;
  message?: string;
};

type AiCodeMrsPayload = {
  submissions?: AiCodeSubmission[];
  error?: string;
  message?: string;
};

type AiCodeStatsTabProps = {
  tenants: AdminTenant[];
  users: AdminUser[];
};

const numberFormatter = new Intl.NumberFormat();
const STATUS_OPTIONS = ['', 'pending', 'merged', 'closed', 'expired', 'mr_failed'];

function formatNumber(value: number | null | undefined): string {
  return numberFormatter.format(Number(value || 0));
}

function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function readErrorPayload(response: Response, fallback: string): Promise<string> {
  return response.json()
    .catch(() => ({} as AiCodeStatsPayload))
    .then((payload: AiCodeStatsPayload) => payload.error || payload.message || fallback);
}

function metricClassName(): string {
  return 'rounded-md border border-border bg-background px-3 py-3';
}

export default function AiCodeStatsTab({ tenants, users }: AiCodeStatsTabProps) {
  const { t } = useTranslation('admin');
  const [tenantId, setTenantId] = useState('');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [stats, setStats] = useState<AiCodeStats | null>(null);
  const [submissions, setSubmissions] = useState<AiCodeSubmission[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const filters = useMemo(() => ({
    tenantId: tenantId || undefined,
    userId: userId || undefined,
    status: status || undefined,
    from: from || undefined,
    to: to || undefined,
  }), [from, status, tenantId, to, userId]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [statsResponse, mrsResponse] = await Promise.all([
        api.admin.aiCodeStats(filters),
        api.admin.aiCodeMrs({ ...filters, limit: 100 }),
      ]);
      if (!statsResponse.ok) {
        setError(await readErrorPayload(statsResponse, t('aiCode.errors.load', { defaultValue: 'Failed to load AI code statistics' })));
        return;
      }
      if (!mrsResponse.ok) {
        setError(await readErrorPayload(mrsResponse, t('aiCode.errors.loadMrs', { defaultValue: 'Failed to load AI code merge requests' })));
        return;
      }
      const statsPayload = await statsResponse.json() as AiCodeStatsPayload;
      const mrsPayload = await mrsResponse.json() as AiCodeMrsPayload;
      setStats(statsPayload.stats || null);
      setSubmissions(mrsPayload.submissions || []);
    } catch (caughtError) {
      console.error('[AiCodeStatsTab] Failed to load AI code stats:', caughtError);
      setError(t('aiCode.errors.load', { defaultValue: 'Failed to load AI code statistics' }));
    } finally {
      setIsLoading(false);
    }
  }, [filters, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredSubmissions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return submissions;
    return submissions.filter((submission) => (
      [
        submission.ticket_no,
        submission.repo_relative_path,
        submission.username,
        submission.tenant_name,
        submission.source_branch,
        submission.target_branch,
        submission.mr_iid,
        submission.commit_sha,
      ].filter(Boolean).join(' ').toLowerCase().includes(query)
    ));
  }, [search, submissions]);

  const summary = stats?.summary;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t('aiCode.title', { defaultValue: 'AI code statistics' })}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('aiCode.description', { defaultValue: 'Counts AI-submitted lines only after the related merge request is merged.' })}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {t('common.refresh')}
        </Button>
      </div>

      <section className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px_150px_150px_auto]">
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
          value={tenantId}
          onChange={(event) => setTenantId(event.target.value)}
        >
          <option value="">{t('aiCode.filters.allTenants', { defaultValue: 'All tenants' })}</option>
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
        >
          <option value="">{t('aiCode.filters.allUsers', { defaultValue: 'All users' })}</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>{user.username}</option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option || 'all'} value={option}>
              {option ? t(`aiCode.status.${option}`, { defaultValue: option }) : t('aiCode.filters.allStatuses', { defaultValue: 'All statuses' })}
            </option>
          ))}
        </select>
        <input
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <input
          className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
        <Button variant="secondary" onClick={() => void load()} disabled={isLoading}>
          {t('aiCode.filters.apply', { defaultValue: 'Apply' })}
        </Button>
      </section>

      {summary ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className={metricClassName()}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{t('aiCode.metrics.mergedMrs', { defaultValue: 'Merged MRs' })}</span>
              <GitMerge className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(summary.mergedMrCount)}</div>
          </div>
          <div className={metricClassName()}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{t('aiCode.metrics.changedLines', { defaultValue: 'Changed lines' })}</span>
              <LineChart className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(summary.changedLines)}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              +{formatNumber(summary.additions)} / -{formatNumber(summary.deletions)}
            </div>
          </div>
          <div className={metricClassName()}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{t('aiCode.metrics.filesChanged', { defaultValue: 'Changed files' })}</span>
              <FileCode2 className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(summary.filesChanged)}</div>
          </div>
          <div className={metricClassName()}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{t('aiCode.metrics.binaryFiles', { defaultValue: 'Binary files' })}</span>
              <FileCode2 className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-2 text-2xl font-semibold text-foreground">{formatNumber(summary.binaryFilesChanged)}</div>
          </div>
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">{t('aiCode.byTenant', { defaultValue: 'By tenant' })}</h3>
          <div className="max-h-64 overflow-auto rounded-md border border-border">
            {(stats?.byTenant || []).map((row) => (
              <div key={row.tenant_id} className="grid gap-2 border-b border-border px-3 py-3 text-sm last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{row.tenant_name || row.tenant_code || row.tenant_id}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('aiCode.groupFootnote', {
                      defaultValue: '{{mrs}} MRs / {{lines}} lines / {{files}} files',
                      mrs: row.merged_mr_count,
                      lines: Number(row.additions || 0) + Number(row.deletions || 0),
                      files: row.files_changed,
                    })}
                  </div>
                </div>
                <div className="text-right text-sm font-medium text-foreground">{formatNumber(row.merged_mr_count)}</div>
              </div>
            ))}
            {(stats?.byTenant || []).length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('aiCode.empty', { defaultValue: 'No merged AI code records' })}</div>
            ) : null}
          </div>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">{t('aiCode.byUser', { defaultValue: 'By user' })}</h3>
          <div className="max-h-64 overflow-auto rounded-md border border-border">
            {(stats?.byUser || []).map((row) => (
              <div key={`${row.tenant_id}:${row.user_id}`} className="grid gap-2 border-b border-border px-3 py-3 text-sm last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{row.username || row.user_id}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.tenant_name || row.tenant_code || '-'} · {t('aiCode.groupFootnote', {
                      defaultValue: '{{mrs}} MRs / {{lines}} lines / {{files}} files',
                      mrs: row.merged_mr_count,
                      lines: Number(row.additions || 0) + Number(row.deletions || 0),
                      files: row.files_changed,
                    })}
                  </div>
                </div>
                <div className="text-right text-sm font-medium text-foreground">{formatNumber(row.merged_mr_count)}</div>
              </div>
            ))}
            {(stats?.byUser || []).length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('aiCode.empty', { defaultValue: 'No merged AI code records' })}</div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-foreground">{t('aiCode.mrRecords', { defaultValue: 'MR records' })}</h3>
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground shadow-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('aiCode.searchPlaceholder', { defaultValue: 'Search ticket, branch, user, repo' })}
            />
          </div>
        </div>
        <div className="overflow-auto rounded-md border border-border">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('aiCode.table.ticket', { defaultValue: 'Ticket' })}</th>
                <th className="px-3 py-2 font-medium">{t('fields.tenant')}</th>
                <th className="px-3 py-2 font-medium">{t('fields.user')}</th>
                <th className="px-3 py-2 font-medium">{t('aiCode.table.repo', { defaultValue: 'Repo' })}</th>
                <th className="px-3 py-2 font-medium">{t('aiCode.table.branch', { defaultValue: 'Branch' })}</th>
                <th className="px-3 py-2 font-medium">{t('aiCode.table.mr', { defaultValue: 'MR' })}</th>
                <th className="px-3 py-2 font-medium">{t('fields.status')}</th>
                <th className="px-3 py-2 font-medium">{t('aiCode.table.lines', { defaultValue: 'Lines' })}</th>
                <th className="px-3 py-2 font-medium">{t('aiCode.table.mergedAt', { defaultValue: 'Merged at' })}</th>
              </tr>
            </thead>
            <tbody>
              {filteredSubmissions.map((submission) => (
                <tr key={submission.id} className="border-t border-border">
                  <td className="px-3 py-3 font-medium text-foreground">{submission.ticket_no}</td>
                  <td className="px-3 py-3">{submission.tenant_name || submission.tenant_code || submission.tenant_id}</td>
                  <td className="px-3 py-3">{submission.username || submission.user_id}</td>
                  <td className="max-w-[220px] truncate px-3 py-3" title={submission.repo_relative_path}>{submission.repo_relative_path}</td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{submission.source_branch} {'->'} {submission.target_branch}</td>
                  <td className="px-3 py-3">{submission.mr_iid ? `!${submission.mr_iid}` : '-'}</td>
                  <td className="px-3 py-3">
                    <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t(`aiCode.status.${submission.status}`, { defaultValue: submission.status })}
                    </span>
                  </td>
                  <td className="px-3 py-3">{formatNumber(Number(submission.additions || 0) + Number(submission.deletions || 0))}</td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{formatDateTime(submission.merged_at || submission.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredSubmissions.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              {isLoading ? t('aiCode.loading', { defaultValue: 'Loading AI code statistics...' }) : t('aiCode.noMrs', { defaultValue: 'No MR records' })}
            </div>
          ) : null}
        </div>
      </section>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
