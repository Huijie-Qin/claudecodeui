import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { isolateHistory } from '@codemirror/commands';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';

import { useTheme } from '../../../contexts/ThemeContext';
import { Dialog, DialogContent, DialogTitle } from '../../../shared/view/ui/Dialog';

import { snippetInsertion } from './insertion';
import QuickInsertPicker from './QuickInsertPicker';

export default function SnippetFileEditor({ content, filePath, workspaceId, skillName, onChange }: { content: string; filePath: string; workspaceId?: number; skillName: string; onChange: (value: string) => void }) {
  const { isDarkMode } = useTheme();
  const editor = useRef<ReactCodeMirrorRef>(null);
  const [target, setTarget] = useState<{ path: string; content: string; from: number; to: number } | null>(null);
  const [error, setError] = useState('');
  const close = () => {
    setTarget(null);
    requestAnimationFrame(() => editor.current?.view?.focus());
  };
  const insert = (text: string) => {
    const view = editor.current?.view;
    if (!target || !view || target.path !== filePath || target.content !== content || view.state.doc.toString() !== target.content) {
      setError('编辑文件或内容已改变，请关闭弹框并重新选择插入位置。');
      return;
    }
    try {
      const change = snippetInsertion(target.content, target.from, target.to, text);
      view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert }, selection: { anchor: change.anchor },
        annotations: isolateHistory.of('full'), scrollIntoView: true });
      close();
    } catch (e) { setError(e instanceof Error ? e.message : '插入失败。'); }
  };
  return <div className="flex h-full min-h-0 flex-col">
    {filePath.toLowerCase().endsWith('.md') && <div className="flex items-center gap-3 border-b border-border px-4 py-2">
      <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent" onClick={() => {
        const view = editor.current?.view;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        setError(''); setTarget({ path: filePath, content: view.state.doc.toString(), from, to });
      }}>快速插入</button><span className="text-xs text-muted-foreground">插入片段、技能或工具名称，保存文件后生效</span>
    </div>}
    <div className="min-h-0 flex-1"><CodeMirror ref={editor} value={content} onChange={onChange} theme={isDarkMode ? oneDark : 'light'} height="100%" style={{ height: '100%', fontSize: '13px' }} basicSetup={{ lineNumbers: true, foldGutter: true, bracketMatching: true, closeBrackets: true }} /></div>
    <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open) close(); }}><DialogContent aria-label="快速插入" className="flex h-[80vh] max-h-[90vh] max-w-5xl flex-col">
      <DialogTitle>快速插入</DialogTitle>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="font-semibold">快速插入</h2>
        <button type="button" aria-label="关闭快速插入" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={close}><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      {error && <p role="alert" className="px-4 pt-3 text-sm text-destructive">{error}</p>}
      {target && <QuickInsertPicker workspaceId={workspaceId} skillName={skillName} onInsert={insert} onCancel={close} />}
    </DialogContent></Dialog>
  </div>;
}
