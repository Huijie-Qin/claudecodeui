import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';

import type { SqlCheckSelection } from '../../../shared/sqlCheck';
import { Button, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';
import { normalizeSqlCheckRules, type SqlCheckRule } from '../sql-check/sqlCheckRules';

export default function AgentTemplateSqlCheckSettings({ value, tenantRuleIds, disabled, onChange }: {
  value: SqlCheckSelection | null;
  tenantRuleIds: string[];
  disabled: boolean;
  onChange: (value: SqlCheckSelection) => void;
}) {
  const [rules, setRules] = useState<SqlCheckRule[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api.sqlCheck.rules({ signal: controller.signal }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '加载 SQL Check 目录失败');
      if (!controller.signal.aborted) setRules(normalizeSqlCheckRules(payload));
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '加载 SQL Check 目录失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  const customEnabled = value?.customEnabled === true;
  const selectedIds = customEnabled ? value.ruleIds : tenantRuleIds;
  const visibleRules = useMemo(() => rules.filter((rule) => rule.name.toLowerCase().includes(query.trim().toLowerCase())), [rules, query]);
  const rulesById = new Map(rules.map((rule) => [rule.rule_id, rule]));
  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label="SQL Check 目录">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">SQL Check 目录</h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">与项目右上角 SQL Check 使用同一份规则目录。新项目继承此配置，用户之后仍可自行修改。</p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => setRefresh((current) => current + 1)} aria-label="刷新 SQL Check 目录"><RefreshCw className="h-4 w-4" />刷新</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={customEnabled} disabled={disabled} onChange={(event) => onChange({ customEnabled: event.target.checked, ruleIds: value?.ruleIds ?? tenantRuleIds })} className="h-4 w-4 rounded border-input accent-primary" />
          自定义 SQL Check 目录
        </label>
        <span className="text-xs text-muted-foreground">{customEnabled ? `已选 ${selectedIds.length} 条` : '跟随新项目所属租户的规则'}</span>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange({ customEnabled: true, ruleIds: [...tenantRuleIds] })}>恢复租户默认</Button>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}，已选配置仍会保留。</p> : null}
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input type="search" className="pl-9" placeholder="按规则名称搜索..." aria-label="搜索 SQL Check 目录" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {loading ? <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在加载 SQL Check 目录…</p> : visibleRules.length === 0 ? <p className="p-3 text-sm text-muted-foreground">{rules.length ? '没有匹配的规则。' : '暂无可用 SQL Check 规则。'}</p> : visibleRules.map((rule) => (
          <label key={rule.rule_id} className="flex items-start gap-3 rounded-md border border-border p-3">
            <input type="checkbox" checked={selectedIds.includes(rule.rule_id)} disabled={disabled || !customEnabled} onChange={(event) => onChange({ customEnabled: true, ruleIds: event.target.checked ? [...new Set([...selectedIds, rule.rule_id])] : selectedIds.filter((id) => id !== rule.rule_id) })} className="mt-0.5 h-4 w-4 rounded border-input accent-primary" />
            <span className="min-w-0"><span className="block text-sm font-medium text-foreground">{rule.name}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{rule.desc}</span></span>
          </label>
        ))}
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs font-medium text-muted-foreground">当前选择</p>
        <div className="flex flex-wrap gap-2">
          {selectedIds.length ? selectedIds.map((id) => <span key={id} className="rounded-md bg-muted px-2 py-1 text-xs text-foreground">{rulesById.get(id)?.name || id}</span>) : <span className="text-xs text-muted-foreground">未选择规则。</span>}
        </div>
      </div>
    </section>
  );
}
