import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Loader2, Upload, X } from 'lucide-react';

export default function TestFilesUpload({ files, busy, progress, onUpload, onRemove, onError }: {
  files: string[]; busy: boolean; progress: { current: number; total: number } | null;
  onUpload: (files: File[]) => void; onRemove: (path: string) => void; onError: (message: string) => void;
}) {
  const { t } = useTranslation('common');
  const tr = (key: string, values = {}) => t(`skillEvaluation.${key}`, values);
  const helpId = useId(), inputId = useId();
  const [dragActive, setDragActive] = useState(false);
  const depth = useRef(0);
  const select = (selected: FileList | null) => {
    if (busy || !selected?.length) return;
    const incoming = Array.from(selected);
    if (files.length + incoming.length > 20) { onError(tr('testFiles.tooMany')); return; }
    const oversized = incoming.find((file) => file.size > 5 * 1024 * 1024);
    if (oversized) { onError(tr('testFiles.tooLarge', { name: oversized.name })); return; }
    onUpload(incoming);
  };
  return <section className="space-y-3">
    <div><label htmlFor={inputId} className="text-sm font-medium">{tr('inputs')}</label>
      <p id={helpId} className="mt-1 text-xs leading-5 text-muted-foreground">{tr('testFiles.help')}</p></div>
    <label className={`flex min-h-36 flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition focus-within:ring-2 focus-within:ring-ring ${busy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${dragActive ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-muted/20 hover:bg-muted/40'}`}
      onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) { depth.current++; setDragActive(true); } }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }}
      onDragLeave={(event) => { event.preventDefault(); event.stopPropagation(); depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragActive(false); }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); depth.current = 0; setDragActive(false); select(event.dataTransfer.files); }} aria-disabled={busy}>
      {progress ? <Loader2 className="mb-2 h-7 w-7 animate-spin text-primary" /> : <Upload className={`mb-2 h-7 w-7 ${dragActive ? 'text-primary' : 'text-muted-foreground'}`} />}
      <span className="text-sm font-medium" role={progress ? 'status' : undefined}>{progress ? tr('testFiles.uploading', progress) : tr(dragActive ? 'testFiles.drop' : 'testFiles.select')}</span>
      <span className="mt-1 text-xs leading-5 text-muted-foreground">{tr('testFiles.limits')}</span>
      <input id={inputId} aria-describedby={helpId} type="file" multiple className="sr-only" disabled={busy}
        onChange={(event) => { select(event.target.files); event.target.value = ''; }} />
    </label>
    <p className="text-xs leading-5 text-muted-foreground">{tr('testFiles.formats')}</p>
    {files.length > 0 && <div className="space-y-2"><p className="text-xs text-muted-foreground">{tr('testFiles.count', { count: files.length })}</p>
      {files.map((file) => <div key={file} className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate" title={file}>{file.split('/').pop()}</span>
        <button type="button" disabled={busy} aria-label={`${tr('remove')} ${file.split('/').pop()}`} onClick={() => onRemove(file)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"><X className="h-4 w-4" /></button>
      </div>)}
    </div>}
  </section>;
}
