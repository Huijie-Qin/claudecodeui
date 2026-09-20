// Explicitly synthetic. Displayed only when the isolated preview server identifies itself.
// This is NOT CodeHub ingestion, AI attribution, or a production report fallback.
export type DemoCodeFact = {
  id: string; date: string; userId: number | string; workspaceId: number | string;
  userName: string; workspaceName: string; repository: string;
  generatedLines: number; submittedLines: number; commitCount: number; commitSha: string;
};
export type CodeGroup = 'user' | 'workspace' | 'day' | 'week' | 'month';
export type DemoCodeFilters = { from: string; to: string; userName: string; workspaceName: string; repository?: string };
export const demoCodeFacts: DemoCodeFact[] = Array.from({ length: 30 }, (_, day) => {
  const date = new Date(Date.UTC(2026, 7, 14 + day)).toISOString().slice(0, 10);
  return Array.from({ length: 40 }, (_, user) => {
    const submittedLines = Math.round((60 + ((user * 37 + day * 53) % 300)) * (.35 + user % 5 * .13));
    return {
      id: `demo-code-${day}-${user}`, date, userId: 100 + user, workspaceId: 7 + user % 5, userName: `模拟用户 ${String(user + 1).padStart(2, '0')}`,
      workspaceName: `模拟工作区 ${user % 5 + 1}`, repository: ['ccui-web', 'data-service', 'business-api'][user % 3],
      // Generated SQL is loaded from published Hook records, never fabricated here.
      generatedLines: 0, submittedLines, commitCount: submittedLines > 0 ? 1 : 0,
      commitSha: `demo-${day.toString(16).padStart(2, '0')}${user.toString(16).padStart(2, '0')}`,
    };
  });
}).flat();
export function filterDemoCode(filters: DemoCodeFilters, facts = demoCodeFacts) {
  const contains = (value: string, query = '') => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  return facts.filter(r => r.date >= filters.from && r.date <= filters.to && contains(r.userName, filters.userName)
    && contains(r.workspaceName, filters.workspaceName) && contains(r.repository, filters.repository));
}
export function codeGroupKey(row: DemoCodeFact, group: CodeGroup) {
  if (group === 'user') return String(row.userId);
  if (group === 'workspace') return String(row.workspaceId);
  if (group === 'month') return row.date.slice(0, 7);
  if (group === 'week') { const date = new Date(`${row.date}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); return date.toISOString().slice(0, 10); }
  return row.date;
}
export function summarizeDemoCode(rows: DemoCodeFact[]) {
  const generatedLines = rows.reduce((n, r) => n + r.generatedLines, 0);
  const submittedLines = rows.reduce((n, r) => n + r.submittedLines, 0);
  return { generatedLines, submittedLines, commitCount: rows.reduce((n, r) => n + r.commitCount, 0) };
}
export function groupDemoCode(rows: DemoCodeFact[], group: CodeGroup) {
  const groups = new Map<string, DemoCodeFact[]>();
  rows.forEach(row => { const key = codeGroupKey(row, group); groups.set(key, [...(groups.get(key) || []), row]); });
  return [...groups].map(([groupKey, facts]) => ({ groupKey,
    groupLabel: group === 'user' ? facts[0].userName : group === 'workspace' ? facts[0].workspaceName : groupKey,
    workspaceName: group === 'user' ? [...new Set(facts.map(row => row.workspaceName))].join('、') : null, ...summarizeDemoCode(facts) }));
}
