import { Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

export type RemovalDialogTarget = {
  description: string;
  path: string;
  requiresYes?: boolean;
  title: string;
};

export default function RemovalConfirmDialog({
  busy,
  onCancel,
  onConfirm,
  target,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  target: RemovalDialogTarget;
}) {
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => setConfirmation(''), [target]);
  const confirmationValid = !target.requiresYes || confirmation === 'yes';

  return (
    <div
      className="fixed inset-0 z-[10010] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-removal-title"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-destructive/10 p-2 text-destructive">
            <Trash2 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="skill-removal-title" className="text-base font-semibold text-foreground">{target.title}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{target.description}</p>
            <div className="mt-3 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
              {target.path}
            </div>
            {target.requiresYes ? (
              <label className="mt-3 block text-sm font-medium text-foreground">
                输入 <span className="font-mono">yes</span> 确认移除
                <input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={busy}
                  autoFocus
                  className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:opacity-50"
                />
              </label>
            ) : null}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || !confirmationValid}
            className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            移除
          </button>
        </div>
      </div>
    </div>
  );
}
