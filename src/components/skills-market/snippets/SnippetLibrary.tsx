import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Dialog, DialogContent, DialogTitle } from '../../../shared/view/ui/Dialog';

import { filterSnippets, snippetApi, type Snippet, type SnippetDraft } from './api';

const button = 'rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
const input = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';
const emptyDraft = { title: '', description: '', markdown: '' };

export function SnippetPreview({ markdown }: { markdown: string }) {
  return <div className="prose prose-sm max-w-none break-words dark:prose-invert">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>,
      a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    }}>{markdown}</ReactMarkdown>
  </div>;
}

export default function SnippetLibrary({ onInsert, onCancel, refreshKey = 0 }: { onInsert?: (snippet: Snippet) => void; onCancel?: () => void; refreshKey?: number }) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState<{ original: Snippet | null; draft: SnippetDraft } | null>(null);
  const [deleting, setDeleting] = useState<Snippet | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const visible = filterSnippets(snippets, query);
  const selected = visible.find((snippet) => snippet.id === selectedId);
  const manage = canManage && !onInsert;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    snippetApi.list().then((data) => {
      if (!active) return;
      setSnippets(data.snippets);
      setCanManage(data.canManage);
      setSelectedId((id) => data.snippets.some((snippet) => snippet.id === id) ? id : null);
    }).catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload, refreshKey]);

  const search = (value: string) => {
    setQuery(value);
    if (!filterSnippets(snippets, value).some((snippet) => snippet.id === selectedId)) setSelectedId(null);
  };
  const closeForm = () => {
    if (busy || (form && JSON.stringify(form.draft) !== JSON.stringify(form.original ? {
      title: form.original.title, description: form.original.description, markdown: form.original.markdown,
    } : emptyDraft) && !window.confirm('放弃未保存的片段修改吗？'))) return;
    setForm(null);
  };
  const save = async () => {
    if (!form || busy) return;
    setBusy(true); setMutationError('');
    try {
      const { snippet } = await (form.original ? snippetApi.update(form.original, form.draft) : snippetApi.create(form.draft));
      setSnippets((items) => [snippet, ...items.filter((item) => item.id !== snippet.id)]);
      setQuery(''); setSelectedId(snippet.id); setForm(null); setNotice('片段已保存。');
    } catch (e) { setMutationError(e instanceof Error ? e.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true); setMutationError('');
    try {
      await snippetApi.remove(deleting);
      setSnippets((items) => items.filter((item) => item.id !== deleting.id));
      setSelectedId(null); setDeleting(null); setNotice('片段已删除，不影响已插入的技能。');
    } catch (e) { setMutationError(e instanceof Error ? e.message : '删除失败，请重试。'); }
    finally { setBusy(false); }
  };

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-semibold">{onInsert ? '选择公共片段' : '片段管理'}</h2><p className="mt-1 text-xs text-muted-foreground">全平台共享固定正文 · {onInsert ? '插入后可继续编辑，保存文件才生效。' : '所有用户可查看和使用，平台管理员维护。'}</p></div>
      <div className="flex gap-2">
        <button type="button" className={button} disabled={loading} onClick={() => setReload((value) => value + 1)}>刷新片段</button>
        {manage && <button type="button" className={button} onClick={() => { setMutationError(''); setForm({ original: null, draft: { ...emptyDraft } }); }}>新增片段</button>}
      </div>
    </div>
    <div className="relative"><input ref={searchRef} aria-label="搜索公共片段" placeholder="搜索片段名称、用途或正文…" value={query} onChange={(event) => search(event.target.value)} className={`${input} pr-10`} />
      {query && <button type="button" aria-label="清空片段搜索" className="absolute inset-y-0 right-0 w-10 text-muted-foreground" onClick={() => { search(''); searchRef.current?.focus(); }}>×</button>}
    </div>
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {loading ? <p role="status">正在加载片段…</p> : error ? <div role="alert">{error} <button type="button" className={button} onClick={() => setReload((value) => value + 1)}>重试</button></div> : <>
      <p className="text-xs text-muted-foreground">共 {visible.length} 个片段</p>
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(180px,1fr)_minmax(0,2fr)]">
        <div className="overflow-auto rounded-lg border border-border">
          {visible.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{query ? '没有匹配的片段，请调整或清空搜索。' : '暂无公共片段。'}</p> : visible.map((snippet) => <button type="button" key={snippet.id} aria-pressed={selectedId === snippet.id} className={`block w-full border-b border-border p-3 text-left last:border-0 hover:bg-accent ${selectedId === snippet.id ? 'bg-accent' : ''}`} onClick={() => setSelectedId(snippet.id)}>
            <span className="block break-words text-sm font-medium">{snippet.title}</span><span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{snippet.description}</span>
          </button>)}
        </div>
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border">
          {selected ? <>{!onInsert && <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border bg-muted/60 px-5 py-4"><div className="min-w-0 flex-1"><h3 className="break-words font-semibold">{selected.title}</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{selected.description}</p></div>
            <div className="flex shrink-0 gap-2">{manage ? <>
              <button type="button" className={button} onClick={() => { setMutationError(''); setForm({ original: selected, draft: { title: selected.title, description: selected.description, markdown: selected.markdown } }); }}>编辑</button>
              <button type="button" className={`${button} text-destructive`} onClick={() => { setMutationError(''); setDeleting(selected); }}>删除</button>
            </> : null}</div></header>}
            <div className={`min-h-0 flex-1 overflow-auto ${onInsert ? 'p-4' : 'px-5 py-5'}`}>
              {!onInsert && <p className="mb-4 text-xs font-medium text-muted-foreground">片段正文</p>}
              <SnippetPreview markdown={selected.markdown} />
            </div>
          </> : <p className="p-4 text-sm text-muted-foreground">选择片段查看完整正文。</p>}
        </div>
      </div>
    </>}
    </div>
    {onInsert && <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
      <button type="button" className={button} onClick={onCancel}>取消</button>
      <button type="button" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50" disabled={loading || Boolean(error) || !selected} onClick={() => { if (selected) onInsert(selected); }}>确认</button>
    </footer>}
    <Dialog open={Boolean(form)} onOpenChange={(open) => { if (!open) closeForm(); }}><DialogContent aria-label={form?.original ? '编辑片段' : '新增片段'} className="max-h-[90vh] max-w-3xl overflow-auto p-5"><DialogTitle>维护公共片段</DialogTitle>
      {form && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <h3 className="font-semibold">{form.original ? '编辑片段' : '新增片段'}</h3><p className="text-sm text-muted-foreground">内容对所有租户可见，请勿填写私有业务数据或生产凭据。</p>
        <label className="block text-sm">片段名称<input required className={`${input} mt-1`} value={form.draft.title} onChange={(e) => setForm({ ...form, draft: { ...form.draft, title: e.target.value } })} disabled={busy} /></label>
        <label className="block text-sm">用途说明<textarea required rows={2} className={`${input} mt-1`} value={form.draft.description} onChange={(e) => setForm({ ...form, draft: { ...form.draft, description: e.target.value } })} disabled={busy} /></label>
        <label className="block text-sm">Markdown 正文<textarea required rows={10} className={`${input} mt-1 font-mono`} value={form.draft.markdown} onChange={(e) => setForm({ ...form, draft: { ...form.draft, markdown: e.target.value } })} disabled={busy} /></label>
        <details><summary className="cursor-pointer text-sm">预览正文</summary><div className="mt-3"><SnippetPreview markdown={form.draft.markdown} /></div></details>
        {mutationError && <p role="alert" className="text-sm text-destructive">{mutationError}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={closeForm}>取消</button><button type="submit" className={button} disabled={busy || Object.values(form.draft).some((value) => !value.trim())}>{busy ? '正在保存…' : '保存片段'}</button></div>
      </form>}
    </DialogContent></Dialog>
    <Dialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}><DialogContent aria-label="删除片段" className="space-y-4 p-5"><DialogTitle>删除片段</DialogTitle>
      <h3 className="font-semibold">删除「{deleting?.title}」？</h3><p className="text-sm text-muted-foreground">删除后无法再从公共库插入此片段，不影响已插入的技能。</p>
      {mutationError && <p role="alert" className="text-sm text-destructive">{mutationError}</p>}
      <div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={() => setDeleting(null)}>取消</button><button type="button" className={`${button} text-destructive`} disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</button></div>
    </DialogContent></Dialog>
  </div>;
}
