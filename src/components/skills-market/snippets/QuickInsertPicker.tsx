import { useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';

import { filterInsertionItems, mcpInsertionItems, mySkillInsertionItems, type NameInsertionItem } from './insertionCatalog';
import SnippetLibrary from './SnippetLibrary';

const tabs = [{ id: 'snippets', label: '片段' }, { id: 'skills', label: '我的技能' }, { id: 'mcp', label: 'MCP 工具' }] as const;
type InsertTab = typeof tabs[number]['id'];
const button = 'rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';

export default function QuickInsertPicker({ workspaceId, skillName, onInsert, onCancel }: {
  workspaceId?: number;
  skillName: string;
  onInsert: (text: string) => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<InsertTab>('snippets');
  return <div className="flex min-h-0 flex-1 flex-col">
    <div role="tablist" aria-label="插入类型" className="flex shrink-0 gap-2 border-b border-border px-4 py-2">
      {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
        id={`quick-insert-${item.id}-tab`} aria-controls={`quick-insert-${item.id}-panel`}
        className={`rounded-md px-4 py-2 text-sm ${tab === item.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent'}`}
        onClick={() => setTab(item.id)}>
        {item.label}
      </button>)}
    </div>
    {tabs.filter((item) => item.id === tab).map((item) => <div key={item.id} role="tabpanel"
      id={`quick-insert-${item.id}-panel`} aria-labelledby={`quick-insert-${item.id}-tab`}
      className="flex min-h-0 flex-1 flex-col">
      {item.id === 'snippets' ? <SnippetLibrary onInsert={(snippet) => onInsert(snippet.markdown)} onCancel={onCancel} />
        : <NameInsertionPanel key={`${workspaceId}:${skillName}:${item.id}`} kind={item.id} workspaceId={workspaceId} skillName={skillName} onInsert={onInsert} onCancel={onCancel} />}
    </div>)}
  </div>;
}

function NameInsertionPanel({ kind, workspaceId, skillName, onInsert, onCancel }: {
  kind: 'skills' | 'mcp'; workspaceId?: number; skillName: string;
  onInsert: (text: string) => void; onCancel: () => void;
}) {
  const [items, setItems] = useState<NameInsertionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const visible = filterInsertionItems(items, query);
  const selected = visible.find((item) => item.name === selectedName);
  const label = kind === 'skills' ? '我的技能' : 'MCP 工具';

  useEffect(() => {
    let active = true;
    setItems([]); setSelectedName(null); setLoading(true); setError('');
    const load = async () => {
      try {
        if (!workspaceId) throw new Error('当前工作区不可用。');
        const response = await (kind === 'skills' ? api.workspaceSkills.list(workspaceId) : api.workspaceMcpTools.insertionCatalog(workspaceId));
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `加载${label}失败，请重试。`);
        const entries = kind === 'skills' ? payload.skills : payload.tools;
        if (!Array.isArray(entries)) throw new Error(`加载${label}失败，请重试。`);
        if (active) setItems(kind === 'skills' ? mySkillInsertionItems(entries, skillName) : mcpInsertionItems(entries));
      } catch (e) { if (active) setError(e instanceof Error ? e.message : `加载${label}失败，请重试。`); }
      finally { if (active) setLoading(false); }
    };
    void load();
    return () => { active = false; };
  }, [workspaceId, skillName, kind, label, reload]);

  const search = (value: string) => {
    setQuery(value);
    if (!filterInsertionItems(items, value).some((item) => item.name === selectedName)) setSelectedName(null);
  };
  return <>
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input ref={searchRef} aria-label={`搜索${label}`} placeholder={`搜索${label}名称或描述…`} value={query} onChange={(event) => search(event.target.value)}
            className="w-full rounded-md border border-border bg-background py-2 pl-3 pr-10 text-sm" />
          {query && <button type="button" aria-label={`清空${label}搜索`} className="absolute inset-y-0 right-0 w-10 text-muted-foreground" onClick={() => { search(''); searchRef.current?.focus(); }}>×</button>}
        </div>
        <button type="button" className={button} disabled={loading} onClick={() => setReload((value) => value + 1)}>刷新列表</button>
      </div>
      <p className="text-xs text-muted-foreground">{kind === 'skills' ? '当前工作区的其他本地技能，确认后插入技能名称。' : '当前工作区已安装且已启用的工具，确认后插入完整工具名称。'}</p>
      {loading ? <p role="status" className="text-sm text-muted-foreground">正在加载{label}…</p> : error ? <div role="alert" className="text-sm text-destructive">{error} <button type="button" className={button} onClick={() => setReload((value) => value + 1)}>重试</button></div> : <>
        <p className="text-xs text-muted-foreground">共 {visible.length} 项</p>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
          {visible.length ? visible.map((item) => <button key={item.name} type="button" aria-pressed={selectedName === item.name}
            className={`block w-full border-b border-border p-3 text-left last:border-0 hover:bg-accent ${selectedName === item.name ? 'bg-accent' : ''}`}
            onClick={() => setSelectedName(item.name)}>
            <span className="block break-words text-sm font-medium">{item.label}</span>
            {item.label !== item.name && <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">{item.name}</span>}
            {item.source && <span className="mt-1 block text-xs text-muted-foreground">{item.source}</span>}
            {item.description && <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{item.description}</span>}
          </button>) : <p className="p-4 text-sm text-muted-foreground">{query ? '没有匹配的结果，请调整或清空搜索。' : kind === 'skills' ? '当前工作区暂无其他本地技能。' : '暂无已安装且已启用的 MCP 工具。'}</p>}
        </div>
      </>}
    </div>
    <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
      <button type="button" className={button} onClick={onCancel}>取消</button>
      <button type="button" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={loading || Boolean(error) || !selected} onClick={() => { if (selected) onInsert(selected.name); }}>确认</button>
    </footer>
  </>;
}
